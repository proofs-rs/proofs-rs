import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { app } from "../src/worker";
import type { Env } from "../src/core";
import { blogPosts } from "../src/blog";

const env = {
  ENVIRONMENT: "production",
  APP_ORIGIN: "https://proofs.rs",
} as Env;
const request = (path: string) => app.request(path, undefined, env);

test("blog index, articles and legacy alias are served by the public Worker", async () => {
  const response = await request("/blog");
  assert.equal(response.status, 200);
  const index = new JSDOM(await response.text()).window.document;
  assert.equal(
    index.querySelector("header nav a[href='/blog']")?.textContent,
    "Blog",
  );
  assert.equal(index.querySelectorAll("main article").length, 4);
  for (const { slug, title, author, published, original } of blogPosts) {
    const article = await request(`/blog/${slug}`);
    assert.equal(article.status, 200);
    const doc = new JSDOM(await article.text()).window.document;
    assert.equal(doc.querySelector("h1")?.textContent, title);
    assert.equal(
      doc.querySelector("time")?.getAttribute("datetime"),
      published,
    );
    assert.match(
      doc.querySelector("time")?.parentElement?.textContent ?? "",
      new RegExp(author),
    );
    assert.equal(
      doc.querySelector("link[rel=canonical]")?.getAttribute("href"),
      `https://proofs.rs/blog/${slug}`,
    );
    if (original) assert.ok(doc.querySelector(`article a[href="${original}"]`));
  }
  const alias = await request("/blog/how-anneal-uses-lean-miri");
  assert.equal(alias.status, 308);
  assert.equal(
    alias.headers.get("location"),
    "/blog/how-google-s-zerocopy-project-uses-lean-miri-to-verify-unsafe-rust",
  );
  assert.equal((await request("/blog/unpublished")).status, 404);
  assert.equal((await request("/blog/unpublished/extra")).status, 404);
});

test("RSS preserves Hashnode GUIDs and links to posts on proofs.rs", async () => {
  const response = await request("/blog/rss.xml");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /application\/rss\+xml/);
  const doc = new JSDOM(await response.text(), {
    contentType: "application/xml",
  }).window.document;
  const items = [...doc.querySelectorAll("item")];
  assert.equal(items.length, 4);
  for (const [i, { slug, guid }] of blogPosts.entries()) {
    assert.equal(
      items[i].querySelector("link")?.textContent,
      `https://proofs.rs/blog/${slug}`,
    );
    assert.equal(items[i].querySelector("guid")?.textContent, guid);
  }
  const wp = items[0].textContent ?? "";
  assert.match(
    wp,
    /github\.com\/proofs-rs\/lean-miri\/blob\/.+?\/examples\/body_vcgen/,
  );
  assert.doesNotMatch(wp, /\$\{example/);
});
