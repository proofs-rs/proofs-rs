import type { Env } from "./core";
import { defaultRelease } from "./releases";

// Each records file stays well below Google's 50,000-URL / 50 MB limits.
const PAGE_SIZE = 1000;
const staticPaths = [
  "/",
  "/crates",
  "/reports",
  "/tools",
  "/terms",
  "/privacy",
  "/contact",
  "/api/docs",
  "/book/",
  "/book/introduction.html",
  "/book/concepts.html",
  "/book/publish-a-report.html",
  "/book/write-a-report.html",
  "/book/review-a-dependency.html",
  "/book/findings.html",
  "/book/preview-a-report.html",
  "/book/aeneas.html",
  "/book/api-documentation.html",
  "/book/read-a-report.html",
  "/book/discuss-a-report.html",
  "/book/kani.html",
  "/book/creusot.html",
  "/book/update-a-report.html",
  "/book/troubleshooting.html",
  "/book/get-help.html",
  "/book/configuration.html",
  "/book/aeneas-reference.html",
];
// Only current claims on visible, non-withdrawn reports contribute URLs.
// UNION deduplicates APIs and releases shared by multiple reports.
// D1 allows at most five terms per compound SELECT. Expand claim/API rows
// with a two-row join so the outer UNION stays within that limit.
const recordsSQL = `
SELECT 'report' kind, CAST(p.id AS TEXT) id, '' version,
  CASE WHEN julianday(tv.limitations_updated_at) > julianday(rr.created_at) THEN tv.limitations_updated_at ELSE rr.created_at END lastmod
FROM reports p
LEFT JOIN report_revisions rr ON rr.report_id=p.id AND rr.revision_no=(SELECT MAX(v.revision_no) FROM report_revisions v WHERE v.report_id=p.id)
LEFT JOIN tool_versions tv ON tv.id=rr.tool_version_id
WHERE p.visibility='public' AND p.withdrawn_at IS NULL
UNION
SELECT 'crate', cr.name, '', NULL
FROM crates cr JOIN releases rel ON rel.crate_id=cr.id
JOIN reports p ON p.release_id=rel.id
WHERE p.visibility='public' AND p.withdrawn_at IS NULL
UNION
SELECT 'crate', cr.name, rel.version, NULL
FROM crates cr JOIN releases rel ON rel.crate_id=cr.id
JOIN reports p ON p.release_id=rel.id
WHERE p.visibility='public' AND p.withdrawn_at IS NULL
AND rel.id NOT IN (SELECT value FROM json_each(?))
UNION
SELECT urls.kind, CASE urls.kind WHEN 'claim' THEN cl.id ELSE cl.api_item_id END, '',
  CASE urls.kind WHEN 'claim' THEN CASE WHEN julianday(tv.limitations_updated_at) > julianday(rr.created_at) THEN tv.limitations_updated_at ELSE rr.created_at END ELSE NULL END
FROM claims cl JOIN reports p ON p.id=cl.report_id
JOIN claim_revisions r ON r.claim_id=cl.id
JOIN report_revisions rr ON rr.report_id=p.id AND rr.revision_no=r.report_revision
LEFT JOIN tool_versions tv ON tv.id=rr.tool_version_id
CROSS JOIN (SELECT 'claim' kind UNION ALL SELECT 'api') urls
WHERE p.visibility='public' AND p.withdrawn_at IS NULL
AND r.report_revision=(SELECT MAX(v.revision_no) FROM report_revisions v WHERE v.report_id=p.id)
UNION
SELECT 'tool', t.id, '', NULL FROM tools t WHERE t.active=1
`;
const escapeXML = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]!,
  );
