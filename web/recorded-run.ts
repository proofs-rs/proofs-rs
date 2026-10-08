import { prop } from "./properties";
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const quote = (s: string) =>
  /^[a-zA-Z0-9_./:=+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;

export function renderRecordedRun(
  sarif: any,
  id: string,
  index: number,
  report: any,
  includeLogs = false,
) {
  const base = "/api/v1/runs/" + encodeURIComponent(id);
  const entry = sarif.runs[0],
    inv = entry.invocations[0],
    proofs = entry.properties.proofs;
  const source = entry.versionControlProvenance[0];
  // View-only projection of the one canonical SARIF record.
  const run = {
    ...proofs,
    command: [inv.executableLocation.uri, ...inv.arguments],
    source: {
      repository: source.repositoryUri,
      commit: source.revisionId,
    },
    working_directory: inv.workingDirectory.uri.replace(/\/$/, ""),
    execution_successful: inv.executionSuccessful,
    exit_code: inv.exitCode,
    started_at: inv.startTimeUtc,
    finished_at: inv.endTimeUtc,
    duration_ms: Date.parse(inv.endTimeUtc) - Date.parse(inv.startTimeUtc),
    environment: inv.environmentVariables,
  };
  const results = sarif.runs.flatMap((r: any) => r.results || []);
  const passed = results.filter((r: any) => r.kind === "pass").length;
  const failed = results.filter((r: any) => r.kind === "fail").length;
  const other = results.length - passed - failed;
  const dir = "report-" + report.id + "-source-" + (index + 1);
  const cwd =
    run.working_directory === "." ? dir : dir + "/" + run.working_directory;
  const environment = Object.entries(run.environment || {}).map(([k, v]) =>
    quote(k + "=" + v),
  );
  const command = (environment.length ? ["env", ...environment] : [])
    .concat(run.command.map(quote))
    .join(" ");
  const script = [
    `git clone -- ${quote(run.source.repository)} ${quote(dir)}`,
    `git -C ${quote(dir)} checkout --detach ${quote(run.source.commit)}`,
    `cd ${quote(cwd)}`,
    "",
    command,
  ].join("\n");
  const logs = includeLogs
    ? sarif.runs
        .flatMap((r: any) =>
          r.invocations.flatMap((inv: any) =>
            ["stdout", "stderr", "stdoutStderr"]
              .filter((name) => inv[name] !== undefined)
              .map(
                (name) =>
                  `=== ${name} ===\n${r.artifacts?.[inv[name].index]?.contents?.text ?? ""}`,
              ),
          ),
        )
        .join("\n")
    : "";
  const sourceURL = `${run.source.repository}/tree/${run.source.commit}`;
  const rows = results
    .map((r: any) => {
      const harness = r.properties?.harness || "";
      const contract = run.contracts.find((x: any) => x.harness === harness);
      const claims = contract
        ? report.claims.filter(
            (c: any) =>
              contract.api_paths.includes(c.display_path) &&
              contract.properties.includes(c.property),
          )
        : [];
      const place =
        r.locations?.[0]?.physicalLocation ||
        r.relatedLocations?.[0]?.physicalLocation;
      const loc = place
        ? `${place.artifactLocation?.uri || ""}${place.region?.startLine ? ":" + place.region.startLine : ""}`
        : r.properties?.location || "";
      const status =
        r.properties?.status ||
        (
          {
            pass: "Passed",
            fail: "Failed",
            open: "Undetermined",
            notApplicable: "Unreachable",
            informational: "Information",
          } as any
        )[r.kind] ||
        r.kind;
      return `<tr><td>${esc(r.message?.text || r.ruleId)}<div class="meta"><code>${esc(harness)}</code></div>${loc ? `<div class="meta"><code>${esc(loc)}</code></div>` : ""}</td><td>${esc(status)}</td><td>${claims.map((c: any) => `<a href="/claim/${encodeURIComponent(c.id)}?report_revision=${report.revision_no}">${esc(prop(c.property))}</a>`).join(" · ") || "—"}</td></tr>`;
    })
    .join("");
  const item = (label: string, value: any) =>
    `<dt>${esc(label)}</dt><dd class="plain-text">${esc(value)}</dd>`;
  return `<article class="recorded-run">${report.run_ids.length > 1 ? `<h3>Run ${index + 1}</h3>` : ""}<h3>Run locally</h3><pre><code>${esc(script)}</code></pre><p class="meta">Checks out the recorded source commit from GitHub. Install the report’s tool version before running.</p><p class="run-downloads"><a href="${esc(sourceURL)}">Source on GitHub</a> · <a href="${base}/sarif">SARIF with logs (.json)</a></p><h3>Recorded run</h3><p>${run.execution_successful ? "Completed" : "Unsuccessful"} · ${passed} checks passed · ${failed} failed${other ? ` · ${other} other` : ""}</p><p class="meta">${esc(run.started_at)} · ${(run.duration_ms / 1000).toFixed(1)} seconds · Exit code ${esc(run.exit_code ?? "unavailable")}</p><p class="meta">Recorded on the author’s machine.</p><table><thead><tr><th>Check</th><th>Result</th><th>Claim</th></tr></thead><tbody>${rows}</tbody></table><details><summary>Execution details</summary><dl>${item("Started", run.started_at)}${item("Finished", run.finished_at)}${item("Platform", run.platform)}${item("Rust compiler", run.rustc)}${item("Working directory", run.working_directory)}${item(
    "Environment overrides",
    Object.entries(run.environment || {})
      .map(([k, v]) => k + "=" + v)
      .join("\n") || "None recorded",
  )}${item("Git repository", run.source.repository)}${item("Git commit", run.source.commit)}</dl></details>${includeLogs ? `<details class="run-logs" id="logs"><summary>Diagnostics &amp; logs</summary><pre class="run-log-content">${esc(logs)}</pre></details>` : `<p><a href="/runs/${encodeURIComponent(id)}?report=${report.id}&amp;v=${report.revision_no}#logs">Diagnostics &amp; logs</a></p>`}</article>`;
}
