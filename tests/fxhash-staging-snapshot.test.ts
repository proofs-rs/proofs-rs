import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { app } from "../src/worker";
import { fixture } from "./support/service-fixture";

test("public fxhash snapshot seeds idempotently and renders its recorded formal evidence", async () => {
  const { db, env, request } = await fixture();
  const path = "fixtures/production-snapshots/fxhash-0.2.1";
  const manifest = JSON.parse(readFileSync(path + ".json", "utf8"));
  const sarifBytes = readFileSync(path + ".sarif.json");
  assert.equal(
    createHash("sha256").update(sarifBytes).digest("hex"),
    manifest.sha256,
  );
  const sql = readFileSync(path + ".sql", "utf8");
  db.exec(sql);
  db.exec(sql);
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(foreignKeys, []);
  const report = db
    .prepare("SELECT id FROM reports WHERE create_key=?")
    .get(manifest.report_key)!;
  const detail = await request(`/reports/${report.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.claims.length, 24);
  assert(
    detail.body.claims.every(
      (c: any) => c.evidence_ref?.run_id === manifest.run_id,
    ),
  );
  const originalGet = env.ARCHIVE.get.bind(env.ARCHIVE);
  let runReads = 0;
  env.ARCHIVE.get = async (key: string) => {
    if (key !== manifest.r2_key) return originalGet(key);
    runReads++;
    return {
      json: async () => JSON.parse(sarifBytes.toString()),
      body: new Response(sarifBytes).body,
    } as any;
  };
  const response = await app.request(
    `https://example.test/report/${report.id}`,
    {},
    env,
  );
  const html = await response.text();
  assert.equal(response.status, 200, html.slice(0, 500));
  assert.equal(runReads, 1);
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll(".inline-spec").length, 24);
  assert.match(
    document.querySelector(".inline-spec")!.textContent!,
    /Proposition/,
  );
  assert.equal(
    document.querySelectorAll('.api-source a[href*="/runs/"]').length,
    24,
  );
  const firstCode = document.querySelector(".inline-spec pre code")!;
  assert.match(firstCode.textContent!, /fxhash_adapted\.FxHasher/);
  assert.match(firstCode.textContent!, /Result\.ok/);
  assert.doesNotMatch(firstCode.textContent!, /@Eq\.\{/);
  assert(firstCode.querySelector('a[href^="https://github.com/"]'));

  assert.match(document.body.textContent!, /Staging copy/);
  db.close();
});