type Entry = { path: string; lastmod?: string | null };
function xml(
  root: "urlset" | "sitemapindex",
  paths: (string | Entry)[],
  origin: string,
) {
  const tag = root === "urlset" ? "url" : "sitemap";
  const body = paths
    .map((entry) => {
      const { path, lastmod } =
        typeof entry === "string" ? { path: entry, lastmod: null } : entry;
      const date = lastmod ? new Date(lastmod) : null;
      return `<${tag}><loc>${escapeXML(new URL(path, origin).href)}</loc>${date && Number.isFinite(date.getTime()) ? `<lastmod>${date.toISOString()}</lastmod>` : ""}</${tag}>`;
    })
    .join("");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</${root}>\n`,
    {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
}
const TTL = 3600;
const generatedHeader = "X-Sitemap-Generated-At";
export type SEOOptions = {
  cache?: Pick<Cache, "match" | "put">;
  waitUntil?: (promise: Promise<unknown>) => void;
};
const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });

export async function seoResponse(
  env: Env,
  path: string,
  options: SEOOptions = {},
): Promise<Response | null> {
  const old =
    path === "/sitemaps/pages.xml"
      ? "/sitemap-pages.xml"
      : /^\/sitemaps\/records-([1-9][0-9]*)\.xml$/.exec(path)?.[1];
  const match = /^\/sitemap-records-([1-9][0-9]*)\.xml$/.exec(path);
  const isSitemap =
    path === "/sitemap.xml" ||
    path === "/sitemap-pages.xml" ||
    path.startsWith("/sitemap-records-") ||
    path.startsWith("/sitemaps/");
  if (path !== "/robots.txt" && !isSitemap) return null;
  if (path === "/robots.txt")
    return new Response(
      env.ENVIRONMENT === "production"
        ? `User-agent: *\nAllow: /\nSitemap: ${new URL("/sitemap.xml", env.APP_ORIGIN).href}\n`
        : "User-agent: *\nDisallow: /\n",
      {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      },
    );
  if (env.ENVIRONMENT !== "production") return notFound();
  if (old) {
    const destination = old.startsWith("/")
      ? old
      : `/sitemap-records-${old}.xml`;
    const page = old.startsWith("/") ? 1 : Number(old);
    if (
      !Number.isSafeInteger(page) ||
      !Number.isSafeInteger((page - 1) * PAGE_SIZE)
    )
      return notFound();
    return new Response(null, {
      status: 308,
      headers: {
        Location: new URL(destination, env.APP_ORIGIN).href,
        "Cache-Control": "public, max-age=3600",
      },
    });
  }
  const page = match ? Number(match[1]) : NaN;
  if (
    path !== "/sitemap.xml" &&
    path !== "/sitemap-pages.xml" &&
    (!Number.isSafeInteger(page) ||
      !Number.isSafeInteger((page - 1) * PAGE_SIZE))
  )
    return notFound();

  let cache = options.cache;
  if (!cache && typeof caches !== "undefined") {
    try {
      cache = await caches.open("sitemaps-v2");
    } catch {
      console.warn(JSON.stringify({ event: "sitemap_cache_open_failed" }));
    }
  }
  const key = new Request(
    new URL(path + "?sitemap-generation=2", env.APP_ORIGIN),
    { method: "GET" },
  );
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const generated = Number(hit.headers.get(generatedHeader));
        const remaining = TTL - Math.ceil((Date.now() - generated) / 1000);
        if (
          hit.headers.has(generatedHeader) &&
          Number.isFinite(generated) &&
          remaining > 0 &&
          remaining <= TTL
        ) {
          const response = new Response(hit.body, hit);
          response.headers.delete(generatedHeader);
          response.headers.delete("Age");
          response.headers.set("Cache-Control", `public, max-age=${remaining}`);
          response.headers.set("X-Sitemap-Cache", "HIT");
          return response;
        }
        void hit.body?.cancel().catch(() => {});
      }
    } catch {
      console.warn(JSON.stringify({ event: "sitemap_cache_read_failed" }));
    }
  }
  // Start the freshness clock before reading D1, not after generating XML.
  const generated = Date.now();
  const response = await generate(env, path, page);
  if (response.status !== 200) return response;
  response.headers.set("X-Sitemap-Cache", "MISS");
  if (cache) {
    const saved = response.clone();
    saved.headers.set(generatedHeader, String(generated));
    saved.headers.delete("X-Sitemap-Cache");
    const put = cache.put(key, saved).catch(() => {
      console.warn(JSON.stringify({ event: "sitemap_cache_write_failed" }));
    });
    if (options.waitUntil) options.waitUntil(put);
    else await put;
  }
  response.headers.set(
    "Cache-Control",
    `public, max-age=${Math.max(0, TTL - Math.ceil((Date.now() - generated) / 1000))}`,
  );
  return response;
}

async function generate(
  env: Env,
  path: string,
  page: number,
): Promise<Response> {
  if (path === "/sitemap-pages.xml")
    return xml("urlset", staticPaths, env.APP_ORIGIN);
  const releases = await env.DB.prepare(
    `SELECT rel.id, rel.version, cr.name crate
    FROM releases rel JOIN crates cr ON cr.id=rel.crate_id
    WHERE EXISTS(SELECT 1 FROM reports p WHERE p.release_id=rel.id AND p.visibility='public' AND p.withdrawn_at IS NULL)
    ORDER BY cr.name, rel.id`,
  ).all<{ id: number; version: string; crate: string }>();
  const defaults = new Map<string, { id: number; version: string }>();
  for (const release of releases.results) {
    defaults.set(
      release.crate,
      defaultRelease([
        ...(defaults.has(release.crate) ? [defaults.get(release.crate)!] : []),
        release,
      ])!,
    );
  }
  const ids = JSON.stringify([...defaults.values()].map((r) => r.id));
  if (path === "/sitemap.xml") {
    const count = await env.DB.prepare(`SELECT COUNT(*) n FROM (${recordsSQL})`)
      .bind(ids)
      .all<{ n: number }>();
    if (releases.meta || count.meta)
      console.log(
        JSON.stringify({
          event: "sitemap_generated",
          path,
          rows_read:
            (releases.meta?.rows_read || 0) + (count.meta?.rows_read || 0),
        }),
      );
    return xml(
      "sitemapindex",
      [
        "/sitemap-pages.xml",
        "/blog/sitemap.xml",
        ...Array.from(
          { length: Math.ceil((count.results[0]?.n || 0) / PAGE_SIZE) },
          (_, i) => `/sitemap-records-${i + 1}.xml`,
        ),
      ],
      env.APP_ORIGIN,
    );
  }
  const records = await env.DB.prepare(
    `SELECT * FROM (${recordsSQL}) ORDER BY kind,id,version LIMIT ? OFFSET ?`,
  )
    .bind(ids, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .all<{
      kind: string;
      id: string;
      version: string;
      lastmod: string | null;
    }>();
  if (!records.results.length) return notFound();
  if (releases.meta || records.meta)
    console.log(
      JSON.stringify({
        event: "sitemap_generated",
        path,
        rows_read:
          (releases.meta?.rows_read || 0) + (records.meta?.rows_read || 0),
      }),
    );
  return xml(
    "urlset",
    records.results.map((record) => ({
      path:
        `/${record.kind}/${encodeURIComponent(record.id)}` +
        (record.version
          ? `?version=${encodeURIComponent(record.version)}`
          : ""),
      lastmod: record.lastmod,
    })),
    env.APP_ORIGIN,
  );
}
