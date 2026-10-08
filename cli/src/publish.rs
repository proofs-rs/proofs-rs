use crate::{
    api::Api,
    config::{Config, Project},
    record,
    state::{self, Pending, State},
    ProjectArgs,
};
use anyhow::{bail, ensure, Context, Result};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, IsTerminal, Write},
    path::Path,
};

pub struct Options {
    pub dry_run: bool,
    pub run: Option<String>,
    pub report: Option<u64>,
    pub force: bool,
    pub yes: bool,
    pub resume: bool,
}
const REPORT_FIELDS: &[&str] = &[
    "crate",
    "version",
    "title",
    "explanation",
    "trusted_assumptions",
    "tool_version_id",
    "environment",
    "evidence_url",
    "limitations",
];
const CLAIM_FIELDS: &[&str] = &[
    "id",
    "api_item_id",
    "property",
    "title",
    "precondition",
    "explanation",
    "trusted_assumptions",
    "evidence_url",
    "limitations",
];
fn text(value: &Value, key: &str) -> Value {
    Value::String(value[key].as_str().unwrap_or_default().into())
}
fn snapshot(report: &Value) -> Result<Value> {
    let mut value = json!({});
    for key in REPORT_FIELDS {
        value[*key] = text(report, key);
    }
    value["dependencies"] = Value::Array(report["dependencies"].as_array().into_iter().flatten().map(|dependency| json!({"crate":dependency["crate"],"report":dependency["report"],"revision":dependency["revision"]})).collect());
    value["run_ids"] = report.get("run_ids").cloned().unwrap_or_else(|| json!([]));
    value["claims"] = Value::Array(
        report["claims"]
            .as_array()
            .context("Report is missing claims")?
            .iter()
            .map(|c| {
                let mut claim = json!({});
                for key in CLAIM_FIELDS {
                    claim[*key] = text(c, key);
                }
                claim
            })
            .collect(),
    );
    Ok(value)
}
fn key(claim: &Value) -> Result<(String, String)> {
    Ok((
        claim["api_item_id"]
            .as_str()
            .context("Missing API ID")?
            .into(),
        claim["property"]
            .as_str()
            .context("Missing property")?
            .into(),
    ))
}
fn claims_by_key(report: &Value) -> Result<BTreeMap<(String, String), Value>> {
    let mut claims = BTreeMap::new();
    for claim in report["claims"].as_array().context("Missing claims")? {
        ensure!(claims.insert(key(claim)?, claim.clone()).is_none(), "Existing report has multiple claims for the same API/property; this CLI cannot update it");
    }
    Ok(claims)
}
fn merge(config: &Config, mut generated: Value, existing: Option<&Value>) -> Result<Value> {
    let mut body = if let Some(existing) = existing {
        snapshot(existing)?
    } else {
        json!({})
    };
    for field in ["crate", "version", "tool_version_id", "evidence_url"] {
        body[field] = generated[field].take();
    }
    body["run_ids"] = generated["run_ids"].take();
    body["title"] = json!(config.report.title.trim());
    for (field, value) in [
        ("explanation", &config.report.explanation),
        ("trusted_assumptions", &config.report.trusted_assumptions),
        ("limitations", &config.report.limitations),
        ("environment", &config.report.environment),
    ] {
        if let Some(value) = value {
            body[field] = json!(value);
        } else if body.get(field).is_none() {
            body[field] = json!("");
        }
    }
    if let Some(dependencies) = &config.dependencies {
        body["dependencies"] = json!(dependencies.iter().map(|(name, review)| json!({"crate":name,"report":review.report,"revision":review.revision})).collect::<Vec<_>>());
    } else if body.get("dependencies").is_none() {
        body["dependencies"] = json!([]);
    }
    let old = existing.map(claims_by_key).transpose()?.unwrap_or_default();
    let mut claims = vec![];
    for claim in generated["claims"]
        .as_array()
        .context("Missing generated claims")?
    {
        let mut merged = if let Some(previous) = old.get(&key(claim)?) {
            let mut m = json!({});
            for f in CLAIM_FIELDS {
                m[*f] = text(previous, f);
            }
            m
        } else {
            json!({})
        };
        for f in ["api_item_id", "property", "precondition", "evidence_url"] {
            merged[f] = claim[f].clone();
        }
        claims.push(merged);
    }
    body["claims"] = Value::Array(claims);
    Ok(body)
}
fn same_content(a: &Value, b: &Value) -> bool {
    fn canonical(mut value: Value) -> Value {
        if let Some(claims) = value["claims"].as_array_mut() {
            claims.sort_by_key(|c| (c["api_item_id"].to_string(), c["property"].to_string()));
        }
        if let Some(dependencies) = value["dependencies"].as_array_mut() {
            for dependency in dependencies.iter_mut() {
                *dependency = json!({"crate":dependency["crate"],"report":dependency["report"],"revision":dependency["revision"]});
            }
            dependencies.sort_by_key(|d| {
                (
                    d["crate"].to_string(),
                    d["report"].to_string(),
                    d["revision"].to_string(),
                )
            });
        }
        value
    }
    canonical(a.clone()) == canonical(b.clone())
}
fn diff(before: &Value, after: &Value) {
    let before_dependencies = before["dependencies"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let after_dependencies = after["dependencies"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for dependency in &before_dependencies {
        if !after_dependencies.contains(dependency) {
            eprintln!("  - dependency {dependency}");
        }
    }
    for dependency in &after_dependencies {
        if !before_dependencies.contains(dependency) {
            eprintln!("  + dependency {dependency}");
        }
    }
    if before["run_ids"] != after["run_ids"] {
        eprintln!("  run_ids: {} -> {}", before["run_ids"], after["run_ids"]);
    }
    for field in REPORT_FIELDS {
        if before[*field] != after[*field] {
            eprintln!("  {field}: {} -> {}", before[*field], after[*field]);
        }
    }
    let before = claims_by_key(before).unwrap_or_default();
    let after = claims_by_key(after).unwrap_or_default();
    for (k, c) in &after {
        match before.get(k) {
            None => eprintln!("  + claim {} / {}", k.0, k.1),
            Some(old) => {
                for field in CLAIM_FIELDS {
                    if old[*field] != c[*field] {
                        eprintln!(
                            "  claim {} {} {field}: {} -> {}",
                            k.0, k.1, old[*field], c[*field]
                        );
                    }
                }
            }
        }
    }
    for k in before.keys() {
        if !after.contains_key(k) {
            eprintln!("  - claim {} / {}", k.0, k.1);
        }
    }
}
fn validate_dependencies(api: &Api, body: &Value, proof: &Value) -> Result<()> {
    let reviews = body["dependencies"]
        .as_array()
        .context("Missing dependency reviews")?;
    if reviews.is_empty() {
        return Ok(());
    }
    ensure!(
        proof["schemaVersion"] == 2,
        "Dependency reviews require a schema version 2 run; record verification again"
    );
    let snapshot = proof["dependencies"]
        .as_array()
        .context("Recorded run has no dependency snapshot; record verification again")?;
    for review in reviews {
        let name = review["crate"]
            .as_str()
            .context("Missing dependency crate")?;
        let report_id = review["report"]
            .as_u64()
            .context("Missing dependency report ID")?;
        let revision = review["revision"]
            .as_u64()
            .context("Missing dependency revision")?;
        ensure!(
            report_id > 0 && revision > 0,
            "Dependency report and revision must be positive"
        );
        let current = api.get(&format!("/api/v1/reports/{report_id}"))?;
        ensure!(
            current["withdrawn_at"].is_null(),
            "Dependency report #{report_id} is withdrawn"
        );
        let report = api.get(&format!("/api/v1/reports/{report_id}/revisions/{revision}"))?;
        ensure!(
            report["crate"] == name,
            "Dependency {name}: report #{report_id} targets a different crate"
        );
        ensure!(snapshot.iter().any(|p| p["crate"] == name && p["version"] == report["version"] && p["source"] == "registry+https://github.com/rust-lang/crates.io-index"), "Dependency {name}: report version {} is not a crates.io dependency in the recorded run", report["version"]);
    }
    Ok(())
}
fn confirm_removal(removed: &[Value], yes: bool) -> Result<()> {
    if removed.is_empty() {
        return Ok(());
    }
    eprintln!(
        "Remove {} claim(s) from the current report (history remains):",
        removed.len()
    );
    for c in removed {
        eprintln!("  {} — {} ({})", c["id"], c["property"], c["title"]);
    }
    if yes {
        return Ok(());
    }
    ensure!(
        io::stdin().is_terminal(),
        "Deletion requires confirmation; inspect --dry-run, then use --yes to approve removals"
    );
    eprint!("Continue? [y/N] ");
    io::stderr().flush()?;
    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    ensure!(
        matches!(input.trim().to_lowercase().as_str(), "y" | "yes"),
        "Publication cancelled"
    );
    Ok(())
}
fn complete(api: &Api, state: &mut State, path: &Path) -> Result<()> {
    let pending = state
        .pending
        .as_ref()
        .context("No interrupted publication to resume")?;
    let (status, result) = api.raw("POST", &pending.path, Some(&pending.body), Some(&pending.key))
        .context("Request saved. Use publish --resume to retry the exact request; do not create a new report")?;
    if !(200..300).contains(&status) {
        if (400..500).contains(&status) && status != 408 && status != 429 {
            state.pending = None;
            state::write(path, state)?;
            bail!("Publication rejected (HTTP {status}): {} — {}. Correct the issue and run publish again.", result["error"], result["message"]);
        }
        bail!(
            "Publication failed (HTTP {status}): {}. Request saved; use publish --resume.",
            result["error"]
        );
    }
    let id = result["id"]
        .as_u64()
        .context("Missing published report ID")?;
    let revision = result["revision_no"].as_u64().unwrap_or(1);
    // Fetch the exact committed revision, not an intervening web edit.
    let report = api.get(&format!("/api/v1/reports/{id}/revisions/{revision}"))?;
    if state.report_id != Some(id) {
        state.known_claims.clear();
    }
    for claim in report["claims"]
        .as_array()
        .context("Missing published claims")?
    {
        let (api, property) = key(claim)?;
        state
            .known_claims
            .insert(format!("{api}\n{property}"), claim.clone());
    }
    state.report_id = Some(id);
    state.revision = Some(revision);
    state.snapshot = Some(snapshot(&report)?);
    state.pending = None;
    state::write(path, state)?;
    println!(
        "Published report #{id}, revision {revision}: {}/#/report/{id}",
        api.server
    );
    Ok(())
}
pub fn run(server: &str, args: &ProjectArgs, options: Options) -> Result<()> {
    let project = Project::load(args)?;
    let api = Api::new(server, true)?;
    let me = api.get("/api/v1/me")?;
    let user = me["user"]["id"]
        .as_str()
        .context("Not authenticated; run login again")?;
    let manifest = project.manifest.to_string_lossy();
    let path = record::state_dir(&project)?
        .join("publication")
        .join(format!(
            "{}.json",
            state::digest(&format!(
                "{server}\n{user}\n{manifest}\n{}\n{}",
                project.name, project.version
            ))
        ));
    fs::create_dir_all(path.parent().unwrap())?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("lock"))?;
    lock.try_lock_exclusive()
        .context("Another cargo proofs publish is running for this package/server")?;
    let mut saved: State = state::read(&path)?.unwrap_or_default();
    if options.resume {
        let pending = saved
            .pending
            .as_ref()
            .context("No interrupted publication to resume")?;
        println!(
            "Retrying saved {} request with the same idempotency key.\n{}",
            pending.path,
            serde_json::to_string_pretty(&pending.body)?
        );
        return complete(&api, &mut saved, &path);
    }
    ensure!(saved.pending.is_none(), "An interrupted publication is saved. Run publish --resume before starting another publication");
    let config = project.config()?;
    let (run_dir, recorded) = record::load(&project, options.run.as_deref())?;
    let contracts = &recorded.contracts;
    let entry = &recorded.sarif["runs"][0];
    let run_id = entry["automationDetails"]["guid"]
        .as_str()
        .context("Missing run ID")?;
    let source = &entry["versionControlProvenance"][0];
    ensure!(
        contracts.len() * config.tool.properties().len() <= 100,
        "Too many claims"
    );
    let tool = api.tool_version(&config.tool.name, &config.tool.version)?;
    if options.dry_run {
        println!(
            "Recorded SARIF (will upload on publish): {}",
            run_dir.join("run.sarif.json").display()
        );
    } else {
        api.upload(
            &format!("/api/v1/runs/{run_id}/sarif"),
            &fs::read(run_dir.join("run.sarif.json"))?,
        )?;
    }
    api.prepare(&project.name, &project.version)?;
    let mut claims = vec![];
    let mut seen = BTreeSet::new();
    for contract in contracts {
        let (api_id, api_path) =
            api.resolve(&project.name, &project.version, &contract.api_paths)?;
        ensure!(
            seen.insert(api_id.clone()),
            "Multiple contracts resolve to the same public API {api_path}"
        );
        let evidence = format!(
            "{}/blob/{}/{}#L{}-L{}",
            source["repositoryUri"]
                .as_str()
                .context("Missing source repository")?,
            source["revisionId"]
                .as_str()
                .context("Missing source commit")?,
            contract.file,
            contract.first_line,
            contract.last_line
        );
        println!(
            "{} → {}\n  precondition: {}\n  evidence: {}",
            contract.harness, api_path, contract.precondition, evidence
        );
        for property in config.tool.properties() {
            claims.push(json!({"api_item_id":api_id,"property":property,"precondition":contract.precondition,"evidence_url":evidence}));
        }
    }
    let selected = options.report.or(saved.report_id);
    let remote = selected
        .map(|id| api.get(&format!("/api/v1/reports/{id}")))
        .transpose()?;
    if let Some(report) = &remote {
        ensure!(
            report["author_id"] == user,
            "Only the report author can publish revisions"
        );
        ensure!(
            report["crate"] == project.name && report["version"] == project.version,
            "Report targets a different crate/version; publish a new report instead"
        );
        ensure!(
            report["withdrawn_at"].is_null(),
            "Withdrawn reports cannot be revised"
        );
    }
    let attached = options.report.is_some() && options.report != saved.report_id;
    let conflict = !attached
        && remote
            .as_ref()
            .is_some_and(|r| saved.revision != r["revision_no"].as_u64());
    if conflict {
        eprintln!("Server report changed since the last CLI publication:");
        if let (Some(old), Some(new)) = (&saved.snapshot, &remote) {
            diff(old, &snapshot(new)?);
        }
        if !options.force && !options.dry_run {
            bail!("Web revision conflict. Inspect publish --dry-run; use --force to publish local changes over the latest revision");
        }
    }
    let generated = json!({"crate":project.name,"version":project.version,"tool_version_id":tool,"evidence_url":format!("{}/tree/{}", source["repositoryUri"].as_str().unwrap(), source["revisionId"].as_str().unwrap()),"run_ids":[run_id],"claims":claims});
    // Unspecified editorial fields are preserved. Force changes only fields owned by this CLI/config.
    let mut baseline = remote.clone();
    if saved.report_id == selected {
        if let Some(baseline) = &mut baseline {
            let current = claims_by_key(baseline)?;
            for claim in saved.known_claims.values() {
                if !current.contains_key(&key(claim)?) {
                    baseline["claims"]
                        .as_array_mut()
                        .context("Missing claims")?
                        .push(claim.clone());
                }
            }
        }
    }
    let mut body = merge(&config, generated, baseline.as_ref())?;
    validate_dependencies(&api, &body, &entry["properties"]["proofs"])?;
    if let Some(report) = &remote {
        body["expected_revision"] = report["revision_no"].clone();
    }
    let mut validation_body = body.clone();
    if let Some(id) = selected {
        validation_body["report_id"] = json!(id);
    }
    ensure!(
        serde_json::to_vec(&validation_body)?.len() <= 131072,
        "Report exceeds the service's 128 KiB request limit"
    );
    let preview = if options.dry_run {
        body.clone()
    } else {
        api.request(
            "POST",
            "/api/v1/reports/validate",
            Some(&validation_body),
            None,
        )?
    };
    let normalized = snapshot(&preview)?;
    let removed: Vec<Value> = if let Some(report) = &remote {
        let retained: BTreeSet<_> = body["claims"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["id"].as_str())
            .collect();
        report["claims"]
            .as_array()
            .context("Missing remote claims")?
            .iter()
            .filter(|c| !c["id"].as_str().is_some_and(|id| retained.contains(id)))
            .cloned()
            .collect()
    } else {
        vec![]
    };
    println!(
        "Report: {}\n{} claims; {} removal(s).",
        config.report.title,
        body["claims"].as_array().unwrap().len(),
        removed.len()
    );
    if let Some(report) = &remote {
        diff(&snapshot(report)?, &normalized);
    }
    if options.dry_run {
        if remote.is_none() {
            diff(&json!({"dependencies":[],"claims":[]}), &normalized);
        }
        println!("{}", serde_json::to_string_pretty(&preview)?);
        if conflict {
            eprintln!("A real publication requires --force because the server revision changed.");
        }
        println!("Dry run: no report published.");
        return Ok(());
    }
    if let Some(report) = &remote {
        if same_content(&snapshot(report)?, &normalized) {
            saved.report_id = selected;
            saved.revision = report["revision_no"].as_u64();
            saved.snapshot = Some(snapshot(report)?);
            state::write(&path, &saved)?;
            println!("No changes; no new revision published.");
            return Ok(());
        }
    }
    confirm_removal(&removed, options.yes)?;

    saved.pending = Some(Pending {
        path: selected.map_or_else(
            || "/api/v1/reports".into(),
            |id| format!("/api/v1/reports/{id}/revisions"),
        ),
        body,
        key: uuid::Uuid::new_v4().to_string(),
    });
    state::write(&path, &saved)?;
    complete(&api, &mut saved, &path)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        toml::from_str("[report]\ntitle='Local'\n[tool]\nname='kani'\nversion='0.66.0'\n").unwrap()
    }
    #[test]
    fn enriched_dependency_details_do_not_change_publication_content() {
        let plain =
            json!({"claims":[],"dependencies":[{"crate":"serde","report":123,"revision":2}]});
        let enriched = json!({"claims":[],"dependencies":[{"crate":"serde","report":123,"revision":2,"version":"1.0.0","withdrawn_at":null}]});
        assert!(same_content(&plain, &enriched));
        assert_eq!(
            snapshot(&enriched).unwrap()["dependencies"],
            plain["dependencies"]
        );
    }
    #[test]
    fn dependency_reviews_preserve_clear_and_update_without_new_run() {
        let old = json!({"run_ids":["run"],"dependencies":[{"crate":"serde","report":123,"revision":2}],"claims":[]});
        let generated = json!({"run_ids":["run"],"claims":[]});
        let preserved = merge(&config(), generated.clone(), Some(&old)).unwrap();
        assert_eq!(preserved["dependencies"], old["dependencies"]);
        let mut cfg = config();
        cfg.dependencies = Some(BTreeMap::new());
        let cleared = merge(&cfg, generated.clone(), Some(&old)).unwrap();
        assert_eq!(cleared["dependencies"], json!([]));
        cfg.dependencies.as_mut().unwrap().insert(
            "serde".into(),
            crate::config::DependencyReview {
                report: std::num::NonZeroU64::new(123).unwrap(),
                revision: std::num::NonZeroU64::new(3).unwrap(),
            },
        );
        let updated = merge(&cfg, generated, Some(&old)).unwrap();
        assert_eq!(updated["run_ids"], old["run_ids"]);
        assert_eq!(updated["dependencies"][0]["revision"], 3);
        assert!(!same_content(&preserved, &updated));
    }
    #[test]
    fn preserve_ids_and_web_text_but_update_evidence() {
        let remote = json!({"title":"Web", "explanation":"Web report explanation", "claims":[{"id":"permanent","api_item_id":"api","property":"no_ub","title":"Web title","explanation":"Web claim explanation","precondition":"old","evidence_url":"old"}]});
        let generated = json!({"crate":"demo","version":"1.0.0","tool_version_id":"kani","evidence_url":"shared","claims":[{"api_item_id":"api","property":"no_ub","precondition":"new","evidence_url":"new"}]});
        let body = merge(&config(), generated, Some(&remote)).unwrap();
        assert_eq!(body["title"], "Local");
        assert_eq!(body["explanation"], "Web report explanation");
        assert_eq!(body["claims"][0]["id"], "permanent");
        assert_eq!(body["claims"][0]["title"], "Web title");
        assert_eq!(body["claims"][0]["precondition"], "new");
    }
    #[test]
    fn explicit_empty_clears_and_removed_claim_is_omitted() {
        let mut cfg = config();
        cfg.report.explanation = Some("".into());
        let old = json!({"explanation":"Web", "claims":[{"id":"removed","api_item_id":"old","property":"no_ub"}]});
        let new = json!({"claims":[{"api_item_id":"new","property":"no_ub","precondition":"true","evidence_url":"url"}]});
        let b = merge(&cfg, new, Some(&old)).unwrap();
        assert_eq!(b["explanation"], "");
        assert!(b["claims"][0].get("id").is_none());
    }
    #[test]
    fn interrupted_request_reuses_key_and_loads_exact_revision() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.server_addr());
        let job = std::thread::spawn(move || {
            for attempt in 0..2 {
                let mut request = server.recv().unwrap();
                assert_eq!(request.url(), "/api/v1/reports");
                let mut payload = String::new();
                request.as_reader().read_to_string(&mut payload).unwrap();
                let payload: Value = serde_json::from_str(&payload).unwrap();
                assert_eq!(
                    payload["dependencies"],
                    json!([{"crate":"serde","report":123,"revision":2}])
                );
                assert!(request
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("Idempotency-Key") && h.value.as_str() == "stable-key"));
                request
                    .respond(
                        tiny_http::Response::from_string(if attempt == 0 {
                            r#"{"error":"internal_error"}"#
                        } else {
                            r#"{"id":42}"#
                        })
                        .with_status_code(if attempt == 0 {
                            500
                        } else {
                            201
                        }),
                    )
                    .unwrap();
            }
            let request = server.recv().unwrap();
            assert_eq!(request.url(), "/api/v1/reports/42/revisions/1");
            request
                .respond(tiny_http::Response::from_string(
                    r#"{"title":"Published","claims":[]}"#,
                ))
                .unwrap();
        });
        let api = Api::new(&origin, false).unwrap();
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("state.json");
        let mut state = State {
            pending: Some(Pending {
                path: "/api/v1/reports".into(),
                body: json!({"title":"Published","dependencies":[{"crate":"serde","report":123,"revision":2}]}),
                key: "stable-key".into(),
            }),
            ..State::default()
        };
        state::write(&path, &state).unwrap();
        assert!(complete(&api, &mut state, &path).is_err());
        assert!(state.pending.is_some());
        complete(&api, &mut state, &path).unwrap();
        let saved: State = state::read(&path).unwrap().unwrap();
        assert_eq!(saved.report_id, Some(42));
        assert_eq!(saved.revision, Some(1));
        assert!(saved.pending.is_none());
        job.join().unwrap();
    }
    #[test]
    fn rejected_request_can_be_corrected() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.server_addr());
        let job = std::thread::spawn(move || {
            server
                .recv()
                .unwrap()
                .respond(
                    tiny_http::Response::from_string(r#"{"error":"conflict"}"#)
                        .with_status_code(409),
                )
                .unwrap();
        });
        let api = Api::new(&origin, false).unwrap();
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("state.json");
        let mut state = State {
            pending: Some(Pending {
                path: "/api/v1/reports/42/revisions".into(),
                body: json!({}),
                key: "stable-key".into(),
            }),
            ..State::default()
        };
        assert!(complete(&api, &mut state, &path).is_err());
        assert!(state.pending.is_none());
        job.join().unwrap();
    }
    #[test]
    fn rejects_ambiguous_existing_claims() {
        let r = json!({"claims":[{"api_item_id":"a","property":"no_ub"},{"api_item_id":"a","property":"no_ub"}]});
        assert!(claims_by_key(&r).is_err());
    }
}
