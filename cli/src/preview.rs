//! Read-only draft projection and the lifecycle of the bundled Node preview server.
use crate::{
    api::ReadOnlyApi as Api,
    config::Project,
    draft, record,
    state::{self, State},
    ProjectArgs,
};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

pub struct Options {
    pub draft: bool,
    pub run: Option<String>,
    pub report: Option<u64>,
    pub port: u16,
    pub no_browser: bool,
}

struct RecordedPreview {
    project: Project,
    server: String,
    run_id: String,
    report: Option<u64>,
    state_path: Option<std::path::PathBuf>,
    identity_warning: Option<String>,
}

impl RecordedPreview {
    fn new(server: &str, args: &ProjectArgs, options: &Options) -> Result<Self> {
        let project = Project::load(args)?;
        let (_, recorded) = record::load(&project, options.run.as_deref())?;
        let run_id = recorded.sarif["runs"][0]["automationDetails"]["guid"]
            .as_str()
            .context("Missing run ID")?
            .to_owned();
        let identity = (|| -> Result<_> {
            let api = Api::new(server, true)?;
            let me = api.get("/api/v1/me")?;
            let user = me["user"]["id"].as_str().context("No authenticated user")?;
            state::publication_path(server, user, &project)
        })();
        let (state_path, identity_warning) = match identity {
            Ok(path) => (Some(path), None),
            Err(_) => (None, Some("No authenticated publication state available. Use --report ID to preview an existing report; otherwise this is a new report.".into())),
        };
        let saved: State = state_path
            .as_ref()
            .map(|p| state::read(p))
            .transpose()?
            .flatten()
            .unwrap_or_default();
        Ok(Self {
            project,
            server: server.into(),
            run_id,
            report: options.report.or(saved.report_id),
            state_path,
            identity_warning,
        })
    }

