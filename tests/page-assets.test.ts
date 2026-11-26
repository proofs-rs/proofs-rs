import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pageLayout } from "../web/page-layout";

const publicDir = new URL("../public/", import.meta.url);
const linked = (html: string) => {
  const d = new JSDOM(html).window.document;
  return [
    ...[...d.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")].map(
      (l) => l.getAttribute("href")!,
    ),
    ...[...d.querySelectorAll("script[src]")].map((s) =>
      s.getAttribute("src")!,
    ),
  ];
};

test("page shells link only assets that exist in public/", () => {
  const site = linked(pageLayout("t", "", "", null));
  assert(site.includes("/fonts.css"));
  for (const path of site)
    assert(existsSync(new URL("." + path, publicDir)), `${path} is missing`);
  const preview = linked(pageLayout("t", "", "", null, undefined, true));
  assert.deepEqual(preview, site);
});

test("site and Book headers mark the same off-site links", () => {
  const external = (html: string) =>
    [
      ...new JSDOM(html).window.document.querySelectorAll(
        ".proofs-site-header nav a",
      ),
    ]
      .filter((a) => /^https?:/.test(a.getAttribute("href")!))
      .map((a) => [
        a.textContent,
        a.classList.contains("external") &&
          a.querySelector(".external-mark[aria-hidden=true]") !== null,
      ]);
  const site = external(pageLayout("t", "", "", null));
  assert.deepEqual(site, [["Zulip↗", true]]);
  assert.deepEqual(
    external(
      readFileSync(
        new URL("../book/theme/header.hbs", import.meta.url),
        "utf8",
      ),
    ),
    site,
  );
});

test("stylesheet url() references resolve to files in public/", () => {
  for (const name of readdirSync(publicDir).filter((n) => n.endsWith(".css")))
    for (const [, path] of readFileSync(new URL(name, publicDir), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/url\("?(\/[^")]+)"?\)/g))
      assert(existsSync(new URL("." + path, publicDir)), `${name}: ${path}`);
});
