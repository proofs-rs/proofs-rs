import type { Env } from "./core";

// Each records file stays well below Google's 50,000-URL / 50 MB limits.
const PAGE_SIZE = 1000;
const staticPaths = [
  "/", "/crates", "/reports", "/tools", "/terms", "/privacy", "/contact",
  "/api/docs", "/book/", "/book/introduction.html", "/book/concepts.html",
  "/book/publish-a-report.html", "/book/write-a-report.html",
  "/book/review-a-dependency.html",
];
// Only current claims on visible, non-withdrawn reports contribute URLs.
// UNION deduplicates APIs and releases shared by multiple reports.
const recordsSQL = `
SELECT 'report' kind, CAST(p.id AS TEXT) id, '' version
FROM reports p WHERE p.visibility='public' AND p.withdrawn_at IS NULL
UNION
SELECT 'crate', cr.name, ''
FROM crates cr JOIN releases rel ON rel.crate_id=cr.id
JOIN reports p ON p.release_id=rel.id
WHERE p.visibility='public' AND p.withdrawn_at IS NULL
UNION
SELECT 'crate', cr.name, rel.version
FROM crates cr JOIN releases rel ON rel.crate_id=cr.id
JOIN reports p ON p.release_id=rel.id
WHERE p.visibility='public' AND p.withdrawn_at IS NULL
UNION
SELECT 'claim', cl.id, ''
FROM claims cl JOIN reports p ON p.id=cl.report_id
JOIN claim_revisions r ON r.claim_id=cl.id
WHERE p.visibility='public' AND p.withdrawn_at IS NULL
AND r.report_revision=(SELECT MAX(rr.revision_no) FROM report_revisions rr WHERE rr.report_id=p.id)
UNION
SELECT 'api', cl.api_item_id, ''
FROM claims cl JOIN reports p ON p.id=cl.report_id
JOIN claim_revisions r ON r.claim_id=cl.id
WHERE p.visibility='public' AND p.withdrawn_at IS NULL
AND r.report_revision=(SELECT MAX(rr.revision_no) FROM report_revisions rr WHERE rr.report_id=p.id)
UNION
SELECT 'tool', t.id, '' FROM tools t WHERE t.active=1
`;
const escapeXML = (value: string) =>
  value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
  );
function xml(root: "urlset" | "sitemapindex", paths: string[], origin: string) {
  const tag = root === "urlset" ? "url" : "sitemap";
  const body = paths.map((path) =>
    `<${tag}><loc>${escapeXML(new URL(path, origin).href)}</loc></${tag}>`,
  ).join("");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</${root}>\n`,
    { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" } },
  );
}
export async function seoResponse(env: Env, path: string): Promise<Response | null> {
  const isSitemap = path === "/sitemap.xml" || path.startsWith("/sitemaps/");
  if (path !== "/robots.txt" && !isSitemap) return null;
  if (path === "/robots.txt") {
    return new Response(
      env.ENVIRONMENT === "production"
        ? `User-agent: *\nAllow: /\nSitemap: ${new URL("/sitemap.xml", env.APP_ORIGIN).href}\n`
        : "User-agent: *\nDisallow: /\n",
      { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" } },
    );
  }
  if (env.ENVIRONMENT !== "production")
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (path === "/sitemaps/pages.xml") return xml("urlset", staticPaths, env.APP_ORIGIN);
  if (path === "/sitemap.xml") {
    const count = await env.DB.prepare(`SELECT COUNT(*) n FROM (${recordsSQL})`).first<{ n: number }>();
    const pages = Math.ceil((count?.n || 0) / PAGE_SIZE);
    return xml("sitemapindex", [
      "/sitemaps/pages.xml",
      ...Array.from({ length: pages }, (_, i) => `/sitemaps/records-${i + 1}.xml`),
    ], env.APP_ORIGIN);
  }
  const match = /^\/sitemaps\/records-([1-9][0-9]*)\.xml$/.exec(path);
  const page = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger((page - 1) * PAGE_SIZE))
    return new Response("Not found", { status: 404 });
  const records = await env.DB.prepare(
    `SELECT * FROM (${recordsSQL}) ORDER BY kind,id,version LIMIT ? OFFSET ?`,
  ).bind(PAGE_SIZE, (page - 1) * PAGE_SIZE).all<{ kind: string; id: string; version: string }>();
  if (!records.results.length) return new Response("Not found", { status: 404 });
  return xml("urlset", records.results.map((record) =>
    `/${record.kind}/${encodeURIComponent(record.id)}` +
    (record.version ? `?version=${encodeURIComponent(record.version)}` : ""),
  ), env.APP_ORIGIN);
}
