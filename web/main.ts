import { prop } from "./properties";
import "../public/account-navigation.js";
import { renderAPICatalog } from "./api-catalog";
import { reproduceSection, bindReproduce } from "./reproduce";
import { legal } from "./legal";
const root = document.querySelector<HTMLElement>("#app")!;
let me: any = null,
  config: any = {},
  routeID = 0;
const esc = (v: any) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
const enc = encodeURIComponent;
const date = (v: string) =>
  v ? new Date(v).toISOString().replace("T", " ").replace(".000Z", " UTC") : "";
const user = (id: string, name: string) =>
  id
    ? `<a class="user-link" href="#/user/${enc(id)}">${esc(name || "ghost")}</a>`
    : "ghost";
const notice =
  '<p class="meta">By publishing, you agree to the <a href="#/terms">Terms</a> and license your original contribution under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. See our <a href="#/privacy">Privacy Policy</a>.</p>';
class NavigationChanged extends Error {}
async function request(
  path: string,
  method = "GET",
  body?: any,
  key?: string,
  navigationScoped = true,
  csrfToken = me?.csrf || "",
) {
  const generation = routeID;
  const r = await fetch(path.startsWith("/auth/") ? path : "/api/v1" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const v = await r.json();
  if (navigationScoped && generation !== routeID) throw new NavigationChanged();
  if (!r.ok) {
    if (r.status === 428) location.hash = "/terms-update";
    throw new Error(v.message || v.error || `Request failed (${r.status})`);
  }
  return v;
}
function error(e: unknown) {
  if (e instanceof NavigationChanged) return;
  let box = root.querySelector<HTMLElement>('[role="alert"]');
  if (!box) {
    box = document.createElement("p");
    box.role = "alert";
    root.prepend(box);
  }
  box.className = "error";
  box.textContent = e instanceof Error ? e.message : String(e);
}
function bind(selector: string, fn: (e: any) => any, event = "click") {
  root.querySelectorAll<HTMLElement>(selector).forEach((el) =>
    el.addEventListener(event, async (e) => {
      e.preventDefault();
      const button =
        el instanceof HTMLButtonElement
          ? el
          : el.querySelector<HTMLButtonElement>(
              'button[type="submit"],button:not([type])',
            );
      if (button) button.disabled = true;
      try {
        await fn(e);
      } catch (err) {
        error(err);
      } finally {
        if (button) button.disabled = false;
      }
    }),
  );
}
function current() {
  return new URL(location.hash.slice(1) || "/", "https://local");
}
function navigate(path: string) {
  if (location.hash === "#" + path) void route();
  else location.hash = path;
}
async function refreshMe() {
  me = await request("/me", "GET", undefined, undefined, false);
  await configReady.catch(() => {});
  window.proofsAccountNavigation(
    document.querySelector("#account-nav")!,
    me,
    "",
    async () => {
      await request("/auth/logout", "POST", {});
      await refreshMe();
      navigate("/");
    },
    error,
    config.show_star_karma === true,
  );
}

async function signup() {
  root.innerHTML = `<h1>Sign up</h1>${loading}`;
  let pending;
  try {
    pending = await request("/auth/signup");
  } catch (e) {
    if (e instanceof NavigationChanged) throw e;
    root.innerHTML =
      '<h1>Sign up</h1><p>Please <a href="/auth/github">sign in with GitHub</a> again to continue.</p>';
    throw e;
  }
  root.innerHTML = `<h1>Sign up</h1><p>Signed in with GitHub as <strong>${esc(pending.username)}</strong>. <a href="/auth/github?switch_account=1&amp;return_to=${enc(pending.return_to)}">Use another account</a></p><p>By signing up, you agree to the <a href="#/terms" target="_blank" rel="noopener">Terms</a> and acknowledge the <a href="#/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p><button id="signup">Sign up</button>`;
  bind("#signup", async () => {
    const result = await request(
      "/auth/signup",
      "POST",
      { terms_version: pending.terms_version },
      undefined,
      true,
      pending.csrf,
    );
    await refreshMe();
    location.hash = result.return_to.slice(1);
  });
}
function needUser() {
  if (!me?.user) {
    login();
    return false;
  }
  if (me.terms_required) {
    void termsUpdate();
    return false;
  }
  return true;
}
function claimItem(c: any) {
  return `<article class="claim-item"><a href="#/claim/${enc(c.id)}?report_revision=${c.report_revision}">Claim #${esc(c.claim_number)} — ${esc(c.title)}</a><div class="meta"><code>${esc(c.display_path)}</code> · ${prop(c.property)}${c.is_unsafe ? " · <strong>unsafe</strong>" : ""}${config.show_star_karma ? ` · ${c.star_count} stars` : ""}</div><p class="meta"><a href="#/report/${c.report_id}?v=${c.report_revision}">${esc(c.report_title)} · v${c.report_revision}</a>${config.show_star_karma ? ` · ${c.report_star_count} stars` : ""} · <a href="#/report/${c.report_id}?discussion=1">${c.report_comment_count} comments</a> · ${user(c.author_id, c.username)}${config.show_star_karma ? ` · ${c.author_karma} karma` : ""}${!c.in_current_report ? " · Removed from current report" : ""}${c.withdrawn_at ? " · Withdrawn" : ""}</p></article>`;
}
function reportItem(c: any) {
  return reportSummary(c);
}
function reportSummary(c: any, hideCrate = false) {
  return `<article class="claim-item"><a href="#/report/${c.id}">#${c.id} ${esc(c.title)}</a>${c.withdrawn_at ? " · Withdrawn" : ""}<div class="meta">${hideCrate ? "" : `${esc(c.crate)} ${esc(c.version)} · `}${esc(c.tool)} ${esc(c.tool_version)} · ${c.claim_count} claims</div><p class="meta">${user(c.author_id, c.username)}${config.show_star_karma ? ` · ${c.author_karma} karma` : ""}${config.show_star_karma ? ` · ${c.star_count} stars` : ""} · ${c.comment_count} comments · ${date(c.created_at)}</p></article>`;
}
function pager(data: any, fn: (cursor: number) => any, container: HTMLElement) {
  if (data.next_cursor !== null && data.next_cursor !== undefined) {
    const b = document.createElement("button");
    b.className = "pager";
    b.textContent = "More";
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn(data.next_cursor);
        b.remove();
      } catch (e) {
        error(e);
        b.disabled = false;
      }
    };
    container.append(b);
  }
}
async function claimsList(
  path: string,
  container: HTMLElement,
  cursor = 0,
  renderReport = reportItem,
) {
  await configReady;
  const data = await request(
    path + (path.includes("?") ? "&" : "?") + "cursor=" + cursor,
  );
  container.querySelector("[data-loading]")?.remove();
  container.insertAdjacentHTML(
    "beforeend",
    data.items
      .map(
        path.endsWith("/claims") || path === "/me/starred-claims"
          ? claimItem
          : renderReport,
      )
      .join("") || (!cursor ? "<p>No results.</p>" : ""),
  );
  pager(data, (n) => claimsList(path, container, n, renderReport), container);
}
const loading = '<p data-loading role="status">Loading…</p>';
async function adminCatalogs() {
  if (!needUser()) return;
  root.innerHTML = `<h1>Catalogs</h1><p>Reindex stored rustdoc snapshots to include all public callable APIs. Existing API IDs and claims are preserved.</p><div id="catalogs">${loading}</div>`;
  const data = await request("/admin/catalogs");
  root.querySelector("#catalogs")!.innerHTML = data.items.length
    ? `<ul>${data.items.map((item: any) => `<li>${esc(item.crate)} ${esc(item.version)} <button data-refresh="${item.id}">Refresh</button> <span id="catalog-${item.id}" role="status"></span></li>`).join("")}</ul>`
    : "<p>No imported catalogs.</p>";
  bind("[data-refresh]", async (event) => {
    const id = (event.currentTarget as HTMLElement).dataset.refresh!;
    const result = await request(
      `/admin/catalogs/${enc(id)}/refresh`,
      "POST",
      {},
    );
    root.querySelector(`#catalog-${id}`)!.textContent =
      `${result.indexed} indexed, ${result.added} added`;
  });
}
async function home() {
  const generation = routeID;
  root.innerHTML = `<section class="home-search"><h1>proofs.rs</h1><p>Verification reports and discussions for Rust APIs.</p><form id="search" class="searchbar"><input name="q" aria-label="Crate name" placeholder="Search crates"><button>Search</button></form></section><div class="home-columns${config.show_home_discussion ? "" : " home-single-column"}"><section><h2>Recent reports</h2><div id="home-reports">${loading}</div></section>${config.show_home_discussion ? `<section><h2>Latest discussion</h2><div id="home-discussion">${loading}</div></section>` : ""}</div>`;
  bind(
    "#search",
    (e) =>
      navigate("/crates?q=" + enc(new FormData(e.target).get("q") as string)),
    "submit",
  );
  const [d] = await Promise.all([request("/home"), configReady]);
  if (generation !== routeID) throw new NavigationChanged();
  if (config.show_home_discussion && !root.querySelector("#home-discussion")) {
    root.querySelector(".home-columns")!.classList.remove("home-single-column");
    root
      .querySelector(".home-columns")!
      .insertAdjacentHTML(
        "beforeend",
        `<section><h2>Latest discussion</h2><div id="home-discussion">${loading}</div></section>`,
      );
  }
  root.querySelector("#home-reports")!.innerHTML =
    d.reports.map(reportItem).join("") || "<p>No reports yet.</p>";
  if (config.show_home_discussion)
    root.querySelector("#home-discussion")!.innerHTML =
      d.discussion
        .map(
          (c: any) =>
            `<article class="home-entry"><a href="#/report/${c.report_id}?comment=${enc(c.id)}">Report #${c.report_id} · comment #${c.sequence_no}</a><p>${esc(c.body.slice(0, 200))}</p><p class="meta">${user(c.author_id, c.username)} · ${date(c.created_at)}</p></article>`,
        )
        .join("") || "<p>No comments yet.</p>";
}
async function crates() {
  const q = current().searchParams.get("q") || "";
  root.innerHTML = `<h1>Crates</h1><form id="search" class="searchbar"><input name="q" aria-label="Crate name" value="${esc(q)}"><button>Search</button></form><p id="crate-count" class="meta"><span data-loading>Loading…</span></p><div id="results"><div class="table-wrap"><table class="crate-list"><thead><tr><th>Crate</th><th class="numeric" title="Distinct API paths across versions with public reports">APIs</th><th class="numeric">Reports</th><th class="numeric">Claims</th><th>Updated</th></tr></thead><tbody id="crate-rows"></tbody></table></div></div>`;
  bind(
    "#search",
    (e) =>
      navigate("/crates?q=" + enc(new FormData(e.target).get("q") as string)),
    "submit",
  );
  const target = root.querySelector<HTMLElement>("#results")!;
  async function load(cursor: any = 0) {
    const d = await request(
      "/crates?q=" + enc(q) + "&cursor=" + enc(String(cursor)),
    );
    root.querySelector("#crate-count")!.textContent =
      (q ? `${d.matching_count} matching · ` : "") +
      `${d.total_count} ${d.total_count === 1 ? "crate" : "crates"} total`;
    root
      .querySelector("#crate-rows")!
      .insertAdjacentHTML(
        "beforeend",
        d.items
          .map(
            (c: any) =>
              `<tr><td><a href="#/crate/${enc(c.name)}">${esc(c.name)}</a></td><td class="numeric">${c.api_count}</td><td class="numeric">${c.report_count}</td><td class="numeric">${c.claim_count}</td><td><time datetime="${esc(c.updated_at)}" title="${date(c.updated_at)}">${esc(c.updated_at?.slice(0, 10) || "—")}</time></td></tr>`,
          )
          .join("") ||
          (!cursor ? '<tr><td colspan="5">No matching crates.</td></tr>' : ""),
      );
    pager(d, load, target);
  }
  await load();
}
type Crumb = { label: string; href: string };
function breadcrumbs(items: Crumb[]) {
  return `<div class="breadcrumbs" role="navigation" aria-label="Breadcrumb">${items.map(({ label, href }) => `<a href="${esc(href)}">${esc(label)}</a>`).join(' <span aria-hidden="true">/</span> ')} <span aria-hidden="true">/</span></div>`;
}
function crateHref(name: string, version: string) {
  return `#/crate/${enc(name)}?version=${enc(version)}`;
}
function crateCrumbs(c: any, section: "apis" | "reports"): Crumb[] {
  const href = crateHref(c.crate, c.version);
  return [
    { label: "crates", href: "#/crates" },
    { label: `${c.crate} ${c.version}`, href },
    {
      label: section === "apis" ? "APIs" : "reports",
      href: `${href}&section=${section}`,
    },
  ];
}
function claimCrumbs(c: any): Crumb[] {
  return [
    ...crateCrumbs(c, "reports"),
    {
      label: `Report #${c.report_id} v${c.report_revision}`,
      href: `#/report/${c.report_id}?v=${c.report_revision}`,
    },
  ];
}
async function cratePage(name: string) {
  const section = current().searchParams.get("section");
  const d = await request("/crates/" + enc(name) + "/releases");
  const version = current().searchParams.get("version") || d.default_version;
  root.innerHTML = `${breadcrumbs([{ label: "crates", href: "#/crates" }])}<h1>${esc(name)}${version ? " " + esc(version) : ""}</h1>${d.description ? `<p>${esc(d.description)}</p>` : ""}<p><a href="https://crates.io/crates/${enc(name)}${version ? "/" + enc(version) : ""}" target="_blank" rel="noopener noreferrer">crates.io</a></p>${version ? `<label>Version <select id="version" aria-label="Version">${d.items.map((r: any) => `<option value="${esc(r.version)}" ${r.version === version ? "selected" : ""}>${esc(r.version)}${r.yanked ? " (yanked)" : ""}</option>`).join("")}</select></label><h2 id="apis-heading" tabindex="-1">APIs</h2><div id="apis">${loading}</div><h2 id="reports-heading" tabindex="-1">Reports</h2><div id="crate-reports">${loading}</div>` : "<p>No published versions.</p>"}`;
  if (!version) return;
  root
    .querySelector("#version")!
    .addEventListener("change", (e) =>
      navigate(
        "/crate/" +
          enc(name) +
          "?version=" +
          enc((e.target as HTMLSelectElement).value) +
          (section === "apis" || section === "reports"
            ? "&section=" + section
            : ""),
      ),
    );
  const box = root.querySelector<HTMLElement>("#apis")!;
  async function load() {
    const data = await request(`/crates/${enc(name)}/${enc(version)}/apis`);
    box.innerHTML = renderAPICatalog(data.items, name);
    root.querySelector("#apis-heading")!.textContent =
      `APIs (${data.items.length})`;
  }
  async function loadReports() {
    const reports: any[] = [];
    let cursor: string | number | null = 0;
    do {
      const page = await request(
        `/crates/${enc(name)}/${enc(version)}/reports?cursor=${enc(String(cursor))}`,
      );
      reports.push(...page.items);
      cursor = page.next_cursor ?? null;
    } while (cursor !== null);
    root.querySelector("#reports-heading")!.textContent =
      `Reports (${reports.length})`;
    root.querySelector("#crate-reports")!.innerHTML =
      reports.map((report) => reportSummary(report, true)).join("") ||
      "<p>No results.</p>";
  }
  const results = await Promise.allSettled([load(), loadReports()]);
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  if (section === "apis" || section === "reports") {
    const heading = root.querySelector<HTMLElement>(`#${section}-heading`)!;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView();
  }
}
async function apiPage(id: string) {
  const a = await request("/apis/" + enc(id));
  root.innerHTML = `${breadcrumbs(crateCrumbs(a, "apis"))}<h1 class="code">${esc(a.display_path)}</h1>${a.is_unsafe ? "<p><strong>unsafe API — callers must uphold its safety requirements.</strong></p>" : ""}<pre class="signature">${esc(a.signature)}</pre><p><a href="${esc(a.upstream_url)}" target="_blank" rel="noopener noreferrer">Documentation on docs.rs</a></p><p class="meta">Target: ${esc(a.target)}. Catalogue uses the docs.rs build configuration.</p><p><a href="/book/publish-a-report.html">Publish a report</a></p><h2>Claims</h2><div id="claims"></div>`;
  await claimsList(
    "/apis/" + enc(id) + "/claims",
    root.querySelector("#claims")!,
  );
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
  return `<div class="star-controls">${
    me?.user
      ? `<button class="star" data-star="${kind}" data-id="${esc(c.id)}" data-on="${!!c.my_star}" aria-pressed="${!!c.my_star}">${c.my_star ? "★ Starred" : "☆ Star"}</button>`
      : `<a href="/auth/github">☆ Star</a>`
  } <a href="#/${kind}/${enc(c.id)}/stars">${c.star_count} stars</a></div>`;
}
function titleWithStars(kind: string, c: any) {
  return `<div class="title-row"><h1>${kind === "report" ? `Report #${esc(c.id)} — ` : `Claim #${esc(c.claim_number)} — `}${esc(c.title)}</h1>${starButton(kind, c)}</div>`;
}
async function starsPage(kind: string, id: string) {
  const item = await request(`/${kind}s/${enc(id)}`);
  root.innerHTML = `${breadcrumbs([...(kind === "claim" ? claimCrumbs(item) : crateCrumbs(item, "reports")), { label: kind === "report" ? `Report #${id} v${item.revision_no}` : `Claim #${item.claim_number}`, href: kind === "report" ? `#/report/${enc(id)}?v=${item.revision_no}` : `#/claim/${enc(id)}?report_revision=${item.report_revision}` }])}<h1>Stars</h1><div id="stargazers">${loading}</div>`;
  const container = root.querySelector<HTMLElement>("#stargazers")!;
  async function load(cursor: any = 0) {
    const data = await request(
      `/${kind}s/${enc(id)}/stars?cursor=${enc(cursor)}`,
    );
    container.querySelector("[data-loading]")?.remove();
    container.insertAdjacentHTML(
      "beforeend",
      data.items.length
        ? `<ul>${data.items.map((u: any) => `<li>${user(u.id, u.username)}</li>`).join("")}</ul>`
        : cursor === 0
          ? "<p>No stars yet.</p>"
          : "",
    );
    pager(data, load, container);
  }
  await load();
}
function bindStars() {
  bind("[data-star]", async (e) => {
    if (!needUser()) return;
    const b = e.currentTarget;
    await request(
      `/${b.dataset.star}s/${enc(b.dataset.id)}/star`,
      b.dataset.on === "true" ? "DELETE" : "PUT",
      {},
    );
    await refreshMe();
    await route();
  });
}
function toolLink(c: any) {
  const label = `${esc(c.tool)} ${esc(c.tool_version)}`;
  return c.tool_version_id
    ? `<a href="#/tool-version/${enc(c.tool_version_id)}">${label}</a>`
    : label;
}
function toolLimitations(c: any) {
  if (!c.tool_limitations) return "";
  return `<details class="tool-limitations"><summary>Tool limitations</summary><div class="tool-limitations-body"><p class="plain-text">${esc(c.tool_limitations)}</p>${c.tool_limitations_updated_at ? `<p class="meta">Updated ${date(c.tool_limitations_updated_at)}</p>` : ""}<p><a href="#/tool-version/${enc(c.tool_version_id)}">${esc(c.tool)} ${esc(c.tool_version)} — version details</a></p></div></details>`;
}
async function toolVersionPage(id: string) {
  const v = await request("/tool-versions/" + enc(id));
  root.innerHTML = `${breadcrumbs([
    { label: "Tools", href: "#/tools" },
    { label: v.tool, href: `#/tool/${enc(v.tool_id)}` },
  ])}<h1>${esc(v.tool)} ${esc(v.version)}</h1>${v.selectable ? "" : "<p>This version is retired from new submissions.</p>"}${v.limitations ? `<h2>Technical limitations</h2><p class="plain-text">${esc(v.limitations)}</p>${v.limitations_updated_at ? `<p class="meta">Updated ${date(v.limitations_updated_at)}</p>` : ""}` : ""}<h2>Reports</h2><div id="items">${loading}</div>`;
  await claimsList(
    "/tool-versions/" + enc(id) + "/reports",
    root.querySelector("#items")!,
  );
}
function reportContent(c: any, stars = false) {
  return `${stars ? titleWithStars("report", c) : `<h1>${esc(c.title)}</h1>`}<p class="report-tool">${toolLink(c)}</p>`;
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
                  `<a href="#/claim/${enc(claim.id)}?report_revision=${enc(String(claim.report_revision))}">Claim #${esc(claim.claim_number)}</a>`,
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
    <p><a href="#/api/${enc(c.api_item_id)}"><code>${esc(c.display_path)}</code></a> · ${esc(prop(c.property))}${c.is_unsafe ? " · <strong>unsafe</strong>" : ""}</p>
    <pre class="signature">${esc(c.signature)}</pre><p>Tool: ${toolLink(c)}</p>
    <section class="report-section"><h2>Preconditions</h2><p class="plain-text code">${esc(c.precondition || "None stated")}</p></section>
    ${c.explanation ? `<div class="report-explanation plain-text">${esc(c.explanation)}</div>` : ""}
    ${c.evidence_url ? `<section class="report-section"><h2>Evidence</h2><p><a href="${esc(c.evidence_url)}" target="_blank" rel="noopener noreferrer">${esc(c.evidence_url)}</a></p></section>` : ""}
    ${c.shared_trusted_assumptions || c.trusted_assumptions ? `<section class="report-section"><h2>What is trusted</h2>${claimScope(c.shared_trusted_assumptions, c.trusted_assumptions)}</section>` : ""}
    ${c.shared_limitations || c.limitations || c.tool_limitations ? `<section class="report-section report-limitations"><h2>Technical limitations</h2>${claimScope(c.shared_limitations, c.limitations)}${toolLimitations(c)}</section>` : ""}`;
}
async function claimPage(id: string) {
  const n = current().searchParams.get("report_revision");
  const c = await request(
    "/claims/" + enc(id) + (n ? "?report_revision=" + enc(n) : ""),
  );
  root.innerHTML = `${breadcrumbs(claimCrumbs(c))}${!c.in_current_report ? "<p><strong>This claim is not included in the current report.</strong></p>" : ""}${c.withdrawn_at ? "<p><strong>The report has been withdrawn.</strong></p>" : ""}${c.report_revision !== c.latest_report_revision ? `<p>From an earlier report revision. <a href="#/report/${c.report_id}">Current report →</a></p>` : ""}${claimContent(c, true)}<p><a href="#/report/${c.report_id}?v=${c.report_revision}&discussion=1">Read and join the discussion on the report →</a></p>`;
  bindStars();
}
let commentReply: any = null;
async function reportPage(id: number) {
  const requestedVersion = current().searchParams.get("v");
  const c = await request(
    requestedVersion
      ? `/reports/${id}/revisions/${enc(requestedVersion)}`
      : `/reports/${id}`,
  );
  const version = c.revision_no;
  const history = [{ revision_no: version }];
  commentReply = null;
  root.innerHTML = `${breadcrumbs(crateCrumbs(c, "reports"))}${reportContent(c, true)}<p class="meta">${user(c.author_id, c.username)}${config.show_star_karma ? ` · ${c.author_karma} karma` : ""} · ${date(c.created_at)}</p><p class="meta" id="revision-history">Revision ${history.map((v: any) => `<a href="#/report/${id}?v=${v.revision_no}">v${v.revision_no}</a>`).join(" · ")}${version !== c.latest_revision_no ? " · <strong>Past revision</strong>" : ""}</p>${c.withdrawn_at ? "<p><strong>Withdrawn by the author.</strong></p>" : ""}<div class="report-actions">${me.user?.id === c.author_id && !c.withdrawn_at ? ` · <button id="withdraw">Withdraw report</button>` : ""}</div>${reportBody(c)}${reportAPIs(c)}<section class="discussion" id="discussion"><h2>Comments (${c.comment_count})</h2><div class="thread-container" id="comments"></div><h3 id="reply-label">Add a comment</h3>${me.user ? `<form id="comment-form"><label>Report revision <select name="revision_no">${history.map((v: any) => `<option value="${v.revision_no}" ${v.revision_no === version ? "selected" : ""}>v${v.revision_no}</option>`).join("")}</select></label><textarea name="body" required maxlength="5000" aria-label="Comment"></textarea>${notice}<button>Post comment</button><button type="button" id="cancel-reply" hidden>Cancel reply</button></form>` : '<p><a href="/auth/github">Sign in to comment.</a></p>'}</section>`;
  const historyBox = root.querySelector<HTMLElement>("#revision-history")!;
  const revisionSelect = root.querySelector<HTMLSelectElement>(
    '[name="revision_no"]',
  );
  // History cannot block the report, comments, or comment form handlers.
  void (async () => {
    const revisions: any[] = [];
    let cursor: string | null = null;
    do {
      const page = await request(
        `/reports/${id}/revisions${cursor ? "?cursor=" + enc(cursor) : ""}`,
      );
      if (!historyBox.isConnected) return;
      revisions.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    historyBox.innerHTML = `Revision ${revisions.map((v: any) => `<a href="#/report/${id}?v=${v.revision_no}">v${v.revision_no}</a>`).join(" · ")}${version !== c.latest_revision_no ? " · <strong>Past revision</strong>" : ""}`;
    if (revisionSelect) {
      const selected = revisionSelect.value;
      revisionSelect.innerHTML = revisions
        .map(
          (v: any) =>
            `<option value="${v.revision_no}">v${v.revision_no}</option>`,
        )
        .join("");
      revisionSelect.value = selected;
    }
  })().catch(() => {
    if (historyBox.isConnected)
      historyBox.insertAdjacentHTML(
        "beforeend",
        " · History unavailable. Reload to retry.",
      );
  });
  bindReproduce(root, c);
  bindStars();
  bind("#withdraw", async () => {
    if (
      confirm("Withdraw this report? Its history and discussion remain public.")
    ) {
      await request(`/reports/${id}/withdrawal`, "PUT", {});
      await refreshMe();
      await route();
    }
  });
  if (current().searchParams.has("discussion"))
    root.querySelector("#discussion")?.scrollIntoView();
  const box = root.querySelector<HTMLElement>("#comments")!;
  const focus = current().searchParams.get("comment");
  if (focus) {
    const x = await request("/comments/" + enc(focus));
    if (x.report_id !== id)
      throw Error("This comment belongs to another report.");
    box.innerHTML = `<p>Linked thread · <a href="#/report/${id}?v=${version}">Show all comments</a></p>`;
    let parent = box;
    for (const cid of x.ancestors) {
      const row = cid === focus ? x : await request("/comments/" + enc(cid));
      const nested = renderComment(row, parent, id);
      parent = nested;
    }
    await loadComments(id, focus, parent);
    root.querySelector("#comment-" + CSS.escape(focus))?.scrollIntoView();
  } else await loadComments(id, null, box);
  const form = root.querySelector<HTMLFormElement>("#comment-form");
  if (form) {
    let key = crypto.randomUUID();
    bind(
      "#comment-form",
      async () => {
        const f = new FormData(form);
        await request(
          `/reports/${id}/comments`,
          "POST",
          {
            body: f.get("body"),
            revision_no: Number(f.get("revision_no")),
            reply_to_id: commentReply?.id || null,
          },
          key,
        );
        key = crypto.randomUUID();
        await route();
      },
      "submit",
    );
    bind("#cancel-reply", () => {
      commentReply = null;
      root.querySelector("#reply-label")!.textContent = "Add a comment";
      (root.querySelector("#cancel-reply") as HTMLElement).hidden = true;
    });
  }
}
async function loadComments(
  claimID: number,
  parentID: string | null,
  container: HTMLElement,
  cursor = 0,
) {
  const d = await request(
    `/reports/${claimID}/comments?cursor=${cursor}${parentID ? "&parent_id=" + enc(parentID) : ""}`,
  );
  for (const cm of d.items) {
    const child = renderComment(cm, container, claimID);
    if (cm.reply_count) await loadComments(claimID, cm.id, child);
  }
  if (!parentID && !d.items.length && !cursor)
    container.insertAdjacentHTML("beforeend", "<p>No comments.</p>");
  if (d.next_cursor !== null && d.next_cursor !== undefined)
    await loadComments(claimID, parentID, container, d.next_cursor);
}
function renderComment(cm: any, container: HTMLElement, claimID: number) {
  const article = document.createElement("article");
  article.className = "comment";
  article.id = "comment-" + cm.id;
  article.innerHTML = `<div class="comment-top">${user(cm.author_id, cm.username)} <time>${date(cm.created_at)}</time><a href="#/report/${claimID}?v=${cm.revision_no}&comment=${enc(cm.id)}">v${cm.revision_no} · #${cm.sequence_no}</a>${!cm.deleted_at && !cm.hidden ? `<span class="vote"><button data-vote="1" aria-label="Upvote" aria-pressed="${cm.my_vote === 1}">▲</button> ${cm.score} <button data-vote="-1" aria-label="Downvote" aria-pressed="${cm.my_vote === -1}">▼</button></span>` : ""}</div><div class="comment-content"><p class="preserve">${cm.deleted_at ? "<em>deleted comment</em>" : cm.hidden ? "<em>hidden comment</em>" : esc(cm.body)}</p>${cm.edited_at && !cm.deleted_at ? `<p class="meta">Edited ${date(cm.edited_at)}</p>` : ""}</div><div class="comment-actions">${me.user ? "<button data-reply>Reply</button>" : ""}${me.user?.id === cm.author_id && !cm.deleted_at && !cm.hidden ? "<button data-edit>Edit</button><button data-delete>Delete</button>" : ""}</div><div class="editor"></div>`;
  container.append(article);
  const children = document.createElement("div");
  children.className = "comment-children";
  container.append(children);
  const action = (sel: string, fn: (el: HTMLElement) => any) =>
    article.querySelectorAll<HTMLElement>(sel).forEach(
      (el) =>
        (el.onclick = async () => {
          try {
            await fn(el);
          } catch (e) {
            error(e);
          }
        }),
    );
  action("[data-reply]", () => {
    commentReply = cm;
    root.querySelector("#reply-label")!.textContent =
      `Reply to #${cm.sequence_no}`;
    const f = root.querySelector<HTMLFormElement>("#comment-form")!;
    (f.elements.namedItem("revision_no") as HTMLSelectElement).value = String(
      cm.revision_no,
    );
    (root.querySelector("#cancel-reply") as HTMLElement).hidden = false;
    (f.elements.namedItem("body") as HTMLTextAreaElement).focus();
  });
  action("[data-vote]", async (el) => {
    if (!needUser()) return;
    const v = Number(el.dataset.vote);
    await request(
      "/comments/" + cm.id + "/vote",
      cm.my_vote === v ? "DELETE" : "PUT",
      cm.my_vote === v ? undefined : { value: v },
    );
    await route();
  });
  action("[data-delete]", async () => {
    if (
      confirm("Delete this comment? Its previous text is retained privately.")
    ) {
      await request("/comments/" + cm.id, "DELETE", {
        edit_version: cm.edit_version,
      });
      await route();
    }
  });
  action("[data-edit]", () => {
    const box = article.querySelector<HTMLElement>(".editor")!;
    box.innerHTML = `<form><textarea name="body" required maxlength="5000" aria-label="Edit comment">${esc(cm.body)}</textarea>${notice}<button>Save</button> <button type="button">Cancel</button></form>`;
    box
      .querySelector('button[type="button"]')!
      .addEventListener("click", () => (box.innerHTML = ""));
    box.querySelector("form")!.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await request("/comments/" + cm.id, "PATCH", {
          body: new FormData(e.target as HTMLFormElement).get("body"),
          edit_version: cm.edit_version,
        });
        await route();
      } catch (e) {
        error(e);
      }
    };
  });
  return children;
}
function login() {
  root.innerHTML = `<h1>Sign in</h1>${config.oauth_configured ? '<p><a href="/auth/github">Sign in with GitHub</a></p>' : "<p>GitHub sign-in is currently unavailable.</p>"}`;
}
async function termsUpdate(returnTo = "/account") {
  if (!me.user) return login();
  root.innerHTML = `<h1>Updated terms</h1>${legal.terms.body}<p>Version: ${esc(config.terms_version)}</p><button id="agree">Agree and continue</button>`;
  bind("#agree", async () => {
    await request("/me/terms-acceptance", "POST", {
      version: config.terms_version,
    });
    await refreshMe();
    navigate(returnTo);
  });
}
async function activity(id: string, own = false) {
  const [u] = await Promise.all([request("/users/" + enc(id)), configReady]);
  root.innerHTML = `<h1>${esc(u.username)}</h1><p>${config.show_star_karma ? `${u.karma} karma · ` : ""}joined ${date(u.created_at)}</p><p><a href="https://github.com/${enc(u.username)}" rel="noopener noreferrer">GitHub profile</a></p><section id="reports"><h2>${own ? "My reports" : "Reports"}</h2><div id="claims"></div></section><section id="comments"><h2>${own ? "My comments" : "Comments"}</h2><div id="activity-comments"></div></section>${own && config.show_star_karma ? '<section id="starred-reports"><h2>Starred reports</h2><div id="activity-starred-reports"></div></section><section id="starred-claims"><h2>Starred claims</h2><div id="activity-starred-claims"></div></section>' : ""}`;
  await claimsList(
    own ? "/me/reports" : "/users/" + enc(u.id) + "/reports",
    root.querySelector("#claims")!,
  );
  await commentsList(
    own ? "/me/comments" : "/users/" + enc(u.id) + "/comments",
    root.querySelector("#activity-comments")!,
  );
  if (own && config.show_star_karma) {
    await claimsList(
      "/me/starred-reports",
      root.querySelector("#activity-starred-reports")!,
    );
    await claimsList(
      "/me/starred-claims",
      root.querySelector("#activity-starred-claims")!,
    );
  }
  if (own) {
    const section = current().searchParams.get("section");
    if (
      section &&
      ["reports", "comments", "starred-reports", "starred-claims"].includes(
        section,
      )
    )
      document.getElementById(section)?.scrollIntoView();
  }
}
async function commentsList(path: string, box: HTMLElement, cursor = 0) {
  const d = await request(path + "?cursor=" + enc(String(cursor)));
  box.insertAdjacentHTML(
    "beforeend",
    d.items
      .map(
        (x: any) =>
          `<article><p><a href="#/report/${x.report_id}?comment=${enc(x.id)}">Report #${x.report_id} · v${x.revision_no} · comment #${x.sequence_no}</a> · ${date(x.created_at)}</p><p class="preserve">${x.deleted_at ? "<em>deleted comment</em>" : esc(x.body)}</p></article>`,
      )
      .join("") || "<p>No comments.</p>",
  );
  pager(d, (n) => commentsList(path, box, n), box);
}
async function settings() {
  if (!me.user) return login();
  const p = await request("/me/notification-preferences");
  const tokens = await request("/me/tokens");
  root.innerHTML = `<h1>Settings</h1><h2>Account</h2><p>GitHub username: ${esc(me.user.username)}</p><p>Email: ${esc(me.email?.address || "Unavailable")}</p><p>Your GitHub username and verified primary email are refreshed when you sign in again.</p>${current().searchParams.get("email") === "retry" ? "<p>GitHub email lookup failed. Please sign in again to refresh your email.</p>" : ""}<h2>Email notifications</h2>${config.email_disabled ? "<p>Email notifications are currently disabled.</p>" : !config.email_configured ? "<p>Email delivery is currently unavailable.</p>" : ""}<form id="prefs"><p><label><input type="checkbox" name="replies" ${p.replies ? "checked" : ""}> Replies to my comments</label></p><p><label><input type="checkbox" name="report_comments" ${p.report_comments ? "checked" : ""}> Comments on my reports</label></p><button>Save preferences</button></form><h2>Tokens</h2>${tokens.items.length ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody>${tokens.items.map((t: any) => `<tr><td><code>${esc(t.id)}</code></td><td>${date(t.created_at)}</td><td>${t.last_used_at ? date(t.last_used_at) : "Never"}</td><td>${date(t.expires_at)}</td><td><button data-revoke="${esc(t.id)}">Revoke</button></td></tr>`).join("")}</tbody></table></div>` : "<p>No tokens.</p>"}<div id="revoke-confirm"></div><h2>Delete my account</h2><p>For account deletion, contact the operator through <a href="#/contact">Contact</a>.</p>`;

  bind("[data-revoke]", (e) => {
    const id = e.currentTarget.dataset.revoke;
    root.querySelector("#revoke-confirm")!.innerHTML =
      '<p>Revoke this token?</p><div class="form-actions"><button id="confirm-revoke">Revoke</button><button id="cancel-revoke">Cancel</button></div>';
    bind("#confirm-revoke", async () => {
      await request("/me/tokens/" + enc(id), "DELETE");
      await settings();
    });
    bind("#cancel-revoke", () => {
      root.querySelector("#revoke-confirm")!.innerHTML = "";
    });
  });
  bind(
    "#prefs",
    async (e) => {
      const f = new FormData(e.target);
      await request("/me/notification-preferences", "PATCH", {
        replies: f.has("replies"),
        report_comments: f.has("report_comments"),
      });
      await route();
    },
    "submit",
  );
}
async function devicePage() {
  const code = (current().searchParams.get("code") || "")
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "");
  const back = "/#/device" + (code ? "?code=" + code : "");
  const loginURL = "/auth/github?return_to=" + enc(back);
  if (!me.user) {
    root.innerHTML = `<h1>Sign in</h1><p><a href="${loginURL}">Continue with GitHub</a></p><p class="meta">By signing in, you agree to the <a href="#/terms">Terms</a>.</p>`;
    return;
  }
  if (me.terms_required) {
    await termsUpdate("/device" + (code ? "?code=" + code : ""));
    return;
  }
  const account = `<p>Signed in as <strong>${esc(me.user.username)}</strong>. <button class="link-button" id="switch-account">Use another account</button></p>`;
  if (!code) {
    root.innerHTML =
      account +
      `<p>Check the code:</p><form id="device-code-form"><label for="device-code" class="label">Code from your terminal</label><input id="device-code" name="code" autocomplete="off" maxlength="12" required><div class="form-actions"><button>Continue</button></div></form>`;
    bind(
      "#device-code-form",
      (e) =>
        navigate(
          "/device?code=" + enc(new FormData(e.target).get("code") as string),
        ),
      "submit",
    );
  } else {
    let d;
    try {
      d = await request("/auth/device/inspect", "POST", { user_code: code });
    } catch (e) {
      if (
        e instanceof Error &&
        ["expired_or_invalid_code", "invalid_user_code"].includes(e.message)
      ) {
        root.innerHTML =
          account +
          '<p>This code is invalid or has expired. Check your terminal or run <code>cargo proofs login</code> again.</p><p><a href="#/device">Enter another code</a></p>';
        bind("#switch-account", async () => {
          await request("/auth/logout", "POST", {});
          location.href = loginURL;
        });
        return;
      }
      throw e;
    }
    if (d.state !== "pending") {
      root.innerHTML =
        account +
        "<p>This request has already been used. Run <code>cargo proofs login</code> again.</p>";
    } else {
      root.innerHTML =
        account +
        `<p class="device-label">Check the code:</p><p class="device-code"><code>${esc(code.slice(0, 4) + "-" + code.slice(4))}</code></p><button id="device-authorize">Authorize</button>`;
      bind("#device-authorize", async () => {
        await request("/auth/device/approve", "POST", { user_code: code });
        root.innerHTML =
          '<h1>CLI connected</h1><p>Return to your terminal to continue. You can close this page.</p><p><a href="#/settings">Manage tokens</a></p>';
      });
    }
  }
  bind("#switch-account", async () => {
    await request("/auth/logout", "POST", {});
    location.href = loginURL;
  });
}
async function toolsPage(id?: string) {
  if (id) {
    const t = await request("/tools/" + enc(id));
    root.innerHTML = `${breadcrumbs([{ label: "Tools", href: "#/tools" }])}<h1>${esc(t.name)}</h1><p>${esc(t.description)}</p><p><a href="${esc(t.official_url)}" rel="noopener noreferrer">Tool website</a></p><h2>Supported versions</h2><ul>${t.versions.map((v: any) => `<li><a href="#/tool-version/${enc(v.id)}">${esc(v.version)}</a>${v.selectable ? "" : " (retired)"}</li>`).join("")}</ul><h2>Reports</h2><div id="items"></div>`;
    return claimsList(
      "/tools/" + enc(id) + "/reports",
      root.querySelector("#items")!,
    );
  }
  root.innerHTML = `<h1>Verification tools</h1><p><a href="https://github.com/proofs-rs/proofs-rs/blob/main/cli/README.md" target="_blank" rel="noopener noreferrer">CLI setup and usage instructions</a></p><div id="tool-list">${loading}</div><p><a href="https://github.com/proofs-rs/proofs-rs/issues/new">Request a tool or version</a></p>`;
  const d = await request("/tools");
  root.querySelector("#tool-list")!.innerHTML =
    d.items
      .map(
        (t: any) =>
          `<article><h2><a href="#/tool/${enc(t.id)}">${esc(t.name)}</a></h2><p>${esc(t.description)}</p></article>`,
      )
      .join("") || "<p>No tools have been registered yet.</p>";
}
async function unsubscribe() {
  const p = current().searchParams;
  root.innerHTML =
    '<h1>Unsubscribe</h1><p>Turn off all comment email notifications?</p><button id="unsubscribe">Unsubscribe</button>';
  bind("#unsubscribe", async () => {
    await request("/notifications/unsubscribe", "POST", {
      user: p.get("user"),
      signature: p.get("signature"),
    });
    root.innerHTML =
      "<h1>Unsubscribed</h1><p>You can re-enable notifications in your account settings.</p>";
  });
}
function pageShell(page: string | undefined, id: string | undefined) {
  // Only show headings known to remain after loading. All other titles depend on data or auth.
  root.innerHTML =
    page === "crate" && id ? `<h1>${esc(id)}</h1>${loading}` : loading;
}
let startupError: unknown = null;
const configReady = request("/config", "GET", undefined, undefined, false).then(
  (value) => {
    config = value;
  },
);
const startupReady = Promise.allSettled([configReady, refreshMe()]).then(
  (results) => {
    const failed = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failed) {
      startupError = failed.reason;
      document.querySelector("#account-nav")!.innerHTML =
        '<span>Account information unavailable. <a href="">Reload</a></span>';
    }
  },
);
async function route() {
  const generation = ++routeID;
  root.inert = false;
  root.setAttribute("aria-busy", "true");

  try {
    const parts = current()
        .pathname.split("/")
        .filter(Boolean)
        .map(decodeURIComponent),
      [p, id] = parts;
    if (p === "about" || p === "publish") {
      const target = p === "about" ? "/book/" : "/book/publish-a-report.html";
      root.innerHTML = `<p><a href="${target}">Continue in the Book</a></p>`;
      location.replace(target);
      return;
    }
    pageShell(p, id);
    const publicPage =
      !p ||
      [
        "crates",
        "crate",
        "api",
        "reports",
        "tools",
        "tool",
        "user",
        "unsubscribe",
      ].includes(p) ||
      p in legal;
    if (
      !publicPage &&
      !(["report", "claim"].includes(p) && parts[2] === "stars")
    ) {
      await startupReady;
      if (generation !== routeID) throw new NavigationChanged();
      if (startupError)
        throw Error(
          "Unable to load account information. Please reload the page.",
        );
    }
    if (!p) await home();
    else if (p === "crates" && id) {
      if (parts[3]) {
        const a = await request(
          "/resolve-api?" +
            new URLSearchParams({
              crate: id,
              version: parts[2],
              path: parts[3],
            }),
        );
        navigate("/api/" + a.id);
      } else
        navigate(
          "/crate/" + enc(id) + (parts[2] ? "?version=" + enc(parts[2]) : ""),
        );
    } else if (p === "crates") await crates();
    else if (p === "crate") await cratePage(id);
    else if (p === "api" && parts[2]) {
      const releases = await request("/crates/" + enc(id) + "/releases");
      const a = await request(
        "/resolve-api?" +
          new URLSearchParams({
            crate: id,
            version:
              current().searchParams.get("v") || releases.default_version || "",
            path: parts[2],
          }),
      );
      navigate("/api/" + a.id);
    } else if (p === "api") await apiPage(id);
    else if ((p === "report" || p === "claim") && parts[2] === "stars") {
      await configReady;
      if (generation !== routeID) throw new NavigationChanged();
      if (config.show_star_karma) await starsPage(p, id);
      else navigate(`/${p}/${enc(id)}`);
    } else if (p === "claim") await claimPage(id);
    else if (p === "report") await reportPage(Number(id));
    else if (p === "reports") {
      root.innerHTML = `<h1>Reports</h1><div id="reports">${loading}</div>`;
      await claimsList("/reports", root.querySelector("#reports")!);
    } else if (p === "login") login();
    else if (p === "signup") await signup();
    else if (p === "terms-update") await termsUpdate();
    else if (p === "user") await activity(id);
    else if (p === "account") {
      if (needUser()) await activity(me.user.id, true);
    } else if (
      [
        "my-reports",
        "my-comments",
        "my-starred-reports",
        "my-starred-claims",
      ].includes(p)
    ) {
      location.replace(
        config.show_star_karma || !p.startsWith("my-starred-")
          ? "#/account?section=" + p.slice(3)
          : "#/account",
      );
    } else if (p === "admin" && id === "catalogs") await adminCatalogs();
    else if (p === "settings") await settings();
    else if (p === "device") await devicePage();
    else if (p === "tool-version") await toolVersionPage(id);
    else if (p === "tools" || p === "tool") await toolsPage(id);
    else if (p === "unsubscribe") await unsubscribe();
    else if (p in legal)
      root.innerHTML = "<h1>" + esc(legal[p].title) + "</h1>" + legal[p].body;
    else root.innerHTML = "<h1>Page not found</h1>";
  } catch (e) {
    if (e instanceof NavigationChanged || generation !== routeID) return;
    root.querySelectorAll("[data-loading]").forEach((el) => el.remove());
    error(e);
  } finally {
    if (generation === routeID) {
      root.inert = false;
      root.setAttribute("aria-busy", "false");
    }
  }
}
document.addEventListener("click", (event) => {
  const link = (event.target as Element).closest?.(
    'a[href="/auth/github"]',
  ) as HTMLAnchorElement | null;
  if (link)
    link.href = "/auth/github?return_to=" + enc("/" + (location.hash || "#/"));
});
window.addEventListener("hashchange", () => void route());
void route();
