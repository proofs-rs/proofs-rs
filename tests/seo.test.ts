import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { seoResponse } from "../src/seo.ts";
import { app } from "../src/worker";
import type { Env } from "../src/core";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    [
      "CREATE TABLE reports(id INTEGER,release_id INTEGER,visibility TEXT,withdrawn_at TEXT);",
      "CREATE TABLE crates(id INTEGER,name TEXT);",
      "CREATE TABLE releases(id INTEGER,crate_id INTEGER,version TEXT);",
      "CREATE TABLE claims(id TEXT,report_id INTEGER,api_item_id TEXT);",
      "CREATE TABLE claim_revisions(claim_id TEXT,report_revision INTEGER);",
      "CREATE TABLE report_revisions(report_id INTEGER,revision_no INTEGER,created_at TEXT DEFAULT '2026-01-01T00:00:00Z',tool_version_id TEXT DEFAULT 'kani-1');",
      "CREATE TABLE tools(id TEXT,active INTEGER);",
      "CREATE TABLE tool_versions(id TEXT,limitations_updated_at TEXT);",
      "INSERT INTO tool_versions VALUES('kani-1',NULL);",
      "INSERT INTO crates VALUES(1,'example');",
      "INSERT INTO releases VALUES(1,1,'1.0.0');",
      "INSERT INTO reports VALUES(1,1,'public',NULL),(2,1,'hidden',NULL),(3,1,'public','2026-01-01');",
      "INSERT INTO report_revisions(report_id,revision_no) VALUES(1,1),(1,2),(2,1),(3,1);",
      "INSERT INTO claims VALUES('current',1,'api-current'),('old',1,'api-old'),('hidden',2,'api-hidden'),('withdrawn',3,'api-withdrawn');",
      "INSERT INTO claim_revisions VALUES('current',2),('old',1),('hidden',1),('withdrawn',1);",
      "INSERT INTO tools VALUES('kani',1),('inactive',0);",
    ].join("\n"),
  );
  const queries: { sql: string; bindings: any[] }[] = [];
  const env = {
    ENVIRONMENT: "production",
    APP_ORIGIN: "https://proofs.rs",
    DB: {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        let bindings: any[] = [];
        return {
          bind(...values: any[]) {
            bindings = values;
            return this;
          },
          async first() {
            queries.push({ sql, bindings });
            return statement.get(...bindings) || null;
          },
          async all() {
            queries.push({ sql, bindings });
            return { results: statement.all(...bindings) };
          },
        };
      },
    },
  } as unknown as Env;
  return { db, env, queries };
}
const urls = (xml: string) =>
  [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);

test("sitemaps exclude hidden, withdrawn and superseded evidence", async () => {
  const { db, env } = fixture();
  try {
    assert.deepEqual(
      urls(await (await seoResponse(env, "/sitemap.xml"))!.text()),
      [
        "https://proofs.rs/sitemap-pages.xml",
        "https://proofs.rs/blog/sitemap.xml",
        "https://proofs.rs/sitemap-records-1.xml",
      ],
    );
    const response = await seoResponse(env, "/sitemap-records-1.xml");
    assert.equal(
      response!.headers.get("Content-Type"),
      "application/xml; charset=utf-8",
    );
    assert.equal(response!.headers.get("set-cookie"), null);
    assert.deepEqual(
      urls(await response!.text()).sort(),
      [
        "https://proofs.rs/api/api-current",
        "https://proofs.rs/claim/current",
        "https://proofs.rs/crate/example",
        "https://proofs.rs/report/1",
        "https://proofs.rs/tool/kani",
      ].sort(),
    );
    for (const path of [
      "/sitemap-records-2.xml",
      "/sitemap-records-0.xml",
      "/sitemap-records-1.xmlx",
      "/sitemap-records-9007199254740992.xml",
    ])
      assert.equal((await seoResponse(env, path))!.status, 404);
    assert.equal(await seoResponse(env, "/report/1"), null);
  } finally {
    db.close();
  }
});

test("pagination covers every URL without exceeding the per-file limit", async () => {
  const { db, env } = fixture();
  try {
    const insert = db.prepare("INSERT INTO reports VALUES(?,1,'public',NULL)");
    for (let id = 4; id <= 2004; id++) insert.run(id);
    const index = urls(await (await seoResponse(env, "/sitemap.xml"))!.text());
    assert.equal(index.length, 5);
    const all: string[] = [];
    for (const url of index.slice(2)) {
      const entries = urls(
        await (await seoResponse(env, new URL(url).pathname))!.text(),
      );
      assert.ok(entries.length <= 1000);
      all.push(...entries);
    }
    assert.equal(all.length, 2006);
    assert.equal(new Set(all).size, all.length);
  } finally {
    db.close();
  }
});

