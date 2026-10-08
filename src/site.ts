import type { Ctx } from "./core";
import { Fault, rows } from "./core";
import { legal } from "../web/legal";
import { renderAPICatalog } from "../web/api-catalog";
import { renderRecordedRun } from "../web/recorded-run";
import { reportDiscussion } from "./api";
import { createViews } from "./site-views";

export type SiteFetch = (request: Request) => Promise<Response>;
const enc = encodeURIComponent;
const escape = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const pageNames = new Set([
  "",
  "crates",
  "crate",
  "api",
  "reports",
  "report",
  "claim",
  "login",
  "signup",
  "terms-update",
  "user",
  "account",
  "my-reports",
  "my-comments",
  "my-starred-reports",
  "my-starred-claims",
  "admin",
  "settings",
  "device",
  "tool-version",
  "tools",
  "tool",
  "unsubscribe",
  "terms",
  "privacy",
  "contact",
  "about",
  "publish",
  "runs",
]);
export function isSitePage(path: string) {
  const parts = path.split("/").filter(Boolean);
  return (
    pageNames.has(parts[0] || "") &&
    !(parts[0] === "api" && ["v1", "docs"].includes(parts[1]))
  );
}
function safeBack(value: unknown) {
  const path = String(value || "/");
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path))
    return "/";
  const url = new URL(path, "https://local");
  return url.origin === "https://local" &&
    (isSitePage(url.pathname) ||
      url.pathname === "/book" ||
      url.pathname.startsWith("/book/"))
    ? url.pathname + url.search + url.hash
    : "/";
}
function localRequest(
  c: Ctx,
  path: string,
  method = "GET",
  body?: unknown,
  csrf = "",
  key?: string,
) {
  const headers = new Headers({ Cookie: c.req.header("cookie") || "" });
  if (method !== "GET") {
    headers.set("Origin", c.req.header("origin") || "");
    headers.set("X-CSRF-Token", csrf);
    headers.set("Content-Type", "application/json");
    if (key) headers.set("Idempotency-Key", key);
  }
  return new Request(
    new URL(path.startsWith("/auth/") ? path : "/api/v1" + path, c.req.url),
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}
function accountNavigation(c: Ctx, me: any) {
  const login =
    "/auth/github?return_to=" + enc(c.req.path + new URL(c.req.url).search);
  const stars = c.env.SHOW_STAR_KARMA === "true";
  return me.user
    ? `<details><summary>${escape(me.user.username)}</summary><div class="profile-menu"><a href="/account">My activity${stars ? ` (${escape(me.karma)} karma)` : ""}</a><a href="/settings">Settings</a>${me.user.role === "admin" ? '<a href="/admin/catalogs">Catalogs</a>' : ""}<form method="post" action="/_actions/logout"><input type="hidden" name="_csrf" value="${escape(me.csrf)}"><button>Sign out</button></form></div></details>`
    : `<div class="signin"><a href="${escape(login)}">Sign in with GitHub</a></div>`;
}
function layout(c: Ctx, title: string, body: string, me: any = { user: null }) {
  const account = accountNavigation(c, me);
  const canonical = new URL(
    c.req.path + new URL(c.req.url).search,
    c.env.APP_ORIGIN,
  ).href;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · proofs.rs</title><meta name="description" content="Rust API verification reports, claims and evidence."><link rel="canonical" href="${escape(canonical)}"><link rel="stylesheet" href="/style.css"><link rel="icon" href="/favicon.svg"><script src="/site.js" defer></script></head><body><header><a class="brand" href="/">proofs.rs</a><nav aria-label="Main navigation"><a href="/crates">Crates</a><a href="/reports">Reports</a><a href="/tools">Tools</a><a href="/book/publish-a-report.html">Publish</a><a href="/book/">About</a></nav><div id="account-nav">${account}</div></header><main id="app">${body}</main><footer>© 2026 proofs.rs · <a href="/book/">About</a> · <a href="https://github.com/proofs-rs/proofs-rs">GitHub</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/contact">Contact</a></footer></body></html>`;
}
export async function sitePage(c: Ctx, fetch: SiteFetch): Promise<Response> {
  c.header("Cache-Control", "private, no-store");
  const current = new URL(c.req.url);
  let me: any = { user: null };
  const get = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(localRequest(c, path, method, body, me.csrf));
    const value: any = await response.json();
    if (!response.ok)
      throw new Fault(
        response.status,
        value.error || "request_failed",
        value.message || value.error,
      );
    return value;
  };
  const result = (title: string, body: string, status = 200) =>
    new Response(layout(c, title, body, me), {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
  try {
    const parts = current.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          throw new Fault(400, "invalid_path");
        }
      });
    const [p = "", id] = parts;
    if (p === "about" || p === "publish")
      return c.redirect(
        p === "about" ? "/book/" : "/book/publish-a-report.html",
        302,
      );
    if (p.startsWith("my-"))
      return c.redirect("/account?section=" + enc(p.slice(3)), 302);
    me = await get("/me");
    const config = {
      show_star_karma: c.env.SHOW_STAR_KARMA === "true",
      show_home_discussion: c.env.SHOW_HOME_DISCUSSION === "true",
      login_url:
        "/auth/github?return_to=" + enc(current.pathname + current.search),
    };
    const back = current.pathname + current.search;
    const action = (
      name: string,
      fields: Record<string, unknown>,
      label: string,
      csrf = me.csrf || "",
    ) =>
      `<form class="inline-action" method="post" action="/_actions/${enc(name)}">${Object.entries(
        { _csrf: csrf, _back: back, ...fields },
      )
        .map(
          ([k, v]) =>
            `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`,
        )
        .join("")}<button>${escape(label)}</button></form>`;
    const v = createViews(me, config, action);
    const {
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
    } = v;
    const search = (q = "") =>
      `<form action="/crates" method="get" class="searchbar"><input name="q" value="${esc(q)}" aria-label="Crate name" placeholder="Search crates"><button>Search</button></form>`;
    const login = () =>
      result(
        "Sign in",
        `<h1>Sign in</h1>${c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET ? `<p><a href="/auth/github?return_to=${enc(p === "login" ? safeBack(current.searchParams.get("return_to") || "/account") : back)}">Sign in with GitHub</a></p>` : "<p>GitHub sign-in is currently unavailable.</p>"}`,
      );
    const pagination = (data: any, cursorName = "cursor") => {
      let html = "";
      if (current.searchParams.has(cursorName)) {
        const first = new URL(current);
        first.searchParams.delete(cursorName);
        html += `<a href="${esc(first.pathname + first.search)}">First page</a> `;
      }
      if (data.next_cursor !== null && data.next_cursor !== undefined) {
        const next = new URL(current);
        next.searchParams.set(cursorName, String(data.next_cursor));
        html += `<a rel="next" href="${esc(next.pathname + next.search)}">Next →</a>`;
      }
      return html
        ? `<nav class="pagination" aria-label="Pagination">${html}</nav>`
        : "";
    };
    const list = async (
      path: string,
      render: (item: any) => string = reportSummary,
      cursorName = "cursor",
    ) => {
      const url = new URL(path, "https://local");
      const cursor = current.searchParams.get(cursorName);
      if (cursor) url.searchParams.set("cursor", cursor);
      const data = await get(url.pathname + url.search);
      return (
        (data.items.map((item: any) => render(item)).join("") ||
          "<p>No results.</p>") + pagination(data, cursorName)
      );
    };
    if (p in legal) {
      const page = legal[p];
      return result(page.title, `<h1>${esc(page.title)}</h1>${page.body}`);
    }
    if (p === "login") return login();
    if (
      ["account", "settings", "terms-update", "admin"].includes(p) &&
      !me.user
    )
      return login();
    if (me.terms_required && ["account", "device", "admin"].includes(p))
      return c.redirect("/terms-update?return_to=" + enc(back), 302);
    if (!p) {
      const data = await get("/home");
      return result(
        "Rust API verification",
        `<section class="home-search"><h1>proofs.rs</h1><p>Verification reports and discussions for Rust APIs.</p>${search()}</section><div class="home-columns${config.show_home_discussion ? "" : " home-single-column"}"><section><h2>Recent reports</h2>${data.reports.map((item: any) => reportSummary(item)).join("") || "<p>No reports yet.</p>"}<p><a href="/reports">All reports →</a></p></section>${config.show_home_discussion ? `<section><h2>Latest discussion</h2>${data.discussion.map((cm: any) => `<article><a href="/report/${cm.report_id}?comment=${enc(cm.id)}#comment-${enc(cm.id)}">Report #${cm.report_id} · comment #${cm.sequence_no}</a><p>${esc(cm.body.slice(0, 200))}</p><p class="meta">${user(cm.author_id, cm.username)} · ${date(cm.created_at)}</p></article>`).join("") || "<p>No comments yet.</p>"}</section>` : ""}</div>`,
      );
    }
    if (p === "crates" && id) {
      if (parts[3]) {
        const a = await get(
          "/resolve-api?" +
            new URLSearchParams({
              crate: id,
              version: parts[2],
              path: parts[3],
            }),
        );
        return c.redirect("/api/" + enc(a.id), 302);
      }
      return c.redirect(
        "/crate/" + enc(id) + (parts[2] ? "?version=" + enc(parts[2]) : ""),
        302,
      );
    }
    if (p === "crates") {
      const q = current.searchParams.get("q") || "";
      const data = await get(
        "/crates?" +
          new URLSearchParams({
            q,
            cursor: current.searchParams.get("cursor") || "0",
          }),
      );
      return result(
        "Crates",
        `<h1>Crates</h1>${search(q)}<p class="meta">${q ? `${data.matching_count} matching · ` : ""}${data.total_count} crates total</p><div class="table-wrap"><table class="crate-list"><thead><tr><th>Crate</th><th>APIs</th><th>Reports</th><th>Claims</th><th>Updated</th></tr></thead><tbody>${data.items.map((item: any) => `<tr><td><a href="/crate/${enc(item.name)}">${esc(item.name)}</a></td><td>${item.api_count}</td><td>${item.report_count}</td><td>${item.claim_count}</td><td>${date(item.updated_at)}</td></tr>`).join("") || '<tr><td colspan="5">No matching crates.</td></tr>'}</tbody></table></div>${pagination(data)}`,
      );
    }
    if (p === "crate" && id) {
      const section = current.searchParams.get("section");
      if (section === "apis" || section === "reports") {
        current.searchParams.delete("section");
        return c.redirect(
          current.pathname + current.search + "#" + section,
          302,
        );
      }
      const releases = await get("/crates/" + enc(id) + "/releases");
      const version =
        current.searchParams.get("version") || releases.default_version;
      if (!version) throw new Fault(404, "crate_not_found");
      const apis = await get(`/crates/${enc(id)}/${enc(version)}/apis`);
      const reports = await list(
        `/crates/${enc(id)}/${enc(version)}/reports`,
        (x) => reportSummary(x, true),
      );
      return result(
        `${id} ${version}`,
        `${breadcrumbs([{ label: "crates", href: "/crates" }])}<h1>${esc(id)} ${esc(version)}</h1>${releases.description ? `<p>${esc(releases.description)}</p>` : ""}<p><a href="https://crates.io/crates/${enc(id)}/${enc(version)}">crates.io</a></p><details><summary>Versions (${releases.items.length})</summary><ul>${releases.items.map((r: any) => `<li><a href="/crate/${enc(id)}?version=${enc(r.version)}"${r.version === version ? ' aria-current="page"' : ""}>${esc(r.version)}${r.yanked ? " (yanked)" : ""}</a></li>`).join("")}</ul></details><h2 id="apis">APIs (${apis.items.length})</h2>${renderAPICatalog(apis.items, id)}<h2 id="reports">Reports</h2>${reports}`,
      );
    }
    if (p === "api" && id) {
      if (parts[2]) {
        const releases = await get("/crates/" + enc(id) + "/releases");
        const a = await get(
          "/resolve-api?" +
            new URLSearchParams({
              crate: id,
              version:
                current.searchParams.get("v") || releases.default_version || "",
              path: parts[2],
            }),
        );
        return c.redirect("/api/" + enc(a.id), 302);
      }
      const a = await get("/apis/" + enc(id));
      return result(
        a.display_path,
        `${breadcrumbs(crateCrumbs(a, "apis"))}<h1 class="code">${esc(a.display_path)}</h1>${a.is_unsafe ? "<p><strong>unsafe API — callers must uphold its safety requirements.</strong></p>" : ""}<pre class="signature">${esc(a.signature)}</pre><p><a href="${esc(a.upstream_url)}">Documentation on docs.rs</a></p><p class="meta">Target: ${esc(a.target)}. Catalogue uses the docs.rs build configuration.</p><p><a href="/book/publish-a-report.html">Publish a report</a></p><h2>Claims</h2>${await list("/apis/" + enc(id) + "/claims", claimItem)}`,
      );
    }
    if (p === "reports")
      return result("Reports", `<h1>Reports</h1>${await list("/reports")}`);
    if ((p === "report" || p === "claim") && id && parts[2] === "stars") {
      const item = await get(`/${p}s/${enc(id)}`);
      if (!config.show_star_karma) return c.redirect(`/${p}/${enc(id)}`, 302);
      return result(
        "Stars",
        `${breadcrumbs(p === "claim" ? claimCrumbs(item) : crateCrumbs(item, "reports"))}<h1>Stars</h1>${await list(`/${p}s/${enc(id)}/stars`, (u) => `<p>${user(u.id, u.username)}</p>`)}`,
      );
    }
    if (p === "claim" && id) {
      const revision = current.searchParams.get("report_revision");
      const item = await get(
        "/claims/" +
          enc(id) +
          (revision ? "?report_revision=" + enc(revision) : ""),
      );
      return result(
        `Claim #${item.claim_number} — ${item.title}`,
        `${breadcrumbs(claimCrumbs(item))}${!item.in_current_report ? "<p><strong>This claim is not included in the current report.</strong></p>" : ""}${item.withdrawn_at ? "<p><strong>The report has been withdrawn.</strong></p>" : ""}${item.report_revision !== item.latest_report_revision ? `<p>From an earlier report revision. <a href="/report/${item.report_id}">Current report →</a></p>` : ""}${claimContent(item, true)}<p><a href="/report/${item.report_id}?v=${item.report_revision}#discussion">Read and join the discussion on the report →</a></p>`,
      );
    }
    if (p === "report" && id) {
      const revision = current.searchParams.get("v");
      const item = await get(
        revision
          ? `/reports/${enc(id)}/revisions/${enc(revision)}`
          : `/reports/${enc(id)}`,
      );
      if (
        current.searchParams.has("comment") ||
        current.searchParams.has("discussion")
      ) {
        const commentID = current.searchParams.get("comment");
        if (commentID) {
          const comment = await get("/comments/" + enc(commentID));
          if (comment.report_id !== item.id)
            throw new Fault(400, "comment_report_mismatch");
        }
        current.searchParams.delete("comment");
        current.searchParams.delete("discussion");
        return c.redirect(
          current.pathname +
            current.search +
            (commentID ? "#comment-" + enc(commentID) : "#discussion"),
          302,
        );
      }
      const [history, comments] = await Promise.all([
        rows(
          c.env.DB,
          "SELECT revision_no,created_at FROM report_revisions WHERE report_id=? ORDER BY revision_no DESC",
          item.id,
        ),
        reportDiscussion(c.env.DB, item.id, me.user?.id),
      ]);
      let content = reportBody(item);
      if (item.run_ids.length) {
        // Parse one potentially large SARIF record at a time to bound Worker memory.
        const recorded: string[] = [];
        for (const [index, run] of (item.run_ids as string[]).entries()) {
          try {
            recorded.push(
              renderRecordedRun(
                await get(`/runs/${enc(run)}/sarif`),
                run,
                index,
                item,
              ),
            );
          } catch {
            recorded.push(
              `<p role="alert">Unable to load recorded run. <a href="/runs/${enc(run)}?report=${item.id}&amp;v=${item.revision_no}">View run</a></p>`,
            );
          }
        }
        content = content.replace(
          '<div class="reproduce-body"></div>',
          `<div class="reproduce-body">${recorded.join("")}</div>`,
        );
      }
      const byParent = new Map<string | null, any[]>();
      for (const cm of comments) {
        const key = cm.reply_to_id || null;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key)!.push(cm);
      }
      // Render an arbitrary-depth tree without recursive calls or per-thread database reads.
      const tasks: (string | any)[] = [...(byParent.get(null) || [])].reverse();
      const rendered: string[] = [];
      const seen = new Set<string>();
      while (tasks.length) {
        const cm = tasks.pop();
        if (typeof cm === "string") {
          rendered.push(cm);
          continue;
        }
        if (seen.has(cm.id)) continue;
        seen.add(cm.id);
        const anchor = "comment-" + enc(cm.id);
        const commentLink = `/report/${item.id}?v=${cm.revision_no}#${anchor}`;
        const controls =
          me.user && !cm.deleted_at && !cm.hidden
            ? `${[1, -1].map((value) => action("vote", { id: cm.id, value, on: cm.my_vote !== value }, value === 1 ? "▲" : "▼")).join("")} <a href="/report/${item.id}?v=${item.revision_no}&amp;reply=${enc(cm.id)}#comment-form">Reply</a>${me.user.id === cm.author_id ? ` <a href="/report/${item.id}?v=${item.revision_no}&amp;edit=${enc(cm.id)}#comment-form">Edit</a><details><summary>Delete</summary><p>Delete this comment? Its previous text is retained privately.</p>${action("delete-comment", { id: cm.id, edit_version: cm.edit_version }, "Confirm delete")}</details>` : ""}`
            : "";
        rendered.push(
          `<article class="comment" id="${esc("comment-" + cm.id)}"><div class="comment-top">${user(cm.author_id, cm.username)} <time>${date(cm.created_at)}</time> <a href="${commentLink}">v${cm.revision_no} · #${cm.sequence_no}</a> <span>${cm.score}</span></div><div class="comment-content"><p class="preserve">${cm.deleted_at ? "<em>deleted comment</em>" : cm.hidden ? "<em>hidden comment</em>" : esc(cm.body)}</p>${cm.edited_at ? '<p class="meta">Edited ' + date(cm.edited_at) + "</p>" : ""}</div><div class="comment-actions">${controls}</div></article><div class="comment-children">`,
        );
        tasks.push("</div>");
        tasks.push(...(byParent.get(cm.id) || []).slice().reverse());
      }
      let form = "";
      if (me.user && !me.terms_required) {
        const editID = current.searchParams.get("edit"),
          replyID = current.searchParams.get("reply");
        const editing = editID
          ? comments.find((x) => x.id === editID)
          : undefined;
        const replying = replyID
          ? comments.find((x) => x.id === replyID)
          : undefined;
        if (
          editID &&
          (!editing ||
            editing.author_id !== me.user.id ||
            editing.hidden ||
            editing.deleted_at)
        )
          throw new Fault(403, "comment_edit_forbidden");
        if (replyID && (!replying || replying.hidden || replying.deleted_at))
          throw new Fault(400, "invalid_reply");
        form = `<h3>${editing ? "Edit comment" : replying ? "Reply to #" + replying.sequence_no : "Add a comment"}</h3><form method="post" action="/_actions/${editing ? "edit-comment" : "comment"}" id="comment-form"><input type="hidden" name="_csrf" value="${esc(me.csrf)}"><input type="hidden" name="_back" value="/report/${item.id}?v=${item.revision_no}#discussion"><input type="hidden" name="id" value="${esc(editing?.id || item.id)}"><input type="hidden" name="edit_version" value="${editing?.edit_version || 0}"><input type="hidden" name="reply_to_id" value="${esc(replying?.id || "")}"><input type="hidden" name="_key" value="${crypto.randomUUID()}">${editing ? "" : `<label>Report revision <select name="revision_no">${history.map((h) => `<option value="${h.revision_no}"${h.revision_no === (replying?.revision_no || item.revision_no) ? " selected" : ""}>v${h.revision_no}</option>`).join("")}</select></label>`}<textarea name="body" required maxlength="5000" aria-label="Comment">${esc(editing?.body || "")}</textarea><p class="meta">By publishing, you agree to the <a href="/terms">Terms</a> and license your original contribution under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. See our <a href="/privacy">Privacy Policy</a>.</p><button>${editing ? "Save" : "Post comment"}</button>${editing || replying ? ` <a href="/report/${item.id}?v=${item.revision_no}#discussion">Cancel</a>` : ""}</form>`;
      } else
        form = me.terms_required
          ? '<p><a href="/terms-update">Accept updated terms to comment.</a></p>'
          : '<p><a href="/auth/github?return_to=' +
            enc(back) +
            '">Sign in to comment.</a></p>';
      return result(
        `Report #${item.id} — ${item.title}`,
        `${breadcrumbs(crateCrumbs(item, "reports"))}${reportContent(item, true)}<p class="meta">${user(item.author_id, item.username)} · ${date(item.created_at)}</p><p class="meta" id="revision-history">Revision ${history.map((h) => `<a href="/report/${item.id}?v=${h.revision_no}"${h.revision_no === item.revision_no ? ' aria-current="page"' : ""}>v${h.revision_no}</a>`).join(" · ")}${item.revision_no !== item.latest_revision_no ? " · <strong>Past revision</strong>" : ""}</p>${item.withdrawn_at ? "<p><strong>Withdrawn by the author.</strong></p>" : ""}${me.user?.id === item.author_id && !item.withdrawn_at ? `<details><summary>Withdraw report</summary><p>Withdraw this report? Its history and discussion remain public.</p>${action("withdraw", { id: item.id }, "Confirm withdrawal")}</details>` : ""}${content}${reportAPIs(item)}<section id="discussion" class="discussion"><h2>Comments (${item.comment_count})</h2>${rendered.join("") || "<p>No comments.</p>"}${form}</section>`,
      );
    }
    if (p === "runs" && id) {
      const report = current.searchParams.get("report");
      if (!report) throw new Fault(400, "report_required");
      const revision = current.searchParams.get("v");
      const item = await get(
        revision
          ? `/reports/${enc(report)}/revisions/${enc(revision)}`
          : `/reports/${enc(report)}`,
      );
      if (!item.run_ids.includes(id)) throw new Fault(404, "run_not_in_report");
      return result(
        "Recorded run",
        `<h1>Recorded run</h1>${renderRecordedRun(await get(`/runs/${enc(id)}/sarif`), id, item.run_ids.indexOf(id), item, true)}`,
      );
    }
    if (p === "tools") {
      const tools = await get("/tools");
      return result(
        "Verification tools",
        `<h1>Verification tools</h1><p><a href="https://github.com/proofs-rs/proofs-rs/blob/main/cli/README.md">CLI setup and usage instructions</a></p>${tools.items.map((t: any) => `<article><h2><a href="/tool/${enc(t.id)}">${esc(t.name)}</a></h2><p>${esc(t.description)}</p></article>`).join("") || "<p>No tools have been registered yet.</p>"}<p><a href="https://github.com/proofs-rs/proofs-rs/issues/new">Request a tool or version</a></p>`,
      );
    }
    if (p === "tool" && id) {
      const t = await get("/tools/" + enc(id));
      return result(
        t.name,
        `${breadcrumbs([{ label: "Tools", href: "/tools" }])}<h1>${esc(t.name)}</h1><p>${esc(t.description)}</p><p><a href="${esc(t.official_url)}">Tool website</a></p><h2>Supported versions</h2><ul>${t.versions.map((r: any) => `<li><a href="/tool-version/${enc(r.id)}">${esc(r.version)}</a>${r.selectable ? "" : " (retired)"}</li>`).join("")}</ul><h2>Reports</h2>${await list(`/tools/${enc(id)}/reports`)}`,
      );
    }
    if (p === "tool-version" && id) {
      const t = await get("/tool-versions/" + enc(id));
      return result(
        `${t.tool} ${t.version}`,
        `${breadcrumbs([
          { label: "Tools", href: "/tools" },
          { label: t.tool, href: "/tool/" + enc(t.tool_id) },
        ])}<h1>${esc(t.tool)} ${esc(t.version)}</h1>${t.selectable ? "" : "<p>This version is retired from new submissions.</p>"}${t.limitations ? `<h2>Technical limitations</h2><p class="plain-text">${esc(t.limitations)}</p>${t.limitations_updated_at ? `<p class="meta">Updated ${date(t.limitations_updated_at)}</p>` : ""}` : ""}<h2>Reports</h2>${await list(`/tool-versions/${enc(id)}/reports`)}`,
      );
    }
    if ((p === "user" && id) || p === "account") {
      const own = p === "account";
      const u = await get("/users/" + enc(own ? me.user.id : id));
      const prefix = own ? "/me" : "/users/" + enc(u.id);
      const sections = [
        "reports",
        "comments",
        ...(own && config.show_star_karma
          ? ["starred-reports", "starred-claims"]
          : []),
      ];
      const content = await Promise.all(
        sections.map(async (section) => {
          const render =
            section === "comments"
              ? (cm: any) =>
                  `<article><p><a href="/report/${cm.report_id}?v=${cm.revision_no}#comment-${enc(cm.id)}">Report #${cm.report_id} · v${cm.revision_no} · comment #${cm.sequence_no}</a> · ${date(cm.created_at)}</p><p class="preserve">${esc(cm.body)}</p></article>`
              : section === "starred-claims"
                ? claimItem
                : reportSummary;
          const label =
            section === "reports"
              ? own
                ? "My reports"
                : "Reports"
              : section === "comments"
                ? own
                  ? "My comments"
                  : "Comments"
                : section === "starred-reports"
                  ? "Starred reports"
                  : "Starred claims";
          return `<section id="${section}"><h2>${label}</h2>${await list(prefix + "/" + section, render, section + "_cursor")}</section>`;
        }),
      );
      return result(
        u.username,
        `<h1>${esc(u.username)}</h1><p>${config.show_star_karma ? `${u.karma} karma · ` : ""}joined ${date(u.created_at)}</p><p><a href="https://github.com/${enc(u.username)}">GitHub profile</a></p>${content.join("")}`,
      );
    }

    if (p === "settings") {
      const [prefs, tokens] = await Promise.all([
        get("/me/notification-preferences"),
        get("/me/tokens"),
      ]);
      return result(
        "Settings",
        `<h1>Settings</h1><h2>Account</h2><p>GitHub username: ${esc(me.user.username)}</p><p>Email: ${esc(me.email?.address || "Unavailable")}</p><p>Your GitHub username and verified primary email are refreshed when you sign in again.</p>${current.searchParams.get("email") === "retry" ? "<p>GitHub email lookup failed. Please sign in again to refresh your email.</p>" : ""}<h2>Email notifications</h2>${c.env.EMAIL_DISABLED === "true" ? "<p>Email notifications are currently disabled.</p>" : !(c.env.EMAIL && c.env.EMAIL_FROM) ? "<p>Email delivery is currently unavailable.</p>" : ""}<form method="post" action="/_actions/preferences"><input type="hidden" name="_csrf" value="${esc(me.csrf)}"><label><input type="checkbox" name="replies"${prefs.replies ? " checked" : ""}>Replies to my comments</label><label><input type="checkbox" name="report_comments"${prefs.report_comments ? " checked" : ""}>Comments on my reports</label><button>Save preferences</button></form><h2>Tokens</h2>${tokens.items.length ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody>${tokens.items.map((t: any) => `<tr><td><code>${esc(t.id)}</code></td><td>${date(t.created_at)}</td><td>${date(t.last_used_at) || "Never"}</td><td>${date(t.expires_at)}</td><td><details><summary>Revoke</summary><p>Revoke this token?</p>${action("revoke", { id: t.id }, "Confirm revoke")}</details></td></tr>`).join("")}</tbody></table></div>` : "<p>No tokens.</p>"}<h2>Delete my account</h2><p>For account deletion, contact the operator through <a href="/contact">Contact</a>.</p>`,
      );
    }
    if (p === "signup") {
      const pending = await get("/auth/signup");
      return result(
        "Sign up",
        `<h1>Sign up</h1><p>Signed in with GitHub as <strong>${esc(pending.username)}</strong>. <a href="/auth/github?switch_account=1&amp;return_to=${enc(pending.return_to)}">Use another account</a></p><p>By signing up, you agree to the <a href="/terms">Terms</a> and acknowledge the <a href="/privacy">Privacy Policy</a>.</p>${action("signup", { terms_version: pending.terms_version }, "Sign up", pending.csrf)}`,
      );
    }
    if (p === "terms-update")
      return result(
        "Updated terms",
        `<h1>Updated terms</h1>${legal.terms.body}<p>Version: ${esc(c.env.TERMS_VERSION)}</p>${action("terms", { version: c.env.TERMS_VERSION, _back: safeBack(current.searchParams.get("return_to") || "/account") }, "Agree and continue")}`,
      );
    if (p === "device") {
      const code = (current.searchParams.get("code") || "")
        .toUpperCase()
        .replace(/[^A-Z2-9]/g, "");
      if (!me.user) return login();
      const account = `<p>Signed in as <strong>${esc(me.user.username)}</strong>. <a href="/auth/github?switch_account=1&amp;return_to=${enc(back)}">Use another account</a></p>`;
      if (!code)
        return result(
          "Connect CLI",
          `<h1>Connect CLI</h1>${account}<form action="/device" method="get"><label>Code from your terminal <input name="code" autocomplete="off" maxlength="12" required></label><button>Continue</button></form>`,
        );
      // Inspection remains a read of the existing protocol; its API uses POST.
      const inspected = await fetch(
        new Request(new URL("/auth/device/inspect", c.req.url), {
          method: "POST",
          headers: {
            Cookie: c.req.header("cookie") || "",
            Origin: c.env.APP_ORIGIN,
            "X-CSRF-Token": me.csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ user_code: code }),
        }),
      );
      const d: any = await inspected.json();
      if (!inspected.ok)
        return result(
          "Connect CLI",
          `<h1>Connect CLI</h1>${account}<p>This code is invalid or has expired. Check your terminal or run <code>cargo proofs login</code> again.</p><a href="/device">Enter another code</a>`,
          inspected.status,
        );
      return result(
        "Connect CLI",
        `<h1>Connect CLI</h1>${account}${d.state === "pending" ? `<p>Check the code:</p><p class="device-code"><code>${esc(code.slice(0, 4) + "-" + code.slice(4))}</code></p>${action("device", { user_code: code }, "Authorize")}` : "<p>This request has already been used. Run <code>cargo proofs login</code> again.</p>"}`,
      );
    }
    if (p === "unsubscribe")
      return result(
        "Unsubscribe",
        `<h1>Unsubscribe</h1><p>Turn off all comment email notifications?</p>${action("unsubscribe", { user: current.searchParams.get("user"), signature: current.searchParams.get("signature") }, "Unsubscribe")}`,
      );
    if (p === "admin" && id === "catalogs") {
      const data = await get("/admin/catalogs");
      return result(
        "Catalogs",
        `<h1>Catalogs</h1><p>Reindex stored rustdoc snapshots to include all public callable APIs. Existing API IDs and claims are preserved.</p><ul>${data.items.map((item: any) => `<li>${esc(item.crate)} ${esc(item.version)} ${action("refresh", { id: item.id }, "Refresh")}</li>`).join("")}</ul>`,
      );
    }
    return result("Page not found", "<h1>Page not found</h1>", 404);
  } catch (error) {
    if (!(error instanceof Fault)) throw error;
    return result(
      error.status === 404 ? "Page not found" : "Request failed",
      `<h1>${error.status === 404 ? "Page not found" : "Request failed"}</h1><p role="alert">${escape(error.message)}</p><p><a href="/">Home</a></p>`,
      error.status,
    );
  }
}

export async function siteAction(c: Ctx, fetch: SiteFetch): Promise<Response> {
  c.header("Cache-Control", "private, no-store");
  if (c.req.header("origin") !== c.env.APP_ORIGIN)
    return c.html(
      layout(
        c,
        "Request failed",
        '<h1>Request failed</h1><p role="alert">invalid_origin</p>',
      ),
      403,
    );
  const form = await c.req.formData();
  const field = (name: string) => String(form.get(name) || "");
  const name = c.req.path.split("/").at(-1);
  const id = enc(field("id"));
  let path = "",
    method = "POST",
    body: any = {},
    back = safeBack(field("_back"));
  switch (name) {
    case "logout":
      path = "/auth/logout";
      back = "/";
      break;
    case "signup":
      path = "/auth/signup";
      body = { terms_version: field("terms_version") };
      break;
    case "terms":
      path = "/me/terms-acceptance";
      body = { version: field("version") };
      break;
    case "preferences":
      path = "/me/notification-preferences";
      method = "PATCH";
      body = {
        replies: form.has("replies"),
        report_comments: form.has("report_comments"),
      };
      back = "/settings";
      break;
    case "revoke":
      path = "/me/tokens/" + id;
      method = "DELETE";
      break;
    case "comment":
      path = `/reports/${id}/comments`;
      body = {
        body: field("body"),
        revision_no: Number(field("revision_no")),
        reply_to_id: field("reply_to_id") || null,
      };
      break;
    case "edit-comment":
      path = "/comments/" + id;
      method = "PATCH";
      body = {
        body: field("body"),
        edit_version: Number(field("edit_version")),
      };
      break;
    case "delete-comment":
      path = "/comments/" + id;
      method = "DELETE";
      body = { edit_version: Number(field("edit_version")) };
      break;
    case "vote":
      path = "/comments/" + id + "/vote";
      method = field("on") === "true" ? "PUT" : "DELETE";
      body = method === "PUT" ? { value: Number(field("value")) } : undefined;
      break;
    case "star":
      if (!["report", "claim"].includes(field("kind")))
        return c.text("Invalid kind", 400);
      path = `/${field("kind")}s/${id}/star`;
      method = field("on") === "true" ? "PUT" : "DELETE";
      break;
    case "withdraw":
      path = `/reports/${id}/withdrawal`;
      method = "PUT";
      break;
    case "device":
      path = "/auth/device/approve";
      body = { user_code: field("user_code") };
      break;
    case "unsubscribe":
      path = "/notifications/unsubscribe";
      body = { user: field("user"), signature: field("signature") };
      break;
    case "refresh":
      path = `/admin/catalogs/${id}/refresh`;
      break;
    default:
      return c.text("Not found", 404);
  }
  const response = await fetch(
    localRequest(
      c,
      path,
      method,
      body,
      field("_csrf"),
      field("_key") || undefined,
    ),
  );
  const value: any = await response.json();
  if (!response.ok) {
    if (response.status === 428)
      return c.redirect("/terms-update?return_to=" + enc(back), 303);
    const retry = `<form method="post" action="${escape(c.req.path)}">${Array.from(
      form.entries(),
    )
      .filter(([k, v]) => k !== "body" && typeof v === "string")
      .map(
        ([k, v]) =>
          `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`,
      )
      .join(
        "",
      )}<label>Comment <textarea name="body" maxlength="5000">${escape(field("body"))}</textarea></label><button>Retry</button></form>`;
    return new Response(
      layout(
        c,
        "Request failed",
        `<h1>Request failed</h1><p role="alert">${escape(value.message || value.error)}</p>${["comment", "edit-comment"].includes(name || "") ? retry : ""}<p><a href="${escape(back)}">Return to page</a></p>`,
      ),
      {
        status: response.status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
        },
      },
    );
  }
  if (name === "device" || name === "unsubscribe" || name === "refresh")
    return c.html(
      layout(
        c,
        "Done",
        name === "device"
          ? '<h1>CLI connected</h1><p>Return to your terminal to continue. You can close this page.</p><a href="/settings">Manage tokens</a>'
          : name === "unsubscribe"
            ? "<h1>Unsubscribed</h1><p>You can re-enable notifications in your account settings.</p>"
            : `<h1>Catalog refreshed</h1><p>${escape(value.indexed)} indexed, ${escape(value.added)} added</p><a href="/admin/catalogs">Catalogs</a>`,
      ),
    );
  if (name === "signup") back = safeBack(value.return_to);
  const headers = new Headers({
    Location: back,
    "Cache-Control": "private, no-store",
  });
  for (const cookie of response.headers.getSetCookie())
    headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

// mdBook keeps its static body; only the account menu and feature-flag text vary.
export async function bookPage(c: Ctx, response: Response, fetch: SiteFetch) {
  if (!response.headers.get("Content-Type")?.includes("text/html"))
    return response;
  const session = await fetch(localRequest(c, "/me"));
  const me = session.ok ? await session.json() : { user: null };
  const stars = c.env.SHOW_STAR_KARMA === "true";
  const rewriter = new HTMLRewriter()
    .on("#account-nav", {
      element(element) {
        element.setAttribute("data-server-rendered", "true");
        element.setInnerContent(accountNavigation(c, me), { html: true });
      },
    })
    .on("[data-star-karma-score]", {
      element(element) {
        if (stars)
          element.setInnerContent(
            " User scores provide an additional signal derived from contributions to the community, helping readers decide whose judgments deserve greater weight.",
          );
      },
    });
  if (stars && /\/concepts(?:\.html)?$/.test(c.req.path))
    rewriter.on("h2#reproduce", {
      element(element) {
        element.before(
          '<section><h2 id="star--karma">Star / Karma</h2><p>Stars express interest in or appreciation of Reports and Claims. In the current implementation, Karma counts Stars received from other users on Reports that are public and have not been withdrawn. Comment ratings are not included in the calculation. Both are intended as signals that help readers evaluate contributions.</p></section>',
          { html: true },
        );
      },
    });
  const rendered = rewriter.transform(response);
  rendered.headers.set("Cache-Control", "private, no-store");
  return rendered;
}
