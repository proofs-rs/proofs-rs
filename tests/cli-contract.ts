/** Mandatory producer→consumer gate. Deliberately not a *.test.ts optional test:
 * npm run test:recording-contract must fail when its generated corpus is absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fixture } from "./support/service-fixture";
import { assertResponseContract } from "./api-contract";
import * as S from "../src/schemas";

const manifestPath = process.env.PROOFS_CLI_CONTRACT;
assert(
  manifestPath,
  "PROOFS_CLI_CONTRACT must name a freshly generated CLI corpus; skipping is forbidden",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const registry = JSON.parse(
  readFileSync(
    new URL(
      "../cli/tests/fixtures/recording-contract-cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
assert.equal(manifest.formatVersion, registry.formatVersion);
assert.equal(
  manifest.producer.gitRevision,
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  "Corpus must be produced by this checkout",
);
assert.match(manifest.producer.binarySha256, /^[a-f0-9]{64}$/);
const producerBinary = resolve(
  process.env.PROOFS_TEST_CLI ?? "cli/target/debug/cargo-proofs",
);
assert.equal(
  createHash("sha256").update(readFileSync(producerBinary)).digest("hex"),
  manifest.producer.binarySha256,
  "Corpus must come from this producer binary",
);
assert.equal(manifest.producer.verifiers, "synthetic; wire contract only");
assert(
  Array.isArray(manifest.cases) && manifest.cases.length,
  "Empty corpus is not accepted",
);
const ids = manifest.cases.map((c: any) => c.id);
assert.equal(new Set(ids).size, ids.length, "Duplicate cases");
for (const [id, requirement] of Object.entries(registry.cases) as [
  string,
  any,
][]) {
  const c = manifest.cases.find((c: any) => c.id === id);
  assert(c, `Missing mandatory export case: ${id}`);
  assert.equal(c.expect, requirement.expect, id);
}
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function retained(actual: any, expected: any, path = "formal") {
  if (Array.isArray(expected)) {
    assert(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, path);
    expected.forEach((v, i) => retained(actual[i], v, `${path}[${i}]`));
  } else if (expected && typeof expected === "object") {
    assert(actual && typeof actual === "object", path);
    for (const [k, v] of Object.entries(expected))
      retained(actual[k], v, `${path}.${k}`);
  } else assert.deepEqual(actual, expected, path);
}
const root = realpathSync(dirname(manifestPath));
for (const c of manifest.cases)
  test(`CLI recording contract: ${c.id}`, async () => {
    assert(["accept", "reject"].includes(c.expect), "Unknown expected outcome");
    assert(typeof c.file === "string" && !isAbsolute(c.file));
    const file = realpathSync(resolve(root, c.file));
    const rel = relative(root, file);
    assert(
      rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel),
      "Corpus escaped its directory",
    );
    const raw = readFileSync(file);
    assert.equal(sha(raw), c.sha256, "Exact CLI bytes changed");
    const sarif = JSON.parse(raw.toString());
    const run = sarif.runs[0];
    const p = run.properties.proofs;
    assert.equal(p.recorderVersion, manifest.producer.recorderVersion);
    assert.equal(p.schemaVersion, registry.schemaVersion);
    const required = registry.cases[c.id];
    if (required) {
      assert.equal(run.tool.driver.name.toLowerCase(), required.tool);
      if (required.target) assert.equal(p.target, required.target);
      if (required.discovery)
        assert.equal(p.aeneas.api_discovery.mode, required.discovery);
      if (required.mapping)
        assert(
          p.contracts.length &&
            p.contracts.every(
              (x: any) => x.formal?.mapping === required.mapping,
            ),
        );
      const paths = p.contracts.flatMap((x: any) => x.api_paths);
      for (const feature of required.requires ?? []) {
        if (feature === "structural-path")
          assert(
            paths.some(
              (x: string) => x.startsWith("<") && x.includes("[u8; 32]"),
            ),
          );
        else if (feature === "aliases")
          assert(p.contracts.some((x: any) => x.api_paths.length > 1));
        else if (feature === "dependency") assert(p.dependencies.length);
        else if (feature === "claim-limit")
          assert.equal(p.contracts.length, S.MAX_REPORT_CLAIMS);
        else if (feature === "concrete-path")
          assert(
            paths.some(
              (x: string) => x.includes("Crc<u8") && x.includes("Table<0>"),
            ),
          );
        else if (feature === "inherited-default")
          assert(paths.some((x: string) => x.endsWith("::clone_from")));
        else if (feature === "toolchain") {
          assert(p.toolchain?.components?.aeneas);
          assert(p.toolchain_input);
        } else if (feature === "multiple-theorems")
          assert(p.contracts.length > new Set(paths).size);
        else assert.fail(`No semantic coverage assertion for ${feature}`);
      }
    }
    const { db, env, request } = await fixture(false);
    const objects = new Map<string, Buffer>();
    env.ARCHIVE = {
      put: async (key: string, bytes: ArrayBuffer) =>
        objects.set(key, Buffer.from(bytes)),
      get: async (key: string) => {
        const value = objects.get(key);
        return value
          ? {
              json: async () => JSON.parse(value.toString()),
              text: async () => value.toString(),
              body: new Response(new Uint8Array(value).buffer).body,
            }
          : null;
      },
      delete: async (key: string) => objects.delete(key),
    } as any;
    const driver = run.tool.driver;
    const tool = driver.name.toLowerCase();
    const tv = `contract-${tool}-${driver.version}`;
    db.prepare(
      "INSERT INTO tools(id,name,description,official_url,active) VALUES(?,?,?,'https://example.test',1) ON CONFLICT DO NOTHING",
    ).run(tool, driver.name, "Synthetic contract verifier");
    db.prepare(
      "INSERT INTO tool_versions(id,tool_id,version,selectable) VALUES(?,?,?,1) ON CONFLICT DO NOTHING",
    ).run(tv, tool, driver.version);
    // Use production raw-body handlers and unchanged bytes, not the E2E mock.
    async function send(path: string) {
      const response = await (
        await import("../src/worker")
      ).app.request(
        "https://example.test/api/v1" + path,
        {
          method: "POST",
          headers: {
            Origin: env.APP_ORIGIN,
            Cookie: "__Host-proofsr_session=alice",
            "X-CSRF-Token": "csrf",
            "Content-Type": "application/sarif+json",
          },
          body: new Uint8Array(raw).buffer,
        },
        env,
      );
      const body = await response.json();
      await assertResponseContract(
        "/api/v1" + path,
        "POST",
        response.status,
        body,
      );
      return { status: response.status, body: body as any };
    }
    const prepared = await send("/runs/prepare");
    assert.equal(objects.size, 0, "Preparation stored an artifact");
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM api_items").get()!.n,
      2,
      "Preparation changed catalogue",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM verification_runs").get()!.n,
      0,
      "Preparation created a run",
    );
    const rid = run.automationDetails.guid;
    if (c.expect === "reject") {
      assert(
        prepared.status >= 400 && prepared.status < 500,
        JSON.stringify(prepared),
      );
      const rejected = await send(`/runs/${rid}/sarif`);
      assert(rejected.status >= 400 && rejected.status < 500);
      assert.equal(objects.size, 0);
      return;
    }
    const parsed = S.sarif.safeParse(sarif);
    assert(
      parsed.success,
      "Producer and wire schema differ: " +
        JSON.stringify(parsed.success ? null : parsed.error.issues),
    );
    assert.equal(
      prepared.status,
      200,
      `${c.id}: ${JSON.stringify(prepared.body)}`,
    );
    assert.equal(prepared.body.sha256, c.sha256);
    assert.equal(prepared.body.apis.length, p.contracts.length);
    const uploaded = await send(`/runs/${rid}/sarif`);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded));
    assert.deepEqual(uploaded.body.apis, prepared.body.apis);
    assert.equal(uploaded.body.sha256, c.sha256);
    assert.equal(
      sha([...objects.values()][0]),
      c.sha256,
      "Stored bytes differ from actual export",
    );
    assert.deepEqual(
      (await send(`/runs/${rid}/sarif`)).body,
      uploaded.body,
      "Retry changed immutable binding",
    );
    const body = {
      crate: p.crate,
      version: p.version,
      title: `Contract ${c.id}`,
      tool_version_id: tv,
      run_ids: [rid],
      evidence_url: "https://github.com/fixture/source",
      claims: uploaded.body.apis.map((a: any, i: number) => {
        assert.equal(a.contract_index, i);
        assert(p.contracts[i].api_paths.includes(a.display_path));
        return {
          api_item_id: a.api_item_id,
          precondition: p.contracts[i].precondition,
          ...(p.contracts[i].formal
            ? { evidence_ref: { run_id: rid, harness: p.contracts[i].harness } }
            : {}),
        };
      }),
    };
    const valid = await request("/reports/validate", "POST", body);
    assert.equal(valid.status, 200, JSON.stringify(valid));
    const published = await request("/reports", "POST", body);
    assert.equal(published.status, 201, JSON.stringify(published));
    const report = (await request(`/reports/${published.body.id}`)).body;
    assert.equal(report.claims.length, p.contracts.length);
    for (const claim of report.claims)
      if (claim.evidence_ref) {
        const detail = await request(`/claims/${claim.id}`);
        assert.equal(detail.status, 200);
        const formal = p.contracts.find(
          (x: any) => x.harness === claim.evidence_ref.harness,
        ).formal;
        assert.equal(detail.body.formal_evidence.theorem, formal.theorem);
        assert.equal(detail.body.formal_evidence.statement, formal.statement);
        assert.equal(detail.body.formal_evidence.mapping, formal.mapping);
        retained(detail.body.formal_evidence, formal);
      }
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM import_jobs").get()!.n,
      0,
      "Ingestion called independent rustdoc importer",
    );
  });
