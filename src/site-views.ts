import { prop } from "../web/properties";
import { renderAPICatalog } from "../web/api-catalog";

type Crumb = { label: string; href: string };
export function createViews(
  me: any,
  config: any,
  action: (
    name: string,
    fields: Record<string, unknown>,
    label: string,
  ) => string,
) {
  const enc = encodeURIComponent;
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
  const date = (v: string) =>
    v
      ? new Date(v).toISOString().replace("T", " ").replace(".000Z", " UTC")
      : "";
  const user = (id: string, name: string) =>
    id
      ? `<a class="user-link" href="/user/${enc(id)}">${esc(name || "ghost")}</a>`
      : "ghost";
  const notice =
    '<p class="meta">By publishing, you agree to the <a href="/terms">Terms</a> and license your original contribution under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. See our <a href="/privacy">Privacy Policy</a>.</p>';
  function claimItem(c: any) {
    return `<article class="claim-item"><a href="/claim/${enc(c.id)}?report_revision=${c.report_revision}">Claim #${esc(c.claim_number)} — ${esc(c.title)}</a><div class="meta"><code>${esc(c.display_path)}</code> · ${prop(c.property)}${c.is_unsafe ? " · <strong>unsafe</strong>" : ""}${config.show_star_karma ? ` · ${c.star_count} stars` : ""}</div><p class="meta"><a href="/report/${c.report_id}?v=${c.report_revision}">${esc(c.report_title)} · v${c.report_revision}</a>${config.show_star_karma ? ` · ${c.report_star_count} stars` : ""} · <a href="/report/${c.report_id}#discussion">${c.report_comment_count} comments</a> · ${user(c.author_id, c.username)}${config.show_star_karma ? ` · ${c.author_karma} karma` : ""}${!c.in_current_report ? " · Removed from current report" : ""}${c.withdrawn_at ? " · Withdrawn" : ""}</p></article>`;
  }
  function reportSummary(c: any, hideCrate = false) {
    return `<article class="claim-item"><a href="/report/${c.id}">#${c.id} ${esc(c.title)}</a>${c.withdrawn_at ? " · Withdrawn" : ""}<div class="meta">${hideCrate ? "" : `${esc(c.crate)} ${esc(c.version)} · `}${esc(c.tool)} ${esc(c.tool_version)} · ${c.claim_count} claims</div><p class="meta">${user(c.author_id, c.username)}${config.show_star_karma ? ` · ${c.author_karma} karma` : ""}${config.show_star_karma ? ` · ${c.star_count} stars` : ""} · ${c.comment_count} comments · ${date(c.created_at)}</p></article>`;
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
    if (!config.show_star_karma) return "";
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
    const label = `${esc(c.tool)} ${esc(c.tool_version)}`;
    return c.tool_version_id
      ? `<a href="/tool-version/${enc(c.tool_version_id)}">${label}</a>`
      : label;
  }
  function toolLimitations(c: any) {
    if (!c.tool_limitations) return "";
    return `<details class="tool-limitations"><summary>Tool limitations</summary><div class="tool-limitations-body"><p class="plain-text">${esc(c.tool_limitations)}</p>${c.tool_limitations_updated_at ? `<p class="meta">Updated ${date(c.tool_limitations_updated_at)}</p>` : ""}<p><a href="/tool-version/${enc(c.tool_version_id)}">${esc(c.tool)} ${esc(c.tool_version)} — version details</a></p></div></details>`;
  }
  function reportContent(c: any, stars = false) {
    return `${stars ? titleWithStars("report", c) : `<h1>${esc(c.title)}</h1>`}<p class="report-tool">${toolLink(c)}</p>`;
  }
  function reproduceSection(runIds: string[], environment?: string) {
    return runIds?.length || environment
      ? `<details class="reproduce" id="reproduce"><summary>Reproduce</summary><div class="reproduce-body"></div>${environment ? `<details class="report-environment"><summary>Environment</summary><p class="plain-text">${esc(environment)}</p></details>` : ""}</details>`
      : "";
  }
  function reportBody(c: any) {
    return `${c.explanation ? `<div class="report-explanation plain-text">${esc(c.explanation)}</div>` : ""}
    ${c.evidence_url || c.run_ids?.length || c.environment ? `<section class="report-section report-evidence"><h2>Evidence</h2>${c.evidence_url ? `<p><a href="${esc(c.evidence_url)}" target="_blank" rel="noopener noreferrer">${esc(c.evidence_url)}</a></p>` : ""}${reproduceSection(c.run_ids, c.environment)}</section>` : ""}
    ${c.trusted_assumptions ? `<section class="report-section"><h2>What is trusted</h2><p class="plain-text">${esc(c.trusted_assumptions)}</p></section>` : ""}
    ${c.limitations || c.tool_limitations ? `<section class="report-section report-limitations"><h2>Technical limitations</h2>${c.limitations ? `<p class="plain-text">${esc(c.limitations)}</p>` : ""}${toolLimitations(c)}</section>` : ""}
    `;
  }
  function reportAPIs(c: any) {
    const groups = new Map<string, any[]>();
    for (const claim of c.claims) {
      if (!groups.has(claim.api_item_id)) groups.set(claim.api_item_id, []);
      groups.get(claim.api_item_id)!.push(claim);
    }
    const apis = [...groups].map(([id, claims]) => ({
      ...claims[0],
      id,
      kind:
        claims[0].kind ||
        (claims[0].signature?.startsWith("impl") ? "method" : "function"),
      panic_count: claims.filter((c) => c.property === "panic_contract").length,
      no_ub_count: claims.filter((c) => c.property === "no_ub").length,
    }));
    return `<section class="report-apis"><h2>Verified APIs (${apis.length})</h2>${renderAPICatalog(
      apis,
      c.crate,
      {
        hideEmpty: true,
        hideCounts: true,
        expandFamilies: true,
        details: (api) =>
          `<div class="report-api-claims">${["panic_contract", "no_ub"]
            .map((property) => {
              const claims = groups
                .get(api.id)!
                .filter((claim) => claim.property === property);
              if (!claims.length) return "";
              return `<p class="report-api-claim"><span class="claim-property">${esc(prop(property))}</span><span class="claim-links">${claims
                .map(
                  (claim) =>
                    `<a href="/claim/${enc(claim.id)}?report_revision=${enc(String(claim.report_revision))}">Claim #${esc(claim.claim_number)}</a>`,
                )
                .join(", ")}</span></p>`;
            })
            .join("")}</div>`,
      },
    )}</section>`;
  }
  function claimScope(shared: string, individual: string, links = false) {
    const content = (value: string) =>
      links
        ? `<p><a href="${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(value)}</a></p>`
        : `<p class="plain-text">${esc(value)}</p>`;
    return `${individual ? content(individual) : ""}${shared ? `<details class="claim-report-context"><summary>From the report</summary>${content(shared)}</details>` : ""}`;
  }
  function claimContent(c: any, stars = false) {
    return `${stars ? titleWithStars("claim", c) : `<h1>Claim #${esc(c.claim_number)} — ${esc(c.title)}</h1>`}
    <p><a href="/api/${enc(c.api_item_id)}"><code>${esc(c.display_path)}</code></a> · ${esc(prop(c.property))}${c.is_unsafe ? " · <strong>unsafe</strong>" : ""}</p>
    <pre class="signature">${esc(c.signature)}</pre><p>Tool: ${toolLink(c)}</p>
    <section class="report-section"><h2>Preconditions</h2><p class="plain-text code">${esc(c.precondition || "None stated")}</p></section>
    ${c.explanation ? `<div class="report-explanation plain-text">${esc(c.explanation)}</div>` : ""}
    ${c.evidence_url ? `<section class="report-section"><h2>Evidence</h2><p><a href="${esc(c.evidence_url)}" target="_blank" rel="noopener noreferrer">${esc(c.evidence_url)}</a></p></section>` : ""}
    ${c.shared_trusted_assumptions || c.trusted_assumptions ? `<section class="report-section"><h2>What is trusted</h2>${claimScope(c.shared_trusted_assumptions, c.trusted_assumptions)}</section>` : ""}
    ${c.shared_limitations || c.limitations || c.tool_limitations ? `<section class="report-section report-limitations"><h2>Technical limitations</h2>${claimScope(c.shared_limitations, c.limitations)}${toolLimitations(c)}</section>` : ""}`;
  }
  return {
    esc,
    date,
    user,
    breadcrumbs,
    crateCrumbs,
    claimCrumbs,
    claimItem,
    reportSummary,
    reportContent,
    reportBody,
    reportAPIs,
    claimContent,
    toolLimitations,
  };
}
