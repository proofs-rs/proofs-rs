/** Explicit integration check using unchanged SARIF from tests/real_creusot.py. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { app } from "../src/worker";
import { sarif } from "../src/schemas";
import { fixture } from "./support/service-fixture";

test("real Creusot SARIF survives ingestion, Report creation and Claim rendering", async () => {
  assert(
    process.env.PROOFS_REAL_CREUSOT_SARIF,
    "Supply freshly generated real Creusot SARIF",
  );
  const raw = readFileSync(process.env.PROOFS_REAL_CREUSOT_SARIF);
  const run = sarif.parse(JSON.parse(raw.toString())).runs[0];
  assert.equal(run.tool.driver.name, "creusot");
  assert.equal(run.tool.driver.version, "0.13.0");
  const contracts = run.properties.proofs.contracts;
  assert.equal(contracts.length, 3);
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
  db.prepare(
    "INSERT INTO tools(id,name,description,official_url,active) VALUES('creusot','Creusot','Real integration test','https://github.com/creusot-rs/creusot',1)",
  ).run();
  db.prepare(
    "INSERT INTO tool_versions(id,tool_id,version,selectable) VALUES('real-creusot','creusot','0.13.0',1)",
  ).run();
  const rid = run.automationDetails.guid;
  let uploaded: any;
  const sha = createHash("sha256").update(raw).digest("hex");
  for (const path of [
    "/runs/prepare",
    `/runs/${rid}/sarif`,
    `/runs/${rid}/sarif`,
  ]) {
    const response = await app.request(
      env.APP_ORIGIN + "/api/v1" + path,
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
    const body: any = await response.json();
    assert.equal(
      response.status,
      path === "/runs/prepare" || uploaded ? 200 : 201,
      JSON.stringify(body),
    );
    assert.equal(body.sha256, sha);
    assert.equal(body.apis.length, 3);
    if (path === "/runs/prepare") assert.equal(objects.size, 0);
    else if (uploaded) assert.deepEqual(body, uploaded);
    else uploaded = body;
  }
  assert.equal(objects.size, 1);
  assert.deepEqual(
    [...objects.values()][0],
    raw,
    "Stored evidence bytes changed",
  );
  const body = {
    crate: run.properties.proofs.crate,
    version: run.properties.proofs.version,
    title: "Real Creusot integration check",
    tool_version_id: "real-creusot",
    run_ids: [rid],
    evidence_url: run.versionControlProvenance[0].repositoryUri,
    claims: uploaded.apis.map((api: any, i: number) => {
      assert.equal(api.contract_index, i);
      assert(contracts[i].api_paths.includes(api.display_path));
      return {
        api_item_id: api.api_item_id,
        precondition: contracts[i].precondition,
        evidence_ref: { run_id: rid, harness: contracts[i].harness },
      };
    }),
  };
  const validated = await request("/reports/validate", "POST", body);
  assert.equal(validated.status, 200, JSON.stringify(validated));
  const created = await request("/reports", "POST", body);
  assert.equal(created.status, 201, JSON.stringify(created));
  const report = await request(`/reports/${created.body.id}`);
  assert.equal(report.status, 200);
  assert.equal(report.body.claims.length, 3);
  for (const claim of report.body.claims) {
    const detail = await request(`/claims/${claim.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.precondition, claim.precondition);
    const contract = contracts.find(
      (c) => c.harness === claim.evidence_ref.harness,
    )!;
    assert(contract.formal?.kind === "creusot");
    for (const field of [
      "version",
      "signature",
      "requires",
      "ensures",
    ] as const)
      assert.deepEqual(
        detail.body.formal_evidence[field],
        contract.formal[field],
      );
    assert(
      detail.body.formal_evidence.source_url.includes(
        run.versionControlProvenance[0].revisionId,
      ),
    );
    const response = await app.request(
      env.APP_ORIGIN + `/claim/${claim.id}`,
      {},
      env,
    );
    assert.equal(response.status, 200);
    const document = new JSDOM(await response.text()).window.document;
    assert(document.body.textContent?.includes(claim.precondition));
    assert(
      document
        .querySelector(".creusot-spec code")
        ?.textContent?.includes(contract.formal.signature),
    );
    for (const expression of [
      ...contract.formal.requires,
      ...contract.formal.ensures,
    ])
      assert(
        document
          .querySelector(".creusot-spec code")
          ?.textContent?.includes(expression),
      );
    assert(
      document.querySelector(
        `a[href="${detail.body.formal_evidence.source_url}"]`,
      ),
    );
    assert(
      document.querySelector(
        `a[href="${detail.body.formal_evidence.check_url}"]`,
      ),
    );
    const checkURL = new URL(
      detail.body.formal_evidence.check_url,
      env.APP_ORIGIN,
    );
    const checked = await app.request(checkURL.href, {}, env);
    assert.equal(checked.status, 200);
    assert(
      new JSDOM(await checked.text()).window.document.getElementById(
        checkURL.hash.slice(1),
      ),
    );
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM import_jobs").get()!.n, 0);
});

test(
  "real Creusot recorded evidence renders in CLI preview",
  { timeout: 30000 },
  async (t) => {
    assert(process.env.PROOFS_REAL_CREUSOT_SARIF);
    const output = dirname(resolve(process.env.PROOFS_REAL_CREUSOT_SARIF));
    const original = readFileSync(process.env.PROOFS_REAL_CREUSOT_SARIF);
    const originalSarif = JSON.parse(original.toString());
    const run = sarif.parse(originalSarif).runs[0];
    const child = spawn(
      resolve(process.env.PROOFS_TEST_CLI ?? "cli/target/debug/cargo-proofs"),
      ["--server", "http://127.0.0.1:1", "preview", "--no-browser"],
      {
        cwd: join(output, "source"),
        env: {
          ...process.env,
          XDG_DATA_HOME: join(output, "data"),
          PROOFS_CONFIG_DIR: join(output, "preview-credentials"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let log = "";
    child.stderr.on("data", (data) => {
      log += data.toString();
    });
    t.after(async () => {
      const exited = once(child, "exit");
      child.kill("SIGINT");
      const [code] = await exited;
      writeFileSync(join(output, "preview.log"), log);
      assert.equal(code, 0, log);
    });
    const url = await new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.on("data", (data) => {
        log += data.toString();
        const match = log.match(/http:\/\/127\.0\.0\.1:\d+\/report/);
        if (match) resolve(match[0]);
      });
    });
    const base = url.replace(/\/report$/, "");
    for (const [index, contract] of run.properties.proofs.contracts.entries()) {
      const response = await fetch(`${base}/claim/preview-claim-${index}`);
      assert.equal(response.status, 200);
      const document = new JSDOM(await response.text()).window.document;
      assert(document.body.textContent?.includes(contract.precondition));
      assert(contract.formal?.kind === "creusot");
      assert(
        document
          .querySelector(".creusot-spec code")
          ?.textContent?.includes(contract.formal.signature),
      );
      for (const expression of [
        ...contract.formal.requires,
        ...contract.formal.ensures,
      ])
        assert(
          document
            .querySelector(".creusot-spec code")
            ?.textContent?.includes(expression),
        );
      const check = document.querySelector<HTMLAnchorElement>(
        ".creusot-spec a[href^='/runs/']",
      );
      assert(check);
      const checkURL = new URL(check.getAttribute("href")!, base);
      const checked = await fetch(checkURL);
      assert.equal(checked.status, 200);
      assert(
        new JSDOM(await checked.text()).window.document.getElementById(
          checkURL.hash.slice(1),
        ),
      );
    }
    const response = await fetch(
      `${base}/api/v1/runs/${run.automationDetails.guid}/sarif`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), originalSarif);
  },
);
