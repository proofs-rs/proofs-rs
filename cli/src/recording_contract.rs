//! Offline input-shape guard generated from the server's recording schema.
//! Cross-field and authorization semantics remain the server's responsibility.
use anyhow::{bail, ensure, Result};
use serde_json::Value;
use std::{fs, path::Path, sync::OnceLock};

const SCHEMA: &str = include_str!("../protocol/recording-v2.schema.json");
const CONTRACT_ERROR: &str = "The extracted recording does not satisfy the bundled server recording contract (recording-v2). Server-side changes are required to support this output; coordinate the CLI/server contract update. No publishable run was saved.";
static VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> = OnceLock::new();

fn validate(sarif: &Value, bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.len() <= 8 * 1024 * 1024,
        "SARIF including logs exceeds 8 MiB; no publishable run was saved"
    );
    let validator = VALIDATOR.get_or_init(|| {
        let schema: Value =
            serde_json::from_str(SCHEMA).map_err(|_| "Invalid bundled JSON schema".to_owned())?;
        jsonschema::options()
            .should_validate_formats(true)
            .build(&schema)
            .map_err(|_| "Cannot compile bundled JSON schema".to_owned())
    });
    let validator = validator
        .as_ref()
        .map_err(|reason| anyhow::anyhow!("{CONTRACT_ERROR} {reason}"))?;
    if let Some(error) = validator.iter_errors(sarif).next() {
        // Never render ValidationError: it includes rejected values and proof text.
        let bounded = |value: &str| {
            value
                .chars()
                .filter(|c| !c.is_control())
                .take(160)
                .collect::<String>()
        };
        bail!(
            "{CONTRACT_ERROR} Field: {}; schema constraint: {}",
            bounded(error.instance_path.as_str()),
            bounded(error.schema_path.as_str())
        );
    }
    Ok(())
}

pub fn save(base: &Path, rid: &str, sarif: &Value, bytes: &[u8]) -> Result<()> {
    validate(sarif, bytes)?;
    let dir = base.join("runs").join(rid);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("run.sarif.json"), bytes)?;
    crate::state::write(&base.join("latest.json"), &rid)?;
    println!("Saved run {rid}: {}", dir.display());
    Ok(())
}

pub fn diagnostic(base: &Path, rid: &str, bytes: &[u8]) -> Result<()> {
    let dir = base.join("diagnostics").join(rid);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("diagnostic.sarif.json"), bytes)?;
    println!("Saved diagnostic {rid}: {}", dir.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn invalid_record_preserves_latest_and_never_creates_a_run() {
        let base = tempfile::tempdir().unwrap();
        let latest = base.path().join("latest.json");
        fs::write(&latest, "previous valid run").unwrap();
        let invalid = json!({"version":"SECRET_PROOF_TEXT", "runs": []});
        let bytes = serde_json::to_vec(&invalid).unwrap();
        let error = save(base.path(), "rejected", &invalid, &bytes)
            .unwrap_err()
            .to_string();
        assert!(error.contains("Server-side changes are required"));
        assert!(!error.contains("SECRET_PROOF_TEXT"));
        assert_eq!(fs::read_to_string(latest).unwrap(), "previous valid run");
        assert!(!base.path().join("runs").exists());
        diagnostic(base.path(), "rejected", &bytes).unwrap();
        assert_eq!(
            fs::read(
                base.path()
                    .join("diagnostics/rejected/diagnostic.sarif.json")
            )
            .unwrap(),
            bytes
        );
    }

    #[test]
    fn missing_required_field_cannot_create_latest() {
        let base = tempfile::tempdir().unwrap();
        assert!(save(base.path(), "rejected", &json!({}), b"{}").is_err());
        assert!(!base.path().join("latest.json").exists());
        assert!(!base.path().join("runs").exists());
    }

    #[test]
    fn generated_source_patterns_preserve_server_case_insensitivity() {
        let schema: Value = serde_json::from_str(SCHEMA).unwrap();
        let defs = schema["$defs"].as_object().unwrap();
        let source = defs
            .values()
            .find(|v| {
                v["properties"]["source"]["oneOf"]
                    .as_array()
                    .is_some_and(|branches| {
                        branches
                            .iter()
                            .any(|b| b["properties"]["kind"]["const"] == "git_patch")
                    })
            })
            .unwrap();
        let fragment = json!({"$schema":"https://json-schema.org/draft/2020-12/schema", "$defs":defs, "allOf":[source["properties"]["source"]]});
        let validator = jsonschema::validator_for(&fragment).unwrap();
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../tests/fixtures/recording-pattern-cases.json"
        ))
        .unwrap();
        for case in cases {
            assert_eq!(
                validator.is_valid(&case["value"]),
                case["accept"].as_bool().unwrap()
            );
        }
    }

    #[test]
    fn size_limit_is_not_reported_as_a_server_contract_bug() {
        let bytes = vec![b' '; 8 * 1024 * 1024 + 1];
        let error = validate(&json!({}), &bytes).unwrap_err().to_string();
        assert!(error.contains("exceeds 8 MiB"));
        assert!(!error.contains("Server-side changes"));
    }
}
