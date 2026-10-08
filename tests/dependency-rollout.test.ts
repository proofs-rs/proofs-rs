import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import maintenance from "../scripts/dependency-maintenance";
import {
  maintenanceConfig,
  assertStagingTarget,
  migrateArchive,
} from "../scripts/dependency-rollout.mjs";
import { gate, MARKER } from "../scripts/dependency-rollout-gate.mjs";
const hash = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE verification_runs(id TEXT PRIMARY KEY,r2_key TEXT,sha256 TEXT,size INTEGER); CREATE TABLE run_dependencies(run_id TEXT,crate TEXT,version TEXT,source TEXT); CREATE TABLE ordinary_data(id TEXT);",
  );
  const objects = new Map<string, Uint8Array>();
  const prepare = (sql: string) => {
    let params: any[] = [];
    const query = {
      bind(...values: any[]) {
        params = values;
        return query;
      },
      async all() {
        return { results: db.prepare(sql).all(...params) };
      },
      async first() {
        return db.prepare(sql).get(...params) || null;
      },
      async run() {
        return db.prepare(sql).run(...params);
      },
      sql,
    };
    return query;
  };
  const env: any = {
    DEPENDENCY_MIGRATION_TOKEN_HASH: hash(Buffer.from("operator")),
    DB: {
      prepare,
      async batch(statements: any[]) {
        db.exec("BEGIN");
        try {
          for (const s of statements) db.exec(s.sql);
          db.exec("COMMIT");
          return [];
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    ARCHIVE: {
      async list() {
        return {
          objects: [...objects.keys()].map((key) => ({ key })),
          truncated: false,
        };
      },
      async get(key: string) {
        const bytes = objects.get(key);
        return bytes
          ? {
              body: bytes,
              async arrayBuffer() {
                return Uint8Array.from(bytes).buffer;
              },
            }
          : null;
      },
      async put(key: string, value: ArrayBuffer) {
        objects.set(key, new Uint8Array(value));
      },
    },
  };
  const client = async (
    method: string,
    action: string,
    body?: any,
    key?: string,
  ): Promise<any> => {
    const url = new URL(`https://proofs.rs/__dependency_migration/${action}`);
    if (key) url.searchParams.set("key", key);
    const response = await maintenance.fetch(
      new Request(url, {
        method,
        headers: { Authorization: "Bearer operator" },
        body:
          body === undefined
            ? undefined
            : Buffer.isBuffer(body)
              ? body
              : JSON.stringify(body),
      }),
      env,
    );
    if (!response.ok)
      throw Error(`migration ${action} failed (${response.status})`);
    return method === "GET" && action === "object"
      ? response.arrayBuffer()
      : response.json();
  };
  return { db, objects, env, client };
}
test("maintenance config retains production resources and secrets remain outside configuration", async () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../wrangler.production.base.json", import.meta.url),
      "utf8",
    ),
  );
  const temp = maintenanceConfig(config, "operator");
  for (const field of [
    "name",
    "routes",
    "d1_databases",
    "r2_buckets",
    "assets",
    "triggers",
  ])
    assert.deepEqual(temp[field], config[field]);
  assert.equal(temp.main, "scripts/dependency-maintenance.ts");
  assert.equal(temp.queues.consumers[0].max_retries, 100);
  assert.equal(JSON.stringify(temp).includes('"operator"'), false);
  const { env, db } = fixture();
  try {
    const response = await maintenance.fetch(
      new Request("https://proofs.rs/api/v1/reports", {
        method: "POST",
        body: "{}",
      }),
      env,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    await maintenance.scheduled();
    let retry: any;
    await maintenance.queue({
      retryAll(options: any) {
        retry = options;
      },
    } as any);
    assert.deepEqual(retry, { delaySeconds: 3600 });
  } finally {
    db.close();
  }
});
test("D1 write fences also stop old invocations and migration batches roll back atomically", async () => {
  const { db, client } = fixture();
  try {
    await client("POST", "lock", {});
    await client("POST", "lock", {});
    assert.throws(
      () => db.exec("INSERT INTO ordinary_data VALUES('late old invocation')"),
      /maintenance/,
    );
    await assert.rejects(
      client("POST", "apply", {
        statements: [
          "INSERT INTO ordinary_data VALUES('migration')",
          "CREATE TABLE fail_guard(ok INTEGER CHECK(ok=1))",
          "INSERT INTO fail_guard VALUES(0)",
        ],
      }),
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM ordinary_data").get()!.n,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM dependency_rollout_control").get()!.n,
      0,
    );
    await assert.rejects(client("POST", "unlock", {}));
    await client("POST", "apply", {
      statements: [`INSERT INTO settings VALUES('${MARKER}','complete')`],
    });
    assert.throws(
      () => db.exec("INSERT INTO ordinary_data VALUES('still blocked')"),
      /maintenance/,
    );
    await client("POST", "unlock", {});
    db.exec("INSERT INTO ordinary_data VALUES('new Worker')");
  } finally {
    db.close();
  }
});
test("archive migration backs up private originals, avoids the old sweep and verifies indexes", async () => {
  const { db, client, objects } = fixture(),
    work = await mkdtemp(join(tmpdir(), "proofs-rollout-test-"));
  try {
    const document = JSON.parse(
      readFileSync(
        new URL("../fixtures/layout-run-0.sarif.json", import.meta.url),
        "utf8",
      ),
    );
    const run = document.runs[0];
    run.properties.proofs.schemaVersion = 1;
    delete run.properties.proofs.dependencies;
    const bytes = Buffer.from(JSON.stringify(document)),
      id = run.automationDetails.guid,
      key = "runs/author/original.sarif.json";
    objects.set(key, bytes);
    db.prepare("INSERT INTO verification_runs VALUES(?,?,?,?)").run(
      id,
      key,
      hash(bytes),
      bytes.length,
    );
    await client("POST", "lock", {});
    assert.equal(
      await migrateArchive(
        await client("GET", "index"),
        client,
        join(work, "archive"),
        join(work, "converted"),
        "backups/dependency-review-migration/test",
      ),
      1,
    );
    const row: any = db.prepare("SELECT * FROM verification_runs").get();
    assert.equal(row.r2_key.startsWith("dependency-snapshots-v2/"), true);
    assert.deepEqual(objects.get(key), bytes);
    assert.deepEqual(
      Buffer.from(
        objects.get(
          `backups/dependency-review-migration/test/runs/${id}.sarif.json`,
        )!,
      ),
      bytes,
    );
    const converted = objects.get(row.r2_key)!;
    assert.equal(hash(converted), row.sha256);
    assert.equal(converted.length, row.size);
    assert.deepEqual(
      JSON.parse(Buffer.from(converted).toString()).runs[0].properties.proofs
        .dependencies,
      [],
    );
    assert.equal(
      db.prepare("SELECT value FROM settings WHERE key=?").get(MARKER)!.value,
      "complete",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM dependency_rollout_control").get()!.n,
      0,
    );
    await client("POST", "unlock", {});
  } finally {
    db.close();
    await rm(work, { recursive: true, force: true });
  }
});
test("normal deploy gate blocks incomplete and fenced rollouts without conversion logic", async () => {
  const config = { d1_databases: [{ binding: "DB", database_id: "test" }] },
    env = {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "private-token",
    };
  for (const row of [
    undefined,
    { value: "complete", maintenance: 1 },
    { value: "pending", maintenance: 0 },
  ])
    await assert.rejects(
      gate(
        config,
        async () =>
          Response.json({
            success: true,
            result: [{ results: row ? [row] : [] }],
          }),
        env,
      ),
      /incomplete/,
    );
  await gate(
    config,
    async () =>
      Response.json({
        success: true,
        result: [{ results: [{ value: "complete", maintenance: 0 }] }],
      }),
    env,
  );
  await assert.rejects(
    gate(
      config,
      async () => new Response("private error contents", { status: 403 }),
      env,
    ),
    /could not read D1/,
  );
  const workflow = readFileSync(
    new URL("../.github/workflows/production.yml", import.meta.url),
    "utf8",
  );
  assert.ok(
    workflow.indexOf("dependency-rollout-gate.mjs") <
      workflow.indexOf("d1 migrations apply"),
  );
  const oneTime = readFileSync(
    new URL("../.github/workflows/dependency-rollout.yml", import.meta.url),
    "utf8",
  );
  assert.match(oneTime, /branches: \[ops\/dependency-review-migration\]/);
  assert.match(oneTime, /github.repository == 'proofs-rs\/proofs-rs'/);
  assert.equal(oneTime.includes("upload-artifact"), false);
  assert.equal(oneTime.includes("scripts/secrets.mjs"), false);
});