test("robots uses the configured origin and staging blocks crawling", async () => {
  const { db, env } = fixture();
  try {
    assert.match(
      await (await seoResponse(env, "/robots.txt"))!.text(),
      /Sitemap: https:\/\/proofs.rs\/sitemap.xml/,
    );
    const pages = urls(
      await (await seoResponse(env, "/sitemap-pages.xml"))!.text(),
    );
    assert.ok(pages.includes("https://proofs.rs/book/"));
    assert.ok(
      !pages.some((url) => /\/(account|login|admin|settings|runs)\b/.test(url)),
    );
    const custom = await seoResponse(
      { ...env, APP_ORIGIN: "https://a&b.example" },
      "/sitemap-pages.xml",
    );
    assert.match(await custom!.text(), /https:\/\/a&amp;b\.example/);
    const staging = { ...env, ENVIRONMENT: "staging" };
    assert.equal(
      await (await seoResponse(staging, "/robots.txt"))!.text(),
      "User-agent: *\nDisallow: /\n",
    );
    assert.equal((await seoResponse(staging, "/sitemap.xml"))!.status, 404);
  } finally {
    db.close();
  }
});

test("every Book chapter is discoverable without duplicate URLs", async () => {
  const { db, env } = fixture();
  try {
    const response = await seoResponse(env, "/sitemap-pages.xml");
    const pages = urls(await response!.text());
    const summary = readFileSync(
      new URL("../book/src/SUMMARY.md", import.meta.url),
      "utf8",
    );
    for (const [, chapter] of summary.matchAll(/\]\(([^)]+)\.md\)/g)) {
      const path = chapter === "index" ? "/book/" : `/book/${chapter}.html`;
      assert.ok(pages.includes("https://proofs.rs" + path), path);
    }
    assert.equal(new Set(pages).size, pages.length);
  } finally {
    db.close();
  }
});

test("private-only crates and releases stay excluded and shared APIs appear once", async () => {
  const { db, env } = fixture();
  try {
    db.exec(`
      INSERT INTO crates VALUES(2,'private-only'),(3,'withdrawn-only');
      INSERT INTO releases VALUES(2,2,'2.0.0'),(3,3,'3.0.0'),(4,1,'4.0.0');
      UPDATE reports SET release_id=id WHERE id IN (2,3);
      INSERT INTO reports VALUES(4,4,'hidden',NULL),(5,1,'public',NULL);
      INSERT INTO report_revisions(report_id,revision_no) VALUES(5,1);
      INSERT INTO claims VALUES('shared',5,'api-current');
      INSERT INTO claim_revisions VALUES('shared',1);
    `);
    const entries = urls(
      await (await seoResponse(env, "/sitemap-records-1.xml"))!.text(),
    );
    assert.equal(
      entries.filter((url) => url.endsWith("/api/api-current")).length,
      1,
    );
    assert.ok(entries.includes("https://proofs.rs/claim/shared"));
    assert.ok(entries.includes("https://proofs.rs/report/5"));
    assert.ok(
      !entries.some((url) => /private-only|withdrawn-only|4\.0\.0/.test(url)),
    );
    assert.equal(entries.length, 7);
  } finally {
    db.close();
  }
});

test("an empty registry still advertises documentation", async () => {
  const { db, env } = fixture();
  try {
    db.exec(
      "DELETE FROM claims; DELETE FROM claim_revisions; DELETE FROM reports; DELETE FROM tools;",
    );
    assert.deepEqual(
      urls(await (await seoResponse(env, "/sitemap.xml"))!.text()),
      [
        "https://proofs.rs/sitemap-pages.xml",
        "https://proofs.rs/blog/sitemap.xml",
      ],
    );
    assert.equal(
      (await seoResponse(env, "/sitemap-records-1.xml"))!.status,
      404,
    );
  } finally {
    db.close();
  }
});

