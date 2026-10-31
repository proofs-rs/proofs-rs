import { savedToolchainLabel } from "../web/toolchain-view";
import { validLeanSegments } from "../web/formal-evidence";
import { renderMarkdown } from "./markdown";
import { renderAPICatalog, signatureHTML } from "../web/api-catalog";

export interface ViewOptions {
  external?: (path: string) => string;
  claim?: (id: string, revision: unknown) => string;
  preview?: boolean;
  addIssue?: boolean;
}
type Crumb = { label: string; href: string };
export function createViews(
  me: any,
  config: any,
  action: (
    name: string,
    fields: Record<string, unknown>,
    label: string,
  ) => string,
  options: ViewOptions = {},
) {
  const enc = encodeURIComponent;
  const external = options.external ?? ((path: string) => path);
  const claimHref =
    options.claim ??
    ((id: string, revision: unknown) =>
      `/claim/${enc(id)}?report_revision=${enc(String(revision))}`);
  const apiHref = (id: string) =>
    options.preview && id.startsWith("preview-api-")
      ? null
      : external(`/api/${enc(id)}`);
  const esc = (v: any) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch]!,
    );
  // Plain text, since some callers place it in attributes. Minutes are enough.
  const date = (v: string) =>
    v ? new Date(v).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
  const user = (id: string, name: string) =>
    id
      ? `<a class="user-link" href="/user/${enc(id)}">${esc(name || "ghost")}</a>`
      : "ghost";
  const statusNames: Record<string, string> = {
    reported: "Reported",
    confirmed: "Confirmed",
    disputed: "Disputed",
    invalid: "Invalid",
    duplicate: "Duplicate",
    reported_upstream: "Reported upstream",
    fix_proposed: "Fix proposed",
    fix_merged: "Fix merged",
    released: "Released",
    wont_fix: "Won’t fix",
  };
  const statusTones: Record<string, string> = {
    confirmed: "good",
    fix_merged: "good",
    released: "good",
    disputed: "warn",
    invalid: "warn",
    duplicate: "warn",
    wont_fix: "warn",
  };
  const badge = (label: string, tone = "neutral") =>
    `<span class="badge badge-${tone}">${esc(label)}</span>`;
  const statusBadge = (status: string) =>
    badge(statusNames[status] ?? status, statusTones[status]);
  function claimItem(c: any) {
    return `<article class="claim-item"><a href="/claim/${enc(c.id)}?report_revision=${c.report_revision}">Claim #${esc(c.claim_number)} — ${esc(c.title)}</a><div class="meta"><code>${esc(c.display_path)}</code>${c.is_unsafe ? " · <strong>unsafe</strong>" : ""}${config.show_star_karma ? ` · ${c.star_count} stars` : ""}</div><p class="meta"><a href="/report/${c.report_id}?v=${c.report_revision}">${esc(c.report_title)} · v${c.report_revision}</a>${config.show_star_karma ? ` · ${c.report_star_count} stars` : ""} · <a href="/report/${c.report_id}#discussion">${plural(c.report_comment_count ?? 0, "comment")}</a> · ${user(c.author_id, c.username)}${config.show_star_karma ? ` · ${c.author_karma} karma` : ""}${!c.in_current_report ? " · Removed from current report" : ""}${c.withdrawn_at ? " · Withdrawn" : ""}</p></article>`;
  }
  const shortDate = (v: string) =>
    v
      ? `<time datetime="${esc(v)}" title="${date(v)}">${esc(new Date(v).toISOString().slice(0, 10))}</time>`
      : "";
  // Commit-hash versions (Aeneas) read like git's short hashes.
  const shortVersion = (v: string) =>
    /^[0-9a-f]{40}$/.test(v)
      ? `<span title="${esc(v)}">${esc(v.slice(0, 7))}</span>`
      : esc(v);
  const plural = (n: number, noun: string, nouns = noun + "s") =>
    `${n} ${n === 1 ? noun : nouns}`;
  function reportSummary(c: any, hideCrate = false) {
    const toolchainLabel = savedToolchainLabel(c);
    const meta = [
      hideCrate
        ? ""
        : `<a href="${crateHref(c.crate, c.version)}">${esc(c.crate)} ${esc(c.version)}</a>`,
      c.tool
        ? toolchainLabel
          ? c.tool_id
            ? `<a href="/reports?tool=${enc(c.tool_id)}">${esc(toolchainLabel)}</a>`
            : esc(toolchainLabel)
          : `${c.tool_id ? `<a href="/reports?tool=${enc(c.tool_id)}">${esc(c.tool)}</a>` : esc(c.tool)} ${shortVersion(c.tool_version ?? "")}`
        : "",
      plural(c.claim_count ?? 0, "claim"),
      c.dependency_count
        ? plural(
            c.dependency_count,
            "reviewed dependency",
            "reviewed dependencies",
          )
        : "",
      c.finding_count
        ? `<a href="/report/${c.id}#findings">${plural(c.finding_count, "finding")}</a>`
        : "",
      user(c.author_id, c.username),
      shortDate(c.created_at),
    ];
    return `<article class="claim-item"><a href="/report/${c.id}">#${c.id} ${esc(c.title)}</a>${c.withdrawn_at ? " " + badge("Withdrawn", "warn") : ""}<div class="meta">${meta.filter(Boolean).join(" · ")}</div></article>`;
  }
  function breadcrumbs(items: Crumb[]) {
    return `<div class="breadcrumbs" role="navigation" aria-label="Breadcrumb">${items.map(({ label, href }) => `<a href="${esc(href)}">${esc(label)}</a>`).join(' <span aria-hidden="true">/</span> ')} <span aria-hidden="true">/</span></div>`;
  }
  function crateHref(name: string, version: string) {
    return `/crate/${enc(name)}?version=${enc(version)}`;
  }
  function crateCrumbs(c: any, section: "apis" | "reports"): Crumb[] {
    const href = crateHref(c.crate, c.version);
    return [
      { label: "crates", href: "/crates" },
      { label: `${c.crate} ${c.version}`, href },
      {
        label: section === "apis" ? "APIs" : "reports",
        href: `${href}#${section}`,
      },
    ];
  }
  function claimCrumbs(c: any): Crumb[] {
    return [
      ...crateCrumbs(c, "reports"),
      {
        label: `Report #${c.report_id} v${c.report_revision}`,
        href: `/report/${c.report_id}?v=${c.report_revision}`,
      },
    ];
  }
  function field(label: string, value: any, code = false) {
    return value
      ? `<dt>${label}</dt><dd class="${code ? "code " : ""}preserve">${esc(value)}</dd>`
      : "";
  }
  function evidence(label: string, value: any) {
    return value
      ? `<dt>${label}</dt><dd><a href="${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(value)}</a></dd>`
      : "";
  }
  function starButton(kind: string, c: any) {
    if (options.preview || !config.show_star_karma) return "";
    const button = me.user
      ? action(
          "star",
          { kind, id: c.id, on: !c.my_star },
          c.my_star ? "★ Starred" : "☆ Star",
        )
      : `<a href="${esc(config.login_url || "/login")}">☆ Star</a>`;
    return (
      '<div class="star-controls">' +
      button +
      ' <a href="/' +
      kind +
      "/" +
      enc(c.id) +
      '/stars">' +
      c.star_count +
      " stars</a></div>"
    );
  }
  function titleWithStars(kind: string, c: any) {
    return `<div class="title-row"><h1>${kind === "report" ? `Report #${esc(c.id)} — ` : `Claim #${esc(c.claim_number)} — `}${esc(c.title)}</h1>${starButton(kind, c)}</div>`;
  }
  function toolLink(c: any) {
    const label = esc(savedToolchainLabel(c) ?? `${c.tool} ${c.tool_version}`);
    return c.tool_version_id
      ? `<a href="${esc(external(`/tool-version/${enc(c.tool_version_id)}`))}">${label}</a>`
      : label;
  }
  function toolLimitations(c: any) {
    if (!c.tool_limitations) return "";
    return `<details class="tool-limitations"><summary>${savedToolchainLabel(c) ? "Official base tool limitations" : "Tool limitations"}</summary><div class="tool-limitations-body"><p class="plain-text">${esc(c.tool_limitations)}</p>${c.tool_limitations_updated_at ? `<p class="meta">Updated ${date(c.tool_limitations_updated_at)}</p>` : ""}<p><a href="${esc(external(`/tool-version/${enc(c.tool_version_id)}`))}">${esc(c.tool)} ${esc(c.tool_version)} — version details</a></p></div></details>`;
  }
  function findingLinkLabel(link: {
    kind: string;
    url: string;
    version?: string | null;
    target_report_id?: number | null;
    target_revision_no?: number | null;
  }) {
    if (
      link.kind === "report" &&
      link.target_report_id &&
      link.target_revision_no
    )
      return `Report #${link.target_report_id} · v${link.target_revision_no}`;
    const kind =
      (
        {
          issue: "Issue",
          pr: "PR",
          commit: "Commit",
          release: "Release",
          report: "Report",
        } as Record<string, string>
      )[link.kind] ?? link.kind;
    let destination = link.url;
    try {
      const url = new URL(link.url);
      const github =
        url.hostname === "github.com"
          ? /^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)\/?$/.exec(url.pathname)
          : null;
      if (
        github &&
        ((link.kind === "pr" && github[3] === "pull") ||
          (link.kind === "issue" && github[3] === "issues"))
      )
        return `${kind} · ${github[1]}/${github[2]}#${github[4]}`;
      destination = url.host + url.pathname;
    } catch {
      // Keep historical links readable even if their URL cannot be parsed.
    }
    return `${kind} · ${destination}${link.version ? ` · ${link.version}` : ""}`;
  }
  function findingItem(
    f: any,
    editable = false,
    apis: any[] = [],
    compact = false,
    canReportIssue = editable,
  ) {
    const permalink = `/finding/${enc(f.id)}`;
    const needsIssue =
      canReportIssue &&
      f.github_issue_available === true &&
      !options.preview &&
      !f.draft &&
      !f.withdrawn_at &&
      !f.links.some((link: any) => link.kind === "issue" && !link.deleted_at);
    return `<article class="finding" id="finding-${esc(f.id)}"><h3><a href="${permalink}">${esc(f.title)}</a></h3>
      ${f.validity !== "reported" || f.upstream_status !== "not_reported" ? `<p class="meta">${statusBadge(f.validity)}${f.upstream_status !== "not_reported" ? ` ${statusBadge(f.upstream_status)}` : ""} (author reported)</p>` : ""}${f.withdrawn_at ? `<p class="meta">${badge("Report withdrawn", "warn")}</p>` : ""}
      ${f.apis.length ? `<p>${f.apis.map((a: any) => (a.unverified ? `<code>${esc(a.display_path)}</code> (API unverified)` : `<a href="${esc(external(`/api/${enc(a.id)}`))}"><code>${esc(a.display_path)}</code></a>`)).join(", ")}</p>` : ""}
      ${f.draft ? '<p class="meta">Local Finding draft · Not submitted</p>' : `<p class="meta">Found in <a href="${esc(external(`/report/${f.report_id}?v=${f.origin_revision_no}`))}">Report #${f.report_id} v${f.origin_revision_no}</a> · Updated ${date(f.updated_at)}</p>`}
      ${f.duplicate_of ? `<p>Duplicate of <a href="${esc(external(`/finding/${enc(f.duplicate_of)}`))}">${esc(f.duplicate_of)}</a></p>` : ""}
      ${needsIssue ? `<div class="form-actions finding-issue-actions"><a class="button-link" href="${permalink}/github-issue">Create GitHub issue</a> <span>or</span> <a class="button-link" href="${permalink}?add_issue=1#finding-link-${enc(f.id)}">Add issue URL</a></div>` : ""}
      ${
        compact
          ? ""
          : `
      ${f.links.length ? `<div class="finding-related-links"><h4>Related links</h4><ul class="finding-links">${f.links.map((l: any) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(findingLinkLabel(l))}</a>${editable ? action("delete-finding-link", { id: f.id, link_id: l.id, edit_version: f.edit_version, _back: permalink }, "Remove link") : ""}</li>`).join("")}</ul></div>` : ""}
      <div class="markdown-body">${renderMarkdown(f.body, 3)}</div>${f.evidence_url ? `<p><a href="${esc(f.evidence_url)}" target="_blank" rel="noopener noreferrer">Evidence</a></p>` : ""}
      ${f.draft ? "" : `<details><summary>Change history</summary>${f.events ? `<ol>${f.events.map((e: any) => `<li>v${e.edit_version} · ${esc(e.action)} · ${date(e.created_at)}<pre>${esc(JSON.stringify(JSON.parse(e.payload), null, 2))}</pre></li>`).join("")}</ol>` : `<p><a href="${esc(external(`/finding/${enc(f.id)}`))}">View full history</a></p>`}</details>`}
      ${editable ? `<details><summary>Edit</summary>${findingForm(f.report_id, f, apis)}</details><details id="finding-link-${esc(f.id)}"${options.addIssue ? " open" : ""}><summary>Add issue or PR link</summary>${findingLinkForm(f)}</details>` : ""}`
      } </article>`;
  }
  function findingForm(reportID: number, f?: any, apis: any[] = []) {
    const hidden = (name: string, value: unknown) =>
      `<input type="hidden" name="${name}" value="${esc(value)}">`;
    const select = (name: string, values: string[], current: string) =>
      `<label>${name === "validity" ? "Validity" : "Upstream status"}<select name="${name}">${values.map((value) => `<option${value === current ? " selected" : ""}>${value}</option>`).join("")}</select></label>`;
    return `<form method="post" action="/_actions/${f ? "edit-finding" : "finding"}" class="finding-form">${hidden("_csrf", me.csrf)}${hidden("_key", crypto.randomUUID())}${hidden("id", f?.id ?? reportID)}${hidden("_back", `/report/${reportID}#${f ? `finding-${f.id}` : "findings"}`)}${f ? hidden("edit_version", f.edit_version) : ""}
      <p>Summarize what you learned during verification. Markdown, code blocks and links are supported.</p>
      <label>Title<input name="title" required maxlength="1000" value="${esc(f?.title)}"></label>
      <label>Body (Markdown)<textarea name="body" required maxlength="10000">${esc(f?.body)}</textarea></label>
      <details><summary>Optional metadata</summary>
      <label>Evidence URL (optional)<input name="evidence_url" type="url" maxlength="2000" value="${esc(f?.evidence_url)}" placeholder="https://"></label>
      <label>APIs (optional; multiple allowed)<select multiple name="api_item_ids">${apis.map((a) => `<option value="${esc(a.id)}"${f?.apis.some((x: any) => x.id === a.id) ? " selected" : ""}>${esc(a.display_path)}</option>`).join("")}</select></label>
      ${f ? `${select("validity", ["reported", "confirmed", "disputed", "invalid", "duplicate"], f.validity)}${select("upstream_status", ["not_reported", "reported_upstream", "fix_proposed", "fix_merged", "released", "wont_fix"], f.upstream_status)}<label>Duplicate Finding ID<input name="duplicate_of" value="${esc(f.duplicate_of)}"></label><p>Statuses are author reported. Add a supporting link before selecting an upstream status. A release link needs a version.</p>` : ""}</details><button>${f ? "Save finding" : "Add finding"}</button></form>`;
  }
  function findingLinkForm(f: any) {
    return `<form method="post" action="/_actions/finding-link" class="finding-form"><input type="hidden" name="_csrf" value="${esc(me.csrf)}"><input type="hidden" name="_key" value="${crypto.randomUUID()}"><input type="hidden" name="id" value="${esc(f.id)}"><input type="hidden" name="edit_version" value="${f.edit_version}"><input type="hidden" name="_back" value="/report/${f.report_id}#finding-${esc(f.id)}"><label>Kind<select name="kind">${["issue", "pr", "commit", "release", "report"].map((k) => `<option>${k}</option>`).join("")}</select></label><label>HTTPS URL<input name="url" type="url" required maxlength="2000"></label><label>Fixed version (required for release)<input name="version" maxlength="100"></label><label>Revalidation Report ID (report links only)<input name="target_report_id" type="number" min="1"></label><label>Report revision (report links only)<input name="target_revision_no" type="number" min="1"></label><button>Add link</button></form>`;
  }
  function reportContent(c: any, stars = false) {
    return `${stars ? titleWithStars("report", c) : `<h1>${esc(c.title)}</h1>`}<p class="report-tool">${toolLink(c)}</p>${c.findings ? `<p class="report-outcome">${plural(c.claim_count ?? c.claims?.length ?? 0, "verified claim")} · ${plural(c.finding_count ?? 0, "finding")}</p>` : ""}${c.run_ids?.length ? `<p class="report-provenance meta">Recorded by the author; proofs.rs has not re-run it. <a href="${esc(external("/book/read-a-report.html"))}">How to read a report</a></p>` : ""}`;
  }
  // In-page links to the sections reportBody and the page actually render.
  function reportOutline(c: any, apis = false, comments?: number) {
    const links: [string, string][] = [
      ...(c.explanation ? [["overview", "Overview"] as [string, string]] : []),
      ...(c.findings ? [["findings", "Findings"] as [string, string]] : []),
      ...(apis ? [["apis", "APIs"] as [string, string]] : []),
      ...(c.evidence_url || c.run_ids?.length || c.environment
        ? [["evidence", "Evidence"] as [string, string]]
        : []),
      ...(c.trusted_assumptions
        ? [["trusted", "What is trusted"] as [string, string]]
        : []),
      ...(c.limitations || c.tool_limitations
        ? [["limitations", "Limitations"] as [string, string]]
        : []),
      ["dependencies", "Dependencies"],
      ...(comments === undefined
        ? []
        : [
            ["discussion", `Discussion · ${plural(comments, "comment")}`] as [
              string,
              string,
            ],
          ]),
    ];
    return `<nav class="report-outline" aria-label="On this page">${links.map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`).join(" · ")}</nav>`;
  }
  function reproduceSection(
    runIds: string[],
    environment?: string,
    recorded = "",
  ) {
    return runIds?.length || environment
      ? `<details class="reproduce" id="reproduce"><summary>Reproduce</summary><div class="reproduce-body">${recorded}</div>${environment ? `<details class="report-environment"><summary>Environment</summary><div class="markdown-body">${renderMarkdown(environment, 2)}</div></details>` : ""}</details>`
      : "";
  }
  function reportBody(c: any, recorded = "", findingsHTML = "", apisHTML = "") {
    return `${c.explanation ? `<section class="report-section report-explanation" id="overview"><h2>Overview</h2><div class="markdown-body">${renderMarkdown(c.explanation, 2)}</div></section>` : ""}
    ${findingsHTML}
    ${apisHTML}
    ${c.evidence_url || c.run_ids?.length || c.environment ? `<section class="report-section report-evidence" id="evidence"><h2>Evidence</h2>${c.evidence_url ? `<p><a href="${esc(c.evidence_url)}" target="_blank" rel="noopener noreferrer">${esc(c.evidence_url)}</a></p>` : ""}${reproduceSection(c.run_ids, c.environment, recorded)}</section>` : ""}
    ${c.trusted_assumptions ? `<section class="report-section" id="trusted"><h2>What is trusted</h2><div class="markdown-body">${renderMarkdown(c.trusted_assumptions, 2)}</div></section>` : ""}
    ${c.limitations || c.tool_limitations ? `<section class="report-section report-limitations" id="limitations"><h2>Technical limitations</h2>${c.limitations ? `<div class="markdown-body">${renderMarkdown(c.limitations, 2)}</div>` : ""}${toolLimitations(c)}</section>` : ""}
    ${reportDependencies(c)}
    `;
  }
  function reportDependencies(c: any) {
    const dependencies = c.direct_dependencies;
    const reviews = c.dependencies ?? [];
    const reportLink = (r: any) =>
      r.report != null && r.revision != null
        ? `<a href="${esc(external(`/report/${enc(String(r.report))}?v=${enc(String(r.revision))}`))}">Report #${esc(r.report)} · v${esc(r.revision)}</a>${r.reviewed ? " · reviewed" : ""}${r.withdrawn ? " · <strong>Withdrawn</strong>" : ""}`
        : '<span class="muted">—</span>';
    const catalog =
      dependencies == null
        ? '<p class="muted">Unable to load dependencies from crates.io.</p>'
        : dependencies.length
          ? `<div class="catalog-columns"><span>Crate</span><span>Reports</span></div>${dependencies.map((d: any) => `<div class="catalog-row"><span><a href="https://crates.io/crates/${enc(d.crate)}" target="_blank" rel="noopener noreferrer"><code>${esc(d.crate)}</code></a> <code>${esc(d.requirement)}</code>${d.kind !== "normal" ? ` · ${esc(d.kind)}` : ""}${d.optional ? " · optional" : ""}${d.target ? ` · <code>${esc(d.target)}</code>` : ""}</span><span class="api-claim-count${d.reports.length ? "" : " muted"}">${d.reports.length ? d.reports.map((r: any) => `${reportLink(r)} <span class="meta">(${esc(r.version)})</span>`).join("<br>") : "—"}</span></div>`).join("")}`
          : "<p>No direct dependencies.</p>";
    // Reviews may refer to transitive packages or a verification fork. Keep their
    // pinned evidence accessible without adding those packages to the direct list.
    const otherReviews = reviews.filter(
      (r: any) =>
        !dependencies?.some((d: any) =>
          d.reports.some(
            (p: any) =>
              p.reviewed && p.report === r.report && p.revision === r.revision,
          ),
        ),
    );
    return `<section class="report-section report-dependencies" id="dependencies"><h2>Dependencies${dependencies == null ? "" : ` (${dependencies.length})`}</h2>${catalog}${otherReviews.length ? `<details class="dependency-reviews"><summary>Other reviewed evidence (${otherReviews.length})</summary><ul>${otherReviews.map((r: any) => `<li><code>${esc(r.crate)} ${esc(r.version)}</code> · ${reportLink(r)}</li>`).join("")}</ul></details>` : ""}</section>`;
  }
  function reportAPIs(c: any) {
    const groups = new Map<string, any[]>();
    for (const claim of c.claims) {
      if (!groups.has(claim.api_item_id)) groups.set(claim.api_item_id, []);
      groups.get(claim.api_item_id)!.push(claim);
    }
    const apiMap = new Map<string, any>();
    const findingGroups = new Map<string, any[]>();
    for (const [id, claims] of groups) {
      apiMap.set(id, { ...claims[0], id, claim_count: claims.length });
    }
    for (const finding of c.findings ?? []) {
      for (const api of finding.apis ?? []) {
        // Unresolved paths are local identities, never catalog API IDs.
        const id = api.unverified ? `unresolved:${api.display_path}` : api.id;
        if (!id) continue;
        if (!apiMap.has(id)) apiMap.set(id, { ...api, id, claim_count: 0 });
        if (!findingGroups.has(id)) findingGroups.set(id, []);
        if (!findingGroups.get(id)!.some((f) => f.id === finding.id))
          findingGroups.get(id)!.push(finding);
      }
    }
    const apis = [...apiMap.values()].map((api) => ({
      ...api,
      signature: api.signature ?? "",
      origin: api.origin,
      kind:
        api.kind || (api.signature?.startsWith("impl") ? "method" : "function"),
    }));
    return `<section class="report-apis" id="apis"><h2>APIs (${apis.length})</h2>${renderAPICatalog(
      apis,
      c.crate,
      {
        hideEmpty: true,
        hideCounts: true,
        expandFamilies: true,
        apiHref: (id) => {
          if (apiMap.get(id).unverified) return null;
          if (!options.preview || id.startsWith("preview-api-"))
            return apiHref(id);
          const claim = groups.get(id)?.[0];
          return claim
            ? claimHref(claim.id, claim.report_revision)
            : apiHref(id);
        },
        details: (api) => {
          const claims = (groups.get(api.id) ?? []).map(
            (claim) =>
              `<a href="${esc(claimHref(claim.id, claim.report_revision))}">Claim #${esc(claim.claim_number)}</a>`,
          );
          const findings = (findingGroups.get(api.id) ?? []).map(
            (f) =>
              `<a href="/finding/${enc(f.id)}">Finding: ${esc(f.title)}</a>${f.validity !== "reported" ? ` ${statusBadge(f.validity)}` : ""}`,
          );
          return `<div class="report-api-claims"><span class="claim-links">${claims.join(", ")}</span>${findings.length ? `<span class="finding-links">${claims.length ? " · " : ""}${findings.join(", ")}</span>` : ""}</div>`;
        },
      },
    )}</section>`;
  }
  function claimScope(shared: string, individual: string, links = false) {
    const content = (value: string) =>
      links
        ? `<p><a href="${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(value)}</a></p>`
        : `<div class="markdown-body">${renderMarkdown(value, 2)}</div>`;
    return `${individual ? content(individual) : ""}${shared ? `<details class="claim-report-context"><summary>From the report</summary>${content(shared)}</details>` : ""}`;
  }
  function formalStatement(f: any) {
    const definitions = new Map<string, any>(
      f.definitions.map((d: any) => [d.name, d]),
    );
    const expression = (text: string, parts?: any[]) => {
      if (!validLeanSegments(text, parts)) return esc(text);
      return parts!
        .map((p) => {
          const definition = p.ref ? definitions.get(p.ref) : null;
          return definition?.source_url
            ? `<a href="${esc(definition.source_url)}" title="${esc(p.ref)}">${esc(p.text)}</a>`
            : esc(p.text);
        })
        .join("");
    };
    const roles: Record<string, string> = {
      variable: "for all",
      hypothesis: "assume",
      instance: "instance",
    };
    return `<section class="report-section formal-statement"><h2>Formal statement</h2><p><code>${esc(f.theorem)}</code></p>
      <div class="lean-readable">
        ${f.binders.map((b: any) => `<div class="lean-row"><span class="lean-role">${roles[b.kind]}</span><span class="lean-expression"><span class="lean-binding">${esc(b.name)} :</span> ${expression(b.type, b.type_segments)}</span></div>`).join("")}
        <div class="lean-row lean-conclusion"><span class="lean-role">then</span><span class="lean-expression">${expression(f.conclusion, f.conclusion_segments)}</span></div>
      </div>
      ${[f.conclusion, ...f.binders.map((b: any) => b.type)].some((s: string) => s.includes("↑")) ? '<p class="meta">In Lean notation, ↑ denotes an implicit type conversion (coercion).</p>' : ""}
      ${f.program ? `<h3>Target program</h3><pre><code>${esc(f.program)}</code></pre>` : ""}
      <details><summary>Complete Lean proposition</summary><button type="button" data-copy-formal>Copy proposition</button><span role="status" data-copy-status></span><pre tabindex="0"><code>${esc(f.statement)}</code></pre></details>
      <p>${f.source_url ? `<a href="${esc(f.source_url)}">Theorem source at recorded commit</a>` : "Theorem source is in the local snapshot"} · <a href="${esc(f.check_url)}">Recorded check</a></p>
      <details><summary>Referenced definitions (up to 100 direct references)</summary><ul>${f.definitions.map((d: any) => `<li>${d.source_url ? `<a href="${esc(d.source_url)}"><code>${esc(d.name)}</code></a>` : `<code>${esc(d.name)}</code> · ${esc(d.module)}`}</li>`).join("")}</ul>${f.definitions_truncated ? "<p>Reference limit reached; consult the full theorem source.</p>" : ""}</details>
      <p class="meta">Mapping: ${esc(f.mapping)}. Translation was not rerun by this recording.</p></section>`;
  }
  function claimContent(c: any, stars = false) {
    return `${stars ? titleWithStars("claim", c) : `<h1>Claim #${esc(c.claim_number)} — ${esc(c.title)}</h1>`}
    <p>${!c.unverified && apiHref(c.api_item_id) ? `<a href="${esc(apiHref(c.api_item_id))}"><code>${esc(c.display_path)}</code></a>` : `<code>${esc(c.display_path)}</code> · API unverified`}${c.is_unsafe ? " · <strong>unsafe</strong>" : ""}</p>
    ${c.origin === "recorded" ? `<p class="meta">Recorded callable · signature and safety not independently recorded.</p>` : `<pre class="signature">${signatureHTML(c.signature ?? "")}</pre>`}<p>Tool: ${toolLink(c)}</p>
    ${c.explanation ? `<section class="report-section report-explanation"><h2>Overview</h2><div class="markdown-body">${renderMarkdown(c.explanation, 2)}</div></section>` : options.preview ? '<p class="claim-explanation-missing" role="note"><strong>No claim explanation.</strong> Readers will rely on the report Overview to learn what this claim guarantees, under which conditions, and what it leaves unverified.</p>' : `<p class="claim-explanation-missing meta">This claim has no explanation of its own. ${c.report_id ? `Read the <a href="${esc(external(`/report/${enc(String(c.report_id))}#overview`))}">report Overview</a>, and treat` : "Treat"} the ${c.formal_evidence ? "formal statement" : "preconditions and evidence"} below as authoritative. See <a href="${esc(external("/book/concepts.html"))}">Concepts and terminology</a>.</p>`}
    <section class="report-section"><h2>Preconditions</h2><p class="plain-text code">${esc(c.precondition || (c.evidence_ref ? "See the formal statement, including input types and instances, for conditions." : "None stated"))}</p></section>
    ${c.formal_evidence ? formalStatement(c.formal_evidence) : ""}
    ${c.evidence_url ? `<section class="report-section"><h2>Evidence</h2><p><a href="${esc(c.evidence_url)}" target="_blank" rel="noopener noreferrer">${esc(c.evidence_url)}</a></p></section>` : ""}
    ${c.shared_trusted_assumptions || c.trusted_assumptions ? `<section class="report-section"><h2>What is trusted</h2>${claimScope(c.shared_trusted_assumptions, c.trusted_assumptions)}</section>` : ""}
    ${c.shared_limitations || c.limitations || c.tool_limitations ? `<section class="report-section report-limitations"><h2>Technical limitations</h2>${claimScope(c.shared_limitations, c.limitations)}${toolLimitations(c)}</section>` : ""}`;
  }
  return {
    esc,
    date,
    badge,
    statusBadge,
    user,
    breadcrumbs,
    crateCrumbs,
    claimCrumbs,
    claimItem,
    findingItem,
    findingForm,
    reportSummary,
    reportContent,
    reportBody,
    reportAPIs,
    reportOutline,
    reportDependencies,
    claimContent,
    toolLimitations,
  };
}
