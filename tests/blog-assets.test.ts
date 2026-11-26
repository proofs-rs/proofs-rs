import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";

const blog = new URL("https://proofs.rs/blog/");
const root = new URL("../public/blog/", import.meta.url);
const file = (url: URL) => {
  assert.equal(url.origin, blog.origin);
  assert(url.pathname.startsWith(blog.pathname));
  const path = url.pathname.slice(blog.pathname.length);
  return new URL(path + (url.pathname.endsWith("/") ? "index.html" : ""), root);
};
const parse = (url: URL, contentType = "text/html") =>
  new JSDOM(readFileSync(file(url), "utf8"), { contentType, url: url.href })
    .window.document;

test("the Hugo blog index, RSS, sitemap, and article pages agree", () => {
  const index = parse(blog);
  assert.equal(
    index.querySelector("link[rel=canonical]")?.getAttribute("href"),
    blog.href,
  );
  const rss = index.querySelector<HTMLLinkElement>(
    'link[type="application/rss+xml"]',
  );
  assert(rss?.href);
  const items = [
    ...parse(new URL(rss.href), "application/xml").querySelectorAll("item"),
  ];
  assert(items.length >= 3);
  const sitemap = parse(new URL("sitemap.xml", blog), "application/xml");
  const urls = new Set(
    [...sitemap.querySelectorAll("loc")].map((e) => e.textContent),
  );
  assert(urls.has(blog.href));
  const indexLinks = new Set(
    [...index.querySelectorAll("a")].map((el) => el.href),
  );
  const guids = new Set<string>();
  for (const item of items) {
    const href = item.querySelector("link")?.textContent;
    assert(href && urls.has(href));
    const url = new URL(href);
    const guid = item.querySelector("guid")?.textContent;
    assert(guid && !guids.has(guid));
    guids.add(guid);
    assert(indexLinks.has(href) || items.length > 10);
    const post = parse(url);
    assert.equal(
      post.querySelector("link[rel=canonical]")?.getAttribute("href"),
      href,
    );
    assert.equal(
      post.querySelector("article h1")?.textContent?.trim(),
      item.querySelector("title")?.textContent?.trim(),
    );
    assert(post.querySelector("article p"));
    for (const page of [index, post]) {
      const css = [
        ...page.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'),
      ];
      assert(css.length > 0);
      for (const link of css)
        assert(existsSync(file(new URL(link.href))), link.href);
    }
  }
});

test("all main site navigation points to the new blog", () => {
  for (const relative of [
    "index.html",
    "web/page-layout.ts",
    "book/theme/header.hbs",
    "cli/preview/server.cjs",
    "README.md",
  ]) {
    const contents = readFileSync(
      new URL("../" + relative, import.meta.url),
      "utf8",
    );
    assert.match(contents, /\/blog\//, relative);
    assert.doesNotMatch(contents, /proofs-rs\.hashnode\.dev/, relative);
  }
});

test("the Worker serves /blog from its asset binding without changing CSP", async () => {
  const { app } = await import("../src/worker");
  const assets = {
    fetch(req: Request) {
      const url = new URL(req.url);
      const asset = file(url);
      if (!existsSync(asset)) return new Response(null, { status: 404 });
      return new Response(readFileSync(asset), {
        headers: {
          "content-type": url.pathname.endsWith(".xml")
            ? "application/xml"
            : "text/html",
        },
      });
    },
  };
  const env = {
    ENVIRONMENT: "staging",
    APP_ORIGIN: blog.origin,
    ASSETS: assets,
  };
  const get = (path: string) =>
    app.request(blog.origin + path, {}, env as never);
  const redirect = await get("/blog?ref=example");
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/blog/?ref=example");
  const response = await get("/blog/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.doesNotMatch(
    response.headers.get("content-security-policy") ?? "",
    /unsafe-inline/,
  );
  assert.match(await response.text(), /proofs\.rs blog/);
  assert.equal((await get("/blog/rss.xml")).status, 200);
  assert.equal((await get("/blog/does-not-exist/")).status, 404);
});