test("worker serves dynamic XML and HEAD without cookies or asset access", async () => {
  const { db, env } = fixture();
  try {
    // Path identifiers and query values must survive XML parsing and URL decoding.
    db.prepare("INSERT INTO tools VALUES(?,1)").run(`a&<>"'/?#`);
    for (const path of ["/sitemap.xml", "/sitemap-records-1.xml"]) {
      const response = await app.request("https://proofs.rs" + path, {}, env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.match(
        response.headers.get("cache-control")!,
        /^public, max-age=(3600|35[0-9]{2})$/,
      );
      const document = new JSDOM(await response.text(), {
        contentType: "application/xml",
      }).window.document;
      assert.equal(
        document.documentElement.namespaceURI,
        "http://www.sitemaps.org/schemas/sitemap/0.9",
      );
      if (path.includes("records")) {
        const entries = [...document.querySelectorAll("loc")].map(
          (loc) => new URL(loc.textContent!),
        );
        assert.ok(
          entries.some(
            (url) => decodeURIComponent(url.pathname) === `/tool/a&<>"'/?#`,
          ),
        );
      }
      const head = await app.request(
        "https://proofs.rs" + path,
        { method: "HEAD" },
        env,
      );
      assert.equal(head.status, 200);
      assert.equal(
        head.headers.get("content-type"),
        response.headers.get("content-type"),
      );
      assert.equal(await head.text(), "");
    }
    for (const path of [
      "/sitemap.xml",
      "/sitemap-pages.xml",
      "/sitemap-records-1.xml",
    ]) {
      const response = await app.request(
        "https://staging.example" + path,
        {},
        { ...env, ENVIRONMENT: "staging", DB: undefined },
      );
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  } finally {
    db.close();
  }
});

test("root sitemaps redirect legacy URLs only in production", async () => {
  const { db, env, queries } = fixture();
  try {
    for (const [old, target] of [
      ["/sitemaps/pages.xml", "/sitemap-pages.xml"],
      ["/sitemaps/records-1.xml", "/sitemap-records-1.xml"],
    ]) {
      const response = await seoResponse(env, old);
      assert.equal(response!.status, 308);
      assert.equal(response!.headers.get("location"), env.APP_ORIGIN + target);
      assert.equal(
        (await seoResponse({ ...env, ENVIRONMENT: "staging" }, old))!.status,
        404,
      );
    }
    assert.equal(
      (await seoResponse(env, "/sitemaps/records-0.xml"))!.status,
      404,
    );
    assert.equal(queries.length, 0);
  } finally {
    db.close();
  }
});

test("SemVer defaults are removed before pagination and change with publication state", async () => {
  const { db, env, queries } = fixture();
  try {
    db.exec(`INSERT INTO releases VALUES(2,1,'1.9.0'),(3,1,'1.10.0'),(4,1,'2.0.0-rc.1');
      INSERT INTO reports VALUES(4,2,'public',NULL),(5,3,'public',NULL),(6,4,'public',NULL);`);
    const read = async () =>
      urls(await (await seoResponse(env, "/sitemap-records-1.xml"))!.text());
    let entries = await read();
    assert.ok(
      !entries.includes(env.APP_ORIGIN + "/crate/example?version=1.10.0"),
    );
    assert.ok(
      entries.includes(env.APP_ORIGIN + "/crate/example?version=2.0.0-rc.1"),
    );
    assert.equal(queries.length, 2);
    // Validate the actual bound SQL with SQLite's planner, including json_each.
    for (const query of queries)
      assert.ok(
        db.prepare("EXPLAIN QUERY PLAN " + query.sql).all(...query.bindings)
          .length,
      );
    db.exec("UPDATE reports SET withdrawn_at='2026-01-02' WHERE id=5");
    entries = await read();
    assert.ok(
      !entries.some(
        (url) =>
          url.includes("version=1.9.0") || url.includes("version=1.10.0"),
      ),
    );
    db.exec("UPDATE reports SET visibility='hidden' WHERE id IN (1,4)");
    entries = await read();
    assert.ok(entries.includes(env.APP_ORIGIN + "/crate/example"));
    assert.ok(!entries.some((url) => url.includes("?version=")));
    assert.equal(queries.length, 6);
  } finally {
    db.close();
  }
});

test("exact page boundary has no duplicate latest URL or extra empty file", async () => {
  const { db, env, queries } = fixture();
  try {
    const insert = db.prepare("INSERT INTO reports VALUES(?,1,'public',NULL)");
    for (let id = 4; id < 999; id++) insert.run(id); // 5 initial URLs + 995 reports
    const index = urls(await (await seoResponse(env, "/sitemap.xml"))!.text());
    assert.equal(index.length, 3);
    assert.equal(
      urls(await (await seoResponse(env, "/sitemap-records-1.xml"))!.text())
        .length,
      1000,
    );
    assert.equal(
      (await seoResponse(env, "/sitemap-records-2.xml"))!.status,
      404,
    );
    assert.equal(queries.length, 6);
  } finally {
    db.close();
  }
});

test("lastmod follows report content and tool limitations, never request time", async () => {
  const { db, env } = fixture();
  try {
    const read = async () =>
      new JSDOM(
        await (await seoResponse(env, "/sitemap-records-1.xml"))!.text(),
        { contentType: "application/xml" },
      ).window.document;
    const date = (doc: Document, path: string) =>
      [...doc.querySelectorAll("url")]
        .find(
          (el) =>
            el.querySelector("loc")?.textContent === env.APP_ORIGIN + path,
        )
        ?.querySelector("lastmod")?.textContent;
    const original = await read();
    assert.equal(date(original, "/report/1"), "2026-01-01T00:00:00.000Z");
    assert.equal(date(original, "/claim/current"), "2026-01-01T00:00:00.000Z");
    assert.equal(date(original, "/api/api-current"), undefined);
    assert.equal(date(original, "/crate/example"), undefined);
    db.exec(
      "UPDATE report_revisions SET created_at='2026-02-01T00:00:00Z' WHERE report_id=1 AND revision_no=2",
    );
    assert.equal(date(await read(), "/report/1"), "2026-02-01T00:00:00.000Z");
    db.exec(
      "UPDATE tool_versions SET limitations_updated_at='2026-02-01T00:00:00.500Z'",
    );
    const changed = await read();
    assert.equal(date(changed, "/report/1"), "2026-02-01T00:00:00.500Z");
    assert.equal(date(changed, "/claim/current"), "2026-02-01T00:00:00.500Z");
    assert.equal(
      (await read()).documentElement.outerHTML,
      changed.documentElement.outerHTML,
    );
  } finally {
    db.close();
  }
});

test("cache hits skip D1, share GET/HEAD and queries, expire, and refresh request IDs", async () => {
  const { db, env, queries } = fixture();
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const originalNow = Date.now;
  let clock = Date.now();
  const saved = new Map<string, { body: string; headers: Headers }>();
  const pending: Promise<unknown>[] = [];
  const cache: Pick<Cache, "match" | "put"> = {
    async match(request) {
      const entry = saved.get(
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url,
      );
      return entry
        ? new Response(entry.body, { headers: entry.headers })
        : undefined;
    },
    async put(request, response) {
      saved.set(
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url,
        { body: await response.text(), headers: new Headers(response.headers) },
      );
    },
  };
  try {
    Date.now = () => clock;
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: { open: async () => cache },
    });
    const first = await seoResponse(env, "/sitemap-records-1.xml", {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    const xml = await first!.text();
    assert.equal(first!.headers.get("x-sitemap-cache"), "MISS");
    assert.equal(queries.length, 2);
    clock += 120_000;
    const hit = await app.request(
      env.APP_ORIGIN + "/sitemap-records-1.xml?utm_source=test",
      { headers: { Cookie: "irrelevant" } },
      env,
    );
    assert.equal(await hit.text(), xml);
    assert.equal(hit.headers.get("cache-control"), "public, max-age=3480");
    assert.equal(hit.headers.get("x-sitemap-generated-at"), null);
    const head = await app.request(
      env.APP_ORIGIN + "/sitemap-records-1.xml?another=1",
      { method: "HEAD" },
      env,
    );
    assert.equal(await head.text(), "");
    assert.equal(head.headers.get("x-sitemap-cache"), "HIT");
    assert.notEqual(
      head.headers.get("x-request-id"),
      hit.headers.get("x-request-id"),
    );
    assert.equal(queries.length, 2);
    clock += 3_480_000;
    db.exec("UPDATE reports SET visibility='hidden' WHERE id=1");
    const fresh = await seoResponse(env, "/sitemap-records-1.xml");
    assert.equal(fresh!.headers.get("x-sitemap-cache"), "MISS");
    assert.ok(!(await fresh!.text()).includes("/report/1"));
    assert.equal(queries.length, 4);
  } finally {
    Date.now = originalNow;
    if (originalCaches)
      Object.defineProperty(globalThis, "caches", originalCaches);
    else Reflect.deleteProperty(globalThis, "caches");
    db.close();
  }
});

test("cache errors fall back to generation and non-200 responses are not saved", async () => {
  const { db, env } = fixture();
  let writes = 0;
  const cache: Pick<Cache, "match" | "put"> = {
    async match() {
      throw Error("unavailable");
    },
    async put() {
      writes++;
      throw Error("unavailable");
    },
  };
  try {
    assert.equal(
      (await seoResponse(env, "/sitemap-records-1.xml", { cache }))!.status,
      200,
    );
    assert.equal(writes, 1);
    assert.equal(
      (await seoResponse(env, "/sitemap-records-2.xml", { cache }))!.status,
      404,
    );
    assert.equal(writes, 1);
  } finally {
    db.close();
  }
});