    fn snapshot(&self) -> Result<Value> {
        let config = self.project.config()?;
        let (_, recorded) = record::load(&self.project, Some(&self.run_id))?;
        ensure!(
            recorded.contracts.len() <= crate::MAX_REPORT_CLAIMS,
            "Too many claims"
        );
        let api = Api::new(&self.server, false)?;
        let saved: State = self
            .state_path
            .as_ref()
            .map(|p| state::read(p))
            .transpose()?
            .flatten()
            .unwrap_or_default();
        let mut warnings: Vec<String> = self.identity_warning.iter().cloned().collect();
        let remote = self
            .report
            .map(|id| api.get(&format!("/api/v1/reports/{id}")))
            .transpose()?;
        if let Some(r) = &remote {
            ensure!(
                r["crate"] == self.project.name && r["version"] == self.project.version,
                "Report targets a different crate/version"
            );
            if !r["withdrawn_at"].is_null() {
                warnings.push("This report is withdrawn and cannot be revised.".into());
            }
            if saved.report_id == self.report && saved.revision != r["revision_no"].as_u64() {
                warnings.push("The server revision changed since the last CLI publication. Publishing may require --force.".into());
            }
        }
        if saved.pending.is_some() {
            warnings.push("An interrupted publication is saved. Preview does not resume or change it; use publish --resume separately.".into());
        }
        let tool_id = match api.tool_version(&config.tool.name, &config.tool.version) {
            Ok(id) => id,
            Err(_) => {
                warnings.push(
                    "Tool version is unavailable or unregistered; tool details are unverified."
                        .into(),
                );
                String::new()
            }
        };
        let tool = if tool_id.is_empty() {
            Value::Null
        } else {
            match api.get(&format!(
                "/api/v1/tool-versions/{}",
                url_component(&tool_id)
            )) {
                Ok(tool) => tool,
                Err(_) => {
                    warnings.push("Tool details and limitations could not be verified.".into());
                    Value::Null
                }
            }
        };
        let catalog = api
            .get(&format!(
                "/api/v1/crates/{}/{}/apis",
                url_component(&self.project.name),
                url_component(&self.project.version)
            ))
            .unwrap_or(Value::Null);
        let items = catalog["items"].as_array();
        let entry = &recorded.sarif["runs"][0];
        let source = &entry["versionControlProvenance"][0];
        let repository = source["repositoryUri"]
            .as_str()
            .context("Missing source repository")?;
        let commit = source["revisionId"]
            .as_str()
            .context("Missing source commit")?;
        let mut claims = vec![];
        let mut metadata = BTreeMap::new();
        let mut seen = BTreeSet::new();
        for contract in &recorded.contracts {
            // Match exact aliases in the same order as the server. A saved
            // binding for this immutable run takes priority over new aliases.
            let retained = remote
                .as_ref()
                .and_then(|r| r["claims"].as_array())
                .and_then(|claims| {
                    claims.iter().find(|c| {
                        c["evidence_ref"]["run_id"] == self.run_id
                            && c["evidence_ref"]["harness"] == contract.harness
                    })
                });
            let info = items.and_then(|items| {
                retained
                    .and_then(|c| {
                        items.iter().find(|i| {
                            i["id"] == c["api_item_id"]
                                && contract.api_paths.iter().any(|p| i["display_path"] == *p)
                        })
                    })
                    .or_else(|| {
                        contract
                            .api_paths
                            .iter()
                            .find_map(|p| items.iter().find(|i| i["display_path"] == *p))
                    })
            });
            let (id, info) = if let Some(info) = info {
                let id = info["id"].as_str().context("Invalid API ID")?.to_owned();
                (id, info.clone())
            } else {
                let path = contract
                    .api_paths
                    .first()
                    .cloned()
                    .unwrap_or_else(|| contract.harness.clone());
                let id = record::observed_api_id(&self.project.name, &self.project.version, &path)?;
                warnings.push(format!("API mapping and signature unverified by rustdoc: {path}. The exact callable name is retained from the verification record; signature and safety are not recorded."));
                (
                    id,
                    json!({"display_path":path,"signature":"","kind":"callable","origin":"recorded","is_unsafe":null,"unverified":true}),
                )
            };
            metadata.insert(id.clone(), info);
            let mut claim = json!({"api_item_id":id,"precondition":contract.precondition,"evidence_url":format!("{repository}/blob/{commit}/{}#L{}-L{}",contract.file,contract.first_line,contract.last_line)});
            if contract.formal.is_some() {
                claim["evidence_ref"] = json!({"run_id":self.run_id,"harness":contract.harness});
            }
            ensure!(
                seen.insert(draft::key(&claim)?),
                "Multiple contracts resolve to the same public API and theorem"
            );
            claims.push(claim);
        }
        let generated = json!({"crate":self.project.name,"version":self.project.version,"tool_version_id":tool_id,"evidence_url":format!("{repository}/tree/{commit}"),"run_ids":[self.run_id],"claims":claims});
        let mut report = draft::compose(&config, generated, &remote, &saved, self.report)?;
        if let Some(id) = self.report {
            if !config.report.findings.is_empty() {
                warnings.push("report.findings applies only to new reports. This preview shows published findings; add or edit them using the report page or Findings API.".into());
            }
            match published_findings(id, |path| api.get(path)) {
                Ok(items) => report["findings"] = json!(items),
                Err(_) => warnings.push("Published findings could not be loaded; their contents and count are unavailable.".into()),
            }
        } else if let Some(findings) = report.as_object_mut().unwrap().remove("findings") {
            report["finding_drafts"] = findings;
            let mut related = vec![];
            for finding in &config.report.findings {
                let mut apis = BTreeMap::new();
                for path in &finding.api_paths {
                    match api.resolve(
                        &self.project.name,
                        &self.project.version,
                        &[path.trim().to_owned()],
                    ) {
                        Ok((id, _)) => {
                            apis.insert(id.clone(), json!({"id":id,"display_path":path.trim()}));
                        }
                        Err(_) => {
                            warnings.push(format!("Finding API mapping unverified: {path}. Publication requires a unique API match."));
                            apis.insert(
                                path.clone(),
                                json!({"display_path":path,"unverified":true}),
                            );
                        }
                    }
                }
                related.push(apis.into_values().collect::<Vec<_>>());
            }
            report["finding_draft_apis"] = json!(related);
        }
        if let Some(r) = &remote {
            let retained: BTreeSet<_> = report["claims"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|c| c["id"].as_str())
                .collect();
            let removed = r["claims"]
                .as_array()
                .context("Missing report claims")?
                .iter()
                .filter(|c| !c["id"].as_str().is_some_and(|id| retained.contains(id)))
                .count();
            if removed > 0 {
                warnings.push(format!("{removed} existing claim(s) are absent from this draft. Unverified API mappings may affect this count."));
            }
        }
        report["id"] = json!(self.report);
        report["base_revision"] = remote
            .as_ref()
            .map(|r| r["revision_no"].clone())
            .unwrap_or(Value::Null);
        report["tool"] = tool
            .get("tool")
            .filter(|v| v.is_string())
            .cloned()
            .unwrap_or_else(|| json!(config.tool.name));
        report["tool_version"] = json!(config.tool.version);
        report["tool_limitations"] = tool["limitations"].clone();
        report["tool_limitations_updated_at"] = tool["limitations_updated_at"].clone();
        report["direct_dependencies"] = Value::Null;
        for review in report["dependencies"]
            .as_array_mut()
            .context("Missing dependencies")?
        {
            let id = review["report"]
                .as_u64()
                .context("Invalid dependency report")?;
            let rev = review["revision"]
                .as_u64()
                .context("Invalid dependency revision")?;
            match api.get(&format!("/api/v1/reports/{id}/revisions/{rev}")) {
                Ok(r) => {
                    review["version"] = r["version"].clone();
                    review["withdrawn"] = json!(!r["withdrawn_at"].is_null());
                    let matches = entry["properties"]["proofs"]["dependencies"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|d| {
                            d["crate"] == review["crate"]
                                && d["version"] == r["version"]
                                && d["source"]
                                    == "registry+https://github.com/rust-lang/crates.io-index"
                        });
                    if r["crate"] != review["crate"] || !matches {
                        warnings.push(format!("Dependency review #{id} v{rev} does not match the recorded crates.io dependency."));
                    }
                }
                Err(_) => warnings.push(format!(
                    "Dependency review #{id} v{rev} could not be verified."
                )),
            }
        }
        for (index, claim) in report["claims"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            let info = &metadata[claim["api_item_id"].as_str().unwrap()];
            for (key, value) in info.as_object().context("Invalid API metadata")? {
                if key != "id" {
                    claim[key] = value.clone();
                }
            }
            if claim["id"].as_str().is_none_or(str::is_empty) {
                claim["id"] = json!(format!("preview-claim-{index}"));
            }
            claim["claim_number"] = json!(index + 1);
        }
        Ok(
            json!({"mode":"recorded","report":report,"sarif":recorded.sarif,"warnings":warnings,"server":self.server}),
        )
    }
}

