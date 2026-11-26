const origin = process.argv[2];
const environment = process.argv[3] || "staging";
if (!origin?.startsWith("https://")) throw Error("Expected HTTPS URL");
for (const path of [
  "/",
  "/api/docs",
  "/tools",
  "/tool/aeneas",
  "/book/aeneas.html",
  "/book/review-a-dependency.html",
  "/blog/",
  "/blog/sitemap.xml",
  "/openapi.json",
  "/api/v1/health",
  "/api/v1/home",
  "/api/v1/reports",
  "/api/v1/crates",
  "/api/v1/tools",
  "/api/v1/me",
  "/api/v1/config",
]) {
  let r;
  for (let attempt = 0; attempt < 6; attempt++) {
    r = await fetch(origin + path);
    if (r.ok || ![404, 502, 503, 504].includes(r.status)) break;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (!r.ok) throw Error(path + " returned " + r.status);
  if (
    environment === "staging" &&
    !r.headers.get("x-robots-tag")?.includes("noindex")
  )
    throw Error("Missing staging noindex header");
  if (path === "/") {
    const html = await r.text();
    if (
      !html.includes('href="/blog/"') ||
      html.includes("proofs-rs.hashnode.dev")
    )
      throw Error("Home navigation must link to the local blog");
  }
  if (path === "/blog/") {
    const html = await r.text();
    const rss = html
      .match(/<link[^>]+type="application\/rss\+xml"[^>]*>/i)?.[0]
      ?.match(/href="([^"]+)"/i)?.[1];
    if (!rss) throw Error("Blog RSS discovery link missing");
    const feed = await fetch(origin + new URL(rss, origin).pathname);
    if (!feed.ok || !(await feed.text()).includes("<rss"))
      throw Error("Invalid blog RSS feed");

    const links = [...html.matchAll(/href="([^"]+)"/g)]
      .map((m) => new URL(m[1], origin).pathname)
      .filter((path) => /^\/blog\/[a-z0-9-]+\/$/.test(path));
    if (!links.length) throw Error("Blog has no articles");
    for (const article of [...new Set(links)].slice(0, 3)) {
      const post = await fetch(origin + article, { redirect: "manual" });
      if (!post.ok || !/<h1[\s>]/.test(await post.text()))
        throw Error(article + " failed blog smoke check (" + post.status + ")");
    }
    const redirect = await fetch(origin + "/blog", { redirect: "manual" });
    if (
      redirect.status !== 308 ||
      redirect.headers.get("location") !== "/blog/"
    )
      throw Error("Expected /blog to redirect to /blog/");
    const missing = await fetch(origin + "/blog/not-a-valid-article-404/");
    if (missing.status !== 404)
      throw Error("Expected unknown blog path to return 404");
  }
  if (path === "/blog/sitemap.xml" && !(await r.text()).includes("<urlset "))
    throw Error("Invalid blog sitemap");
  if (path === "/api/v1/tools") {
    const catalogue = await r.json();
    if (
      !catalogue.items.some((t) => t.id === "aeneas") ||
      !catalogue.versions.some(
        (v) =>
          v.tool_id === "aeneas" &&
          /^[a-f0-9]{40}$/.test(v.version) &&
          v.limitations,
      )
    )
      throw Error("Aeneas tool or registered pinned revision missing");
  }
  if (path === "/tool/aeneas") {
    const html = await r.text();
    if (!html.includes('href="/book/aeneas.html"'))
      throw Error("Aeneas tool setup guide link missing");
  }
  if (path === "/book/aeneas.html") {
    const html = await r.text();
    if (
      !html.includes("Record with Aeneas and Lean") ||
      !html.includes("tool.proofs")
    )
      throw Error("Aeneas tutorial heading or proof configuration missing");
  }
  if (path === "/book/review-a-dependency.html") {
    const html = await r.text();
    if (
      !html.includes("Declare dependency reviews") ||
      !html.includes('href="publish-a-report.html"')
    )
      throw Error("Dependency tutorial heading or publishing link missing");
  }
  if (path === "/openapi.json" && (await r.json()).openapi !== "3.1.0")
    throw Error("Invalid OpenAPI document");
  if (path === "/api/v1/config") {
    const config = await r.json();
    if (config.environment !== environment)
      throw Error("Wrong deployment environment");
    if (
      environment === "production" &&
      origin === "https://proofs.rs" &&
      !config.oauth_configured
    )
      throw Error("Production OAuth is unavailable");
    console.log(
      "Integration configuration: OAuth=" +
        config.oauth_configured +
        ", email=" +
        config.email_configured,
    );
  }
  console.log("OK " + path);
}

// SEO responses must bypass authentication and asset fallback routing.
async function seoCheck(path, status = 200) {
  const response = await fetch(origin + path, { redirect: "manual" });
  if (response.status !== status)
    throw Error(`${path} returned ${response.status}, expected ${status}`);
  if (response.headers.has("set-cookie")) throw Error(`${path} set a cookie`);
  console.log("OK " + path);
  return response;
}
const robots = await seoCheck("/robots.txt");
const robotsText = await robots.text();
if (environment === "production") {
  if (!robotsText.includes(`Sitemap: ${origin}/sitemap.xml`))
    throw Error("Missing sitemap advertisement");
  const index = await seoCheck("/sitemap.xml");
  const indexText = await index.text();
  if (
    !index.headers.get("content-type")?.includes("application/xml") ||
    !indexText.includes("<sitemapindex")
  )
    throw Error("Invalid sitemap index");
  const pages = await seoCheck("/sitemap-pages.xml");
  if (!(await pages.text()).includes("<urlset"))
    throw Error("Invalid static sitemap");
  const first = `${origin}/sitemap-records-1.xml`;
  const hasRecords = indexText.includes(`<loc>${first}</loc>`);
  const records = await seoCheck(
    "/sitemap-records-1.xml",
    hasRecords ? 200 : 404,
  );
  if (hasRecords && !(await records.text()).includes("<urlset"))
    throw Error("Invalid records sitemap");
  for (const [old, target] of [
    ["/sitemaps/pages.xml", "/sitemap-pages.xml"],
    ["/sitemaps/records-1.xml", "/sitemap-records-1.xml"],
  ]) {
    const redirect = await seoCheck(old, 308);
    if (redirect.headers.get("location") !== origin + target)
      throw Error("Incorrect sitemap redirect");
  }
} else {
  if (!robotsText.includes("Disallow: /"))
    throw Error("Staging robots allows crawling");
  for (const path of [
    "/sitemap.xml",
    "/sitemap-pages.xml",
    "/sitemap-records-1.xml",
    "/sitemaps/pages.xml",
  ]) {
    const response = await seoCheck(path, 404);
    if (
      response.headers.get("cache-control") !== "no-store" ||
      !response.headers.get("x-robots-tag")?.includes("noindex")
    )
      throw Error("Staging sitemap is cacheable or indexable");
  }
}
