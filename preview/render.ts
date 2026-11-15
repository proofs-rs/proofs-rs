import { findingInput, z } from "../src/schemas";
import {
  resolveContract,
  checkAnchor,
  formalSourceLinks,
  specSourceLinks,
} from "../web/formal-evidence";
import { createViews } from "../src/site-views";
import { pageLayout } from "../web/page-layout";
import { claimTitle } from "../web/claim-title";
import { renderRecordedRun } from "../web/recorded-run";
import { renderDraftPreview } from "./draft";

interface RecordedSnapshot {
  mode?: "recorded";
  report: any;
  sarif: any;
  warnings: string[];
  server: string;
}
export interface DraftSnapshot {
  mode: "draft";
  report: any;
  sarif: null;
  warnings: string[];
  server: string;
}
export type Snapshot = RecordedSnapshot | DraftSnapshot;
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function previewPage(title: string, content: string, server: string) {
  return pageLayout(
    title,
    content,
    "Local preview",
    null,
    (p) => server + p,
    true,
  );
}
export function renderPreview(
  snapshot: Snapshot,
  path: string,
): { status: number; html: string } {
  if (snapshot.mode === "draft") {
    const page = renderDraftPreview(snapshot, path);
    return {
      status: page.status,
      html: previewPage(page.title, page.body, snapshot.server),
    };
  }
  // Enrich a copy: a later request must not inherit changes to a prior snapshot.
  const report = structuredClone(snapshot.report);
  report.toolchains_json = JSON.stringify([
    snapshot.sarif.runs[0].properties.proofs.toolchain ?? null,
  ]);
  const localOnly = snapshot.sarif.runs[0].properties.proofs.localOnly === true;
  if (localOnly) {
    report.evidence_url = "";
    for (const claim of report.claims) claim.evidence_url = "";
  }
  // Publication trims editorial strings before persisting them.
  const trimFields = (value: any, fields: string[]) => {
    for (const field of fields)
      if (typeof value[field] === "string") value[field] = value[field].trim();
  };
  const prose = [
    "title",
    "explanation",
    "trusted_assumptions",
    "limitations",
    "evidence_url",
  ];
  trimFields(report, [...prose, "environment"]);
  for (const claim of report.claims)
    trimFields(claim, [...prose, "precondition"]);
  report.claims = report.claims.map((claim: any) => ({
    ...claim,
    title: claimTitle(
      claim.title ?? "",
      claim.display_path,
      report.tool,
      report.tool_version,
    ),
    toolchain_json:
      claim.evidence_ref?.run_id ===
      snapshot.sarif.runs[0].automationDetails?.guid
        ? JSON.stringify(
            snapshot.sarif.runs[0].properties.proofs.toolchain ?? null,
          )
        : null,
    tool: report.tool,
    tool_version: report.tool_version,
    tool_version_id: report.tool_version_id,
    tool_limitations: report.tool_limitations,
    tool_limitations_updated_at: report.tool_limitations_updated_at,
    shared_trusted_assumptions: report.trusted_assumptions,
    shared_limitations: report.limitations,
  }));
  if (report.finding_drafts !== undefined) {
    const drafts = z.array(findingInput).max(20).parse(report.finding_drafts);
    report.findings = drafts.map((f, index) => ({
      ...f,
      id: `draft-${index + 1}`,
      draft: true,
      report_id: report.id,
      validity: "reported",
      upstream_status: "not_reported",
      duplicate_of: null,
      apis: report.finding_draft_apis?.[index] ?? [],
      links: [],
    }));
  }
  if (report.findings) {
    report.finding_count = report.withdrawn_at
      ? 0
      : report.findings.filter(
          (f: any) =>
            !f.withdrawn_at && !["invalid", "duplicate"].includes(f.validity),
        ).length;
  }
  const claimHref = (id: string) => `/claim/${encodeURIComponent(id)}`;
  const views = createViews(
    { user: null },
    { show_star_karma: false },
    () => "",
    {
      preview: true,
      external: (p) => snapshot.server + p,
      claim: claimHref,
    },
  );
  const warnings = snapshot.warnings.length
    ? `<aside aria-label="Preview warnings"><h2>Preview warnings</h2><ul>${snapshot.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></aside>`
    : "";
  const runId = report.run_ids[0];
  const run = (logs: boolean) =>
    renderRecordedRun(
      snapshot.sarif,
      runId,
      0,
      { ...report, id: report.id ?? "preview" },
      logs,
      {
        claim: claimHref,
        sarif: `/api/v1/runs/${encodeURIComponent(runId)}/sarif`,
        logs: `/runs/${encodeURIComponent(runId)}#logs`,
      },
    );
  let title = report.title;
  let status = 200;
  let body: string;
  if (path === "/" || path === "/report") {
    const revision =
      report.id == null
        ? "New report"
        : `Draft revision of report #${esc(report.id)} (based on v${esc(report.base_revision)})`;
    body = `${views.reportContent(report)}<p class="meta">${esc(report.crate)} ${esc(report.version)} · ${revision}</p>${views.reportOutline(report, true)}${views.reportBody(report, run(true), report.findings ? `<section id="findings" class="report-section"><h2>Findings (${report.finding_count})</h2>${report.findings.map((f: any) => views.findingItem(f, false, [], true)).join("")}</section>` : "", views.reportAPIs(report))}<p><a href="/runs/${encodeURIComponent(runId)}#logs">Open recorded run</a></p>`;
  } else if (path.startsWith("/finding/")) {
    const finding = report.findings?.find(
      (f: any) => `/finding/${encodeURIComponent(f.id)}` === path,
    );
    if (finding) {
      title = finding.title;
      body = `<p><a href="/report#finding-${encodeURIComponent(finding.id)}">← ${esc(report.title)}</a></p><h1>${esc(finding.title)}</h1>${views.findingItem(finding)}`;
    } else {
      status = 404;
      body =
        '<h1>Finding not found</h1><p><a href="/report">Return to report</a></p>';
    }
  } else if (path.startsWith("/claim/")) {
    const claim = report.claims.find((c: any) => claimHref(c.id) === path);
    if (claim) {
      if (claim.evidence_ref) {
        const contract = resolveContract(snapshot.sarif, runId, claim);
        if (contract?.spec) {
          const source = snapshot.sarif.runs[0].versionControlProvenance[0];
          claim.spec = {
            ...specSourceLinks(
              contract,
              source.repositoryUri,
              source.revisionId,
            ),
            check_url: `/runs/${encodeURIComponent(runId)}#${checkAnchor(contract.harness)}`,
          };
          if (localOnly) claim.spec.source_url = null;
        }
        if (contract?.formal) {
          const source = snapshot.sarif.runs[0].versionControlProvenance[0];
          claim.formal_evidence = {
            ...formalSourceLinks(
              contract.formal,
              source.repositoryUri,
              source.revisionId,
            ),
            check_url: `/runs/${encodeURIComponent(runId)}#${checkAnchor(contract.harness)}`,
          };
          if (localOnly) {
            claim.formal_evidence.source_url = null;
            for (const d of claim.formal_evidence.definitions)
              d.source_url = null;
          }
        }
      }
      title = claim.title;
      body = `<p><a href="/report">← ${esc(report.title)}</a></p>${views.claimContent(claim)}`;
    } else {
      status = 404;
      body =
        '<h1>Claim not found</h1><p>This claim is not in the current draft. <a href="/report">Return to report</a></p>';
    }
  } else if (path === `/runs/${encodeURIComponent(runId)}`) {
    title = "Recorded run";
    body = `<p><a href="/report">← ${esc(report.title)}</a></p><h1>Recorded run</h1>${run(true)}`;
  } else {
    status = 404;
    body =
      '<h1>Page not found</h1><p><a href="/report">Return to report</a></p>';
  }
  return { status, html: previewPage(title, warnings + body, snapshot.server) };
}