struct DraftPreview {
    project: Project,
    config_path: std::path::PathBuf,
    server: String,
}

impl DraftPreview {
    fn new(server: &str, args: &ProjectArgs) -> Result<Self> {
        let project = Project::load(args)?;
        let config_path = if let Some(path) = &args.proofs_config {
            ensure!(
                !path.as_os_str().is_empty()
                    && !path.is_absolute()
                    && !path
                        .components()
                        .any(|part| matches!(part, std::path::Component::ParentDir)),
                "--proofs-config must stay within the selected package directory"
            );
            project.manifest.parent().unwrap().join(path)
        } else {
            project.config_path()
        };
        // Keep the lexical path so reload follows edits/replacements, and recheck
        // containment on every snapshot (including changes to symlinks).
        Ok(Self {
            project,
            config_path,
            server: server.into(),
        })
    }

    fn snapshot(&self) -> Result<Value> {
        let path = self
            .config_path
            .canonicalize()
            .with_context(|| format!("Read {}", self.config_path.display()))?;
        ensure!(
            path.starts_with(self.project.manifest.parent().unwrap()),
            "Draft configuration must stay within the selected package directory"
        );
        let config = crate::config::Config::read(&path)?;
        let mut report = serde_json::to_value(&config.report)?;
        report["crate"] = json!(self.project.name);
        report["version"] = json!(self.project.version);
        report["tool"] = json!(config.tool.name);
        report["tool_version"] = json!(config.tool.version);
        if let Some(patch) = &config.tool.patch {
            let package = self.project.manifest.parent().unwrap();
            let (path, bytes) = crate::toolchain::patch_bytes(package, patch, package)?;
            // Configuration intent only: no materialized tree or execution observations.
            report["toolchain_configuration"] = json!({
                "components":{"aeneas":{"tool":"aeneas","source":{
                    "kind":"git_patch","repository":crate::aeneas::REPOSITORY,
                    "base_commit":config.tool.version,
                    "patch":{"path":path,"sha256":crate::toolchain::digest(&bytes)}
                }}},
                "patch_path_base":"package",
                "lean_dir":config.tool.lean_dir,
                "managed_dependency":".proofs-toolchain/aeneas/backends/lean"
            });
        }
        if let Some(patch) = &config.tool.charon_patch {
            let package = self.project.manifest.parent().unwrap();
            let (path, bytes) = crate::toolchain::patch_bytes(package, patch, package)?;
            // The official base is resolved by prepare, not guessed in draft mode.
            report["charon_patch_configuration"] = json!({"path":path,"sha256":crate::toolchain::digest(&bytes),"base":"official Aeneas charon-pin","execution":"not_run"});
        }
        report["mappings"] = json!(config
            .tool
            .proofs
            .iter()
            .enumerate()
            .map(|(i, proof)| {
                let mut mapping = serde_json::to_value(proof).unwrap();
                mapping["id"] = json!(format!("draft-mapping-{i}"));
                mapping
            })
            .collect::<Vec<_>>());
        // This projection is deliberately not a Record and cannot be loaded by
        // publish: there is no run ID, SARIF, source provenance or success status.
        Ok(json!({"mode":"draft","report":report,"sarif":null,"warnings":[],"server":self.server}))
    }
}

