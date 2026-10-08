use crate::ProjectArgs;
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
    process::Command,
};

#[derive(Default, Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_assumptions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limitations: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Tool {
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<CreusotTarget>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, clap::ValueEnum, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CreusotTarget {
    Annotated,
    All,
}
impl Tool {
    pub fn is_creusot(&self) -> bool {
        self.name.eq_ignore_ascii_case("creusot")
    }
    pub fn properties(&self) -> &'static [&'static str] {
        if self.is_creusot() {
            &["panic_contract"]
        } else {
            &["no_ub", "panic_contract"]
        }
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            self.is_creusot() || self.name.eq_ignore_ascii_case("kani"),
            "Supported tools: kani, creusot"
        );
        ensure!(
            !self.version.trim().is_empty(),
            "[tool].version is required"
        );
        if self.is_creusot() {
            ensure!(
                self.target.is_some(),
                "Creusot requires [tool].target = \"annotated\" or \"all\""
            );
        } else {
            ensure!(
                self.target.is_none(),
                "[tool].target applies only to Creusot; Kani uses proof_for_contract harnesses"
            );
        }
        Ok(())
    }
}
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Git {
    pub remote: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DependencyReview {
    pub report: std::num::NonZeroU64,
    pub revision: std::num::NonZeroU64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub report: Report,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<BTreeMap<String, DependencyReview>>,
    pub tool: Tool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<Git>,
}
pub struct Project {
    pub name: String,
    pub version: String,
    pub lib_name: String,
    pub manifest: PathBuf,
    pub root_source: PathBuf,
    pub features: BTreeSet<String>,
    pub cfg: BTreeSet<String>,
}
impl Project {
    pub fn load(args: &ProjectArgs) -> Result<Self> {
        let mut command = Command::new("cargo");
        command.args(["metadata", "--format-version", "1", "--no-deps"]);
        if let Some(path) = &args.manifest_path {
            command.arg("--manifest-path").arg(path);
        }
        let output = command
            .output()
            .context("Run cargo metadata; install Rust/Cargo first")?;
        ensure!(
            output.status.success(),
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let meta: Value = serde_json::from_slice(&output.stdout)?;
        let packages = meta["packages"].as_array().context("Missing packages")?;
        let requested = if let Some(path) = &args.manifest_path {
            Some(path.canonicalize()?)
        } else {
            let mut cwd = std::env::current_dir()?;
            loop {
                if cwd.join("Cargo.toml").exists() {
                    break Some(cwd.join("Cargo.toml").canonicalize()?);
                }
                if !cwd.pop() {
                    break None;
                }
            }
        };
        let mut candidates: Vec<&Value> = packages
            .iter()
            .filter(|p| {
                if let Some(name) = &args.package {
                    return p["name"].as_str() == Some(name);
                }
                requested.as_ref().is_some_and(|path| {
                    p["manifest_path"]
                        .as_str()
                        .is_some_and(|s| std::path::Path::new(s) == path.as_path())
                })
            })
            .collect();
        if candidates.is_empty() && args.package.is_none() && packages.len() == 1 {
            candidates.push(&packages[0]);
        }
        ensure!(
            candidates.len() == 1,
            "Select exactly one workspace package with -p NAME"
        );
        let p = candidates[0];
        let target = p["targets"]
            .as_array()
            .context("Missing targets")?
            .iter()
            .find(|t| {
                t["kind"].as_array().is_some_and(|ks| {
                    ks.iter().any(|k| {
                        matches!(k.as_str(), Some("lib" | "rlib" | "cdylib" | "staticlib"))
                    })
                })
            })
            .context("The selected package must have a library target")?;
        let feature_map = p["features"].as_object().context("Missing feature map")?;
        let mut features = BTreeSet::new();
        let mut queue = args.features.clone();
        if args.all_features {
            queue.extend(feature_map.keys().cloned());
        }
        if !args.no_default_features && feature_map.contains_key("default") {
            queue.push("default".into());
        }
        while let Some(f) = queue.pop() {
            if f.starts_with("dep:") || f.contains('/') {
                continue;
            }
            let values = feature_map
                .get(&f)
                .with_context(|| format!("Unknown package feature {f}"))?;
            if features.insert(f) {
                queue.extend(
                    values
                        .as_array()
                        .context("Invalid feature list")?
                        .iter()
                        .filter_map(|v| v.as_str().map(String::from)),
                );
            }
        }
        let mut rustc = Command::new("rustc");
        rustc.args(["--print", "cfg"]);
        if let Some(t) = &args.target {
            rustc.args(["--target", t]);
        }
        let out = rustc.output().context("Run rustc --print cfg")?;
        ensure!(
            out.status.success(),
            "rustc --print cfg failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let cfg = String::from_utf8(out.stdout)?
            .lines()
            .map(String::from)
            .collect();
        Ok(Self {
            name: p["name"].as_str().context("Missing crate name")?.into(),
            version: p["version"].as_str().context("Missing version")?.into(),
            lib_name: target["name"]
                .as_str()
                .context("Missing library name")?
                .into(),
            manifest: PathBuf::from(p["manifest_path"].as_str().context("Missing manifest")?)
                .canonicalize()?,
            root_source: PathBuf::from(
                target["src_path"]
                    .as_str()
                    .context("Missing library source")?,
            ),
            features,
            cfg,
        })
    }
    pub fn config_path(&self) -> PathBuf {
        self.manifest.with_file_name("proofs.toml")
    }
    pub fn config(&self) -> Result<Config> {
        let config: Config = toml::from_str(
            &fs::read_to_string(self.config_path())
                .context("Read proofs.toml; run cargo proofs init first")?,
        )?;
        ensure!(
            !config.report.title.trim().is_empty(),
            "[report].title is required"
        );
        config.tool.validate()?;
        Ok(config)
    }
}
pub fn init(
    args: &ProjectArgs,
    title: Option<String>,
    version: Option<String>,
    tool: String,
    target: Option<CreusotTarget>,
) -> Result<()> {
    let project = Project::load(args)?;
    let label = if tool == "creusot" { "Creusot" } else { "Kani" };
    let version = match version {
        Some(v) => v,
        None => {
            let out = Command::new("cargo")
                .args([
                    tool.as_str(),
                    if tool == "creusot" {
                        "version"
                    } else {
                        "--version"
                    },
                ])
                .output()
                .with_context(|| format!("Cannot detect {label}; pass --tool-version VERSION"))?;
            if !out.status.success() {
                bail!("Cannot detect {label}; pass --tool-version VERSION used for verification");
            }
            String::from_utf8(out.stdout)?
                .split_whitespace()
                .find(|s| s.chars().next().is_some_and(|c| c.is_ascii_digit()))
                .context("Cannot parse tool version; use --tool-version")?
                .to_owned()
        }
    };
    let config = Config {
        report: Report {
            title: title.unwrap_or_else(|| {
                format!(
                    "{label} verification of {} {}",
                    project.name, project.version
                )
            }),
            ..Report::default()
        },
        tool: Tool {
            name: tool,
            version,
            target,
        },
        git: None,
        dependencies: None,
    };
    config.tool.validate()?;
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(project.config_path())
        .context("Create proofs.toml (existing files are never overwritten)")?;
    file.write_all(toml::to_string_pretty(&config)?.as_bytes())?;
    println!(
        "Created {}. Review its title and the tool version used for verification.",
        project.config_path().display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dependency_reviews_are_optional_strict_and_positive() {
        let base = "[report]\ntitle='Local'\n[tool]\nname='kani'\nversion='1'\n";
        assert!(toml::from_str::<Config>(base)
            .unwrap()
            .dependencies
            .is_none());
        let empty: Config = toml::from_str(&format!("{base}[dependencies]\n")).unwrap();
        assert!(empty.dependencies.unwrap().is_empty());
        let config: Config = toml::from_str(&format!(
            "{base}[dependencies]\nserde={{report=123,revision=2}}\n"
        ))
        .unwrap();
        assert_eq!(config.dependencies.unwrap()["serde"].report.get(), 123);
        for review in [
            "{report=0,revision=2}",
            "{report=123,revision=0}",
            "{report=123,revision=2,version='1'}",
            "{report=123,revision=2,rationale='x'}",
        ] {
            assert!(
                toml::from_str::<Config>(&format!("{base}[dependencies]\nserde={review}\n"))
                    .is_err()
            );
        }
    }
    #[test]
    fn tool_targets_and_properties() {
        let mut tool: Tool = toml::from_str("name='kani'\nversion='0.66.0'").unwrap();
        assert!(tool.validate().is_ok());
        assert_eq!(tool.properties(), ["no_ub", "panic_contract"]);
        tool.target = Some(CreusotTarget::All);
        assert!(tool.validate().is_err());
        tool.name = "creusot".into();
        assert!(tool.validate().is_ok());
        assert_eq!(tool.properties(), ["panic_contract"]);
        tool.target = None;
        assert!(tool.validate().is_err());
        assert!(toml::from_str::<Tool>("name='creusot'\nversion='x'\ntarget='typo'").is_err());
    }
}