test("private archive backups include non-SARIF evidence and never recursively copy backups", async () => {
  const { db, objects, client } = fixture();
  try {
    objects.set("docs/private.json", Buffer.from("private catalogue"));
    objects.set("backups/old/database.sql", Buffer.from("old backup"));
    assert.deepEqual((await client("GET", "archive-page")).keys, [
      "docs/private.json",
    ]);
    await client("POST", "copy", {
      source: "docs/private.json",
      key: "backups/dependency-review-migration/test/archive/docs/private.json",
    });
    assert.equal(
      Buffer.from(
        objects.get(
          "backups/dependency-review-migration/test/archive/docs/private.json",
        )!,
      ).toString(),
      "private catalogue",
    );
    await assert.rejects(
      client("POST", "copy", {
        source: "docs/private.json",
        key: "docs/overwrite.json",
      }),
    );
    assert.equal(objects.has("docs/overwrite.json"), false);
  } finally {
    db.close();
  }
});

test("staging rollout rejects production resources before maintenance", () => {
  const config = JSON.parse(
    readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"),
  );
  const origin = "https://proofs-rs-staging.proofs-rs.workers.dev";
  config.vars.APP_ORIGIN = origin;
  assertStagingTarget(config, origin);
  for (const mutate of [
    (x: any) => {
      x.name = "proofs-rs";
    },
    (x: any) => {
      x.vars.ENVIRONMENT = "production";
    },
    (x: any) => {
      x.d1_databases[0].database_name = "proofs-rs-production-reports-v1";
    },
    (x: any) => {
      x.r2_buckets[0].bucket_name = "proofs-rs-production-reports-v1";
    },
    (x: any) => {
      x.queues.consumers[0].queue = "proofs-rs-production-reports-jobs";
    },
    (x: any) => {
      x.routes = [{ pattern: "proofs.rs", custom_domain: true }];
    },
  ]) {
    const wrong = structuredClone(config);
    mutate(wrong);
    assert.throws(() => assertStagingTarget(wrong, origin), /isolated staging/);
  }
  assert.throws(
    () => assertStagingTarget(config, "https://proofs.rs"),
    /isolated staging/,
  );
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy.yml", import.meta.url),
    "utf8",
  );
  assert.ok(
    workflow.indexOf("dependency-rollout.mjs staging") <
      workflow.indexOf("d1 migrations apply"),
  );
  assert.ok(
    workflow.indexOf("dependency-rollout-gate.mjs") <
      workflow.indexOf("wrangler deploy"),
  );
  assert.match(workflow, /group: proofs-rs-staging/);
});