enum Preview {
    Recorded(RecordedPreview),
    Draft(DraftPreview),
}

impl Preview {
    fn new(server: &str, args: &ProjectArgs, options: &Options) -> Result<Self> {
        if options.draft {
            ensure!(
                options.run.is_none() && options.report.is_none(),
                "--draft cannot be combined with --run or --report"
            );
            Ok(Self::Draft(DraftPreview::new(server, args)?))
        } else {
            Ok(Self::Recorded(RecordedPreview::new(server, args, options)?))
        }
    }

    fn snapshot(&self) -> Result<Value> {
        match self {
            Self::Recorded(preview) => preview.snapshot(),
            Self::Draft(preview) => preview.snapshot(),
        }
    }
}

fn published_findings(
    report: u64,
    mut get: impl FnMut(&str) -> Result<Value>,
) -> Result<Vec<Value>> {
    let base = format!("/api/v1/reports/{report}/findings");
    let mut path = base.clone();
    let mut seen = BTreeSet::new();
    let mut findings = vec![];
    loop {
        let page = get(&path)?;
        findings.extend(
            page["items"]
                .as_array()
                .context("Missing findings")?
                .clone(),
        );
        match page.get("next_cursor") {
            Some(Value::Null) => break,
            Some(Value::String(cursor)) => {
                ensure!(seen.insert(cursor.clone()), "Repeated findings cursor");
                path = format!("{base}?cursor={}", url_component(cursor));
            }
            _ => bail!("Invalid findings cursor"),
        }
    }
    Ok(findings)
}

fn url_component(s: &str) -> String {
    let mut url = reqwest::Url::parse("http://localhost/").unwrap();
    url.path_segments_mut().unwrap().push(s);
    url.path()[1..].to_owned()
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
enum Event {
    Message(Value),
    Snapshot(Value),
    End,
}

pub fn run(server: &str, args: &ProjectArgs, options: Options) -> Result<()> {
    let version = Command::new("node")
        .arg("--version")
        .output()
        .context("Preview requires Node.js 24 or newer on PATH")?;
    let version = String::from_utf8_lossy(&version.stdout);
    ensure!(
        version
            .trim()
            .trim_start_matches('v')
            .split('.')
            .next()
            .and_then(|v| v.parse::<u32>().ok())
            .is_some_and(|v| v >= 24),
        "Preview requires Node.js 24 or newer (found {})",
        version.trim()
    );
    let preview = Preview::new(server, args, &options)?;
    // Validate explicit targets and recorded input before advertising a listening server.
    preview.snapshot()?;
    let directory = tempfile::tempdir()?;
    let script = directory.path().join("server.cjs");
    fs::write(&script, include_bytes!("../preview/server.cjs"))?;
    let stopped = Arc::new(AtomicBool::new(false));
    let signal = stopped.clone();
    ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst))?;
    let mut child = ChildGuard(
        Command::new("node")
            .arg(&script)
            .arg(options.port.to_string())
            .arg(if options.draft { "draft" } else { "recorded" })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("Start preview server")?,
    );
    let stdout = child.0.stdout.take().unwrap();
    let mut stdin = child.0.stdin.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let output = tx.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let message = line.ok().and_then(|s| serde_json::from_str(&s).ok());
            match message {
                Some(v) => {
                    if output.send(Event::Message(v)).is_err() {
                        return;
                    }
                }
                None => break,
            }
        }
        let _ = output.send(Event::End);
    });
    let (jobs, work) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for id in work {
            let response = match preview.snapshot() {
                Ok(data) => json!({"version":1,"id":id,"data":data}),
                Err(error) => json!({"version":1,"id":id,"error":format!("{error:#}")}),
            };
            if tx.send(Event::Snapshot(response)).is_err() {
                break;
            }
        }
    });
    while !stopped.load(Ordering::SeqCst) {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Event::Message(message)) => {
                ensure!(message["version"] == 1, "Unsupported preview protocol");
                match message["type"].as_str() {
                    Some("ready") => {
                        let url = message["url"].as_str().context("Missing preview URL")?;
                        println!("Local preview — not published: {url}\nPress Ctrl+C to stop. Reload the browser after editing proofs.toml.");
                        std::io::stdout().flush()?;
                        if !options.no_browser {
                            open_browser(url);
                        }
                    }
                    Some("snapshot") => jobs.send(message["id"].clone())?,
                    Some("error") => bail!("Preview server: {}", message["error"]),
                    _ => bail!("Invalid preview protocol message"),
                }
            }
            Ok(Event::Snapshot(response)) => {
                serde_json::to_writer(&mut stdin, &response)?;
                stdin.write_all(b"\n")?;
                stdin.flush()?;
            }
            Ok(Event::End) => bail!("Preview server exited unexpectedly"),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => bail!("Preview server disconnected"),
        }
    }
    Ok(())
}

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url).status();
    #[cfg(target_os = "windows")]
    let result = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .status();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = Command::new("xdg-open").arg(url).status();
    if !result.is_ok_and(|s| s.success()) {
        eprintln!("Could not open the browser; open {url} manually.");
    }
}

#[cfg(test)]
mod finding_tests {
    use super::*;
    #[test]
    fn published_findings_load_all_pages_and_reject_incomplete_lists() {
        let mut requests = vec![];
        let found = published_findings(12, |path| {
            requests.push(path.to_owned());
            Ok(if requests.len() == 1 {
                json!({"items":[{"id":"first"}],"next_cursor":"next-page"})
            } else {
                json!({"items":[{"id":"last"}],"next_cursor":null})
            })
        })
        .unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(
            requests,
            [
                "/api/v1/reports/12/findings",
                "/api/v1/reports/12/findings?cursor=next-page"
            ]
        );
        assert!(published_findings(12, |_| Ok(json!({"items":[],"next_cursor":"same"}))).is_err());
        assert!(published_findings(12, |_| Ok(json!({"items":[]}))).is_err());
        assert!(published_findings(12, |_| bail!("unavailable")).is_err());
    }
}
