// One-time operator rollout. Never upload local data to Actions artifacts/logs.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { planMigration, migrateRecord } from "./migrate-run-dependencies.mjs";
import { readRecord } from "../src/runs.ts";
const digest = (b) => createHash("sha256").update(b).digest("hex");
import { gate, MARKER } from "./dependency-rollout-gate.mjs";
export function maintenanceConfig(config, token) {
  return {
    ...config,
    main: "scripts/dependency-maintenance.ts",
    vars: {
      ...config.vars,
      DEPENDENCY_MIGRATION_TOKEN_HASH: digest(Buffer.from(token)),
    },
    queues: {
      ...config.queues,
      consumers: config.queues.consumers.map((x) => ({
        ...x,
        max_retries: 100,
      })),
    },
  };
}
export function atomicStatements(sql) {
  const statements = sql
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("--"));
  statements.push(
    `INSERT OR REPLACE INTO settings(key,value) VALUES('${MARKER}','complete');`,
  );
  return statements;
}
async function command(args, env = process.env) {
  // Capture output: SQL exports and CLI failures must never enter Actions logs.
  await new Promise((resolvePromise, reject) => {
    const child = spawn("npx", ["--no-install", "wrangler", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    child.on("error", () =>
      reject(Error("Wrangler operation could not start")),
    );
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(Error(`Wrangler ${args[0]} operation failed`)),
    );
  });
}
export async function migrateArchive(
  index,
  client,
  archive,
  output,
  backupPrefix,
) {
  for (const row of index) {
    const bytes = Buffer.from(
      await client("GET", "object", undefined, row.r2_key),
    );
    // Verify even records which are already current. The planner checks again.
    const result = migrateRecord(bytes, row);
    readRecord(JSON.parse((result?.bytes || bytes).toString()));
    const path = resolve(archive, row.r2_key);
    if (!path.startsWith(resolve(archive) + "/"))
      throw Error("Invalid archive backup path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
    await client(
      "PUT",
      "object",
      bytes,
      `${backupPrefix}/runs/${row.id}.sarif.json`,
    );
  }
  const manifest = await planMigration(index, archive, output);
  for (const entry of manifest) {
    const bytes = await readFile(join(output, entry.key));
    // Outside runs/: an old scheduled invocation cannot sweep unindexed new objects.
    entry.key = `dependency-snapshots-v2/${entry.id}.dependencies-v2.${entry.sha256}.sarif.json`;
    await client("PUT", "object", bytes, entry.key);
    const stored = Buffer.from(
      await client("GET", "object", undefined, entry.key),
    );
    if (digest(stored) !== entry.sha256 || stored.length !== entry.size)
      throw Error("Migrated archive verification failed");
  }
  // All transformed R2 objects are verified before any index changes.
  let sql = await readFile(join(output, "apply.sql"), "utf8");
  const offlineManifest = JSON.parse(
    await readFile(join(output, "manifest.json"), "utf8"),
  );
  for (const entry of manifest) {
    const old = offlineManifest.find((x) => x.id === entry.id).key;
    sql = sql.replaceAll(
      old.replaceAll("'", "''"),
      entry.key.replaceAll("'", "''"),
    );
  }
  await client("POST", "apply", { statements: atomicStatements(sql) });
  const after = await client("GET", "index");
  const snapshots = await client("GET", "snapshots");
  if (after.length !== index.length)
    throw Error("Run count changed during maintenance");
  for (const row of after) {
    const bytes = Buffer.from(
      await client("GET", "object", undefined, row.r2_key),
    );
    if (migrateRecord(bytes, row) !== null)
      throw Error("Legacy record remains after migration");
    const record = readRecord(JSON.parse(bytes.toString()));
    const key = (value) =>
      JSON.stringify([value.crate, value.version, value.source]);
    const saved = snapshots
      .filter((x) => x.run_id === row.id)
      .map(key)
      .sort();
    if (
      JSON.stringify(saved) !==
      JSON.stringify(record.dependencies.map(key).sort())
    )
      throw Error("Stored dependency snapshot mismatch");
  }
  return manifest.length;
}
export function assertStagingTarget(config, origin) {
  const resource = "proofs-rs-staging-reports-v1";
  if (
    config.name !== "proofs-rs-staging" ||
    config.vars?.ENVIRONMENT !== "staging" ||
    origin !== "https://proofs-rs-staging.proofs-rs.workers.dev" ||
    config.vars.APP_ORIGIN !== origin ||
    (config.routes?.length || 0) !== 0 ||
    config.d1_databases?.length !== 1 ||
    config.d1_databases[0].binding !== "DB" ||
    config.d1_databases[0].database_name !== resource ||
    config.r2_buckets?.length !== 1 ||
    config.r2_buckets[0].binding !== "ARCHIVE" ||
    config.r2_buckets[0].bucket_name !== resource ||
    config.queues?.producers?.length !== 1 ||
    config.queues.producers[0].queue !== "proofs-rs-staging-reports-jobs" ||
    config.queues?.consumers?.length !== 1 ||
    config.queues.consumers[0].queue !== "proofs-rs-staging-reports-jobs" ||
    config.queues.consumers[0].dead_letter_queue !==
      "proofs-rs-staging-reports-dead"
  )
    throw Error("Expected isolated staging resources and origin");
}
async function rollout(configPath, origin, staging = false) {
  if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN)
    throw Error(
      "Existing Cloudflare credentials are required; no deployment attempted",
    );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (staging) {
    assertStagingTarget(config, origin);
    try {
      await gate(config);
      console.log(
        "Staging dependency migration already complete; normal deployment may proceed.",
      );
      return;
    } catch (error) {
      if (
        !error.message.startsWith(
          "Dependency snapshot v2 rollout is incomplete.",
        )
      )
        throw error;
    }
  }
  if (
    !staging &&
    (config.vars?.ENVIRONMENT !== "production" || config.name !== "proofs-rs")
  )
    throw Error("Expected production deployment config");
  if (!/^https:\/\//.test(origin))
    throw Error("Maintenance origin must use HTTPS");
  const token = randomBytes(32).toString("hex"),
    backupPrefix = `backups/dependency-review-migration/${randomUUID()}`;
  const work = await mkdtemp(join(tmpdir(), "proofs-rollout-"));
  const maintenancePath = resolve(
    `.dependency-maintenance-${randomUUID()}.json`,
  );
  const client = async (method, action, body, key, cursor) => {
    const url = new URL(`/__dependency_migration/${action}`, origin);
    if (key) url.searchParams.set("key", key);
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type":
          body instanceof Buffer
            ? "application/octet-stream"
            : "application/json",
      },
      body:
        body === undefined
          ? undefined
          : body instanceof Buffer
            ? body
            : JSON.stringify(body),
    });
    if (!response.ok)
      throw Error(
        `Maintenance ${action} operation failed (${response.status})`,
      );
    return method === "GET" && action === "object"
      ? response.arrayBuffer()
      : response.json();
  };
  try {
    await writeFile(
      maintenancePath,
      JSON.stringify(maintenanceConfig(config, token)),
      { mode: 0o600 },
    );
    await command(["deploy", "--config", maintenancePath]);
    console.log(
      "Maintenance Worker deployed; writes, scheduled work and queue processing stopped.",
    );
    // Wait for deployment propagation before invoking the protected maintenance API.
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await client("GET", "index");
        ready = true;
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
      }
    }
    if (!ready) throw Error("Maintenance deployment did not become reachable");
    // Fence old in-flight D1 writes before the backup. Keep retries queued.
    await client("POST", "lock", {});
    // Queue/scheduled old invocations have a 15-minute wall-time ceiling. Give
    // them a full drain window before releasing the write fences. Log no data.
    console.log(
      "Draining previous invocations for 16 minutes while D1 writes are fenced.",
    );
    for (let minute = 0; minute < 16; minute++)
      await new Promise((resolveWait) => setTimeout(resolveWait, 60_000));
    // Confirm this exact maintenance deployment is serving before snapshotting.
    const index = await client("GET", "index");
    const dump = join(work, "database.sql");
    const exportEnv = {
      ...process.env,
      CLOUDFLARE_API_TOKEN:
        process.env.CLOUDFLARE_D1_BACKUP_TOKEN ||
        process.env.CLOUDFLARE_API_TOKEN,
    };
    await command(
      [
        "d1",
        "export",
        "DB",
        "--remote",
        "--config",
        configPath,
        "--output",
        dump,
      ],
      exportEnv,
    );
    const dumpBytes = await readFile(dump);
    await client("PUT", "object", dumpBytes, `${backupPrefix}/database.sql`);
    const backup = Buffer.from(
      await client("GET", "object", undefined, `${backupPrefix}/database.sql`),
    );
    if (digest(backup) !== digest(dumpBytes))
      throw Error("Database backup verification failed");
    let cursor;
    do {
      const page = await client(
        "GET",
        "archive-page",
        undefined,
        undefined,
        cursor,
      );
      for (const key of page.keys)
        await client("POST", "copy", {
          source: key,
          key: `${backupPrefix}/archive/${key}`,
        });
      cursor = page.cursor;
    } while (cursor);
    await command([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--remote",
      "--config",
      configPath,
    ]);
    const changed = await migrateArchive(
      index,
      client,
      join(work, "archive"),
      join(work, "converted"),
      backupPrefix,
    );
    await client("POST", "unlock", {});
    await gate(config);
    // Only the reviewed schema-v2 Worker can resume serving. Never restore the old Worker.
    await command(["deploy", "--config", configPath]);
    console.log(
      `Dependency rollout complete; ${changed} run records converted and the schema-v2 Worker deployed. Private backups remain in R2.`,
    );
  } catch {
    console.error(
      "Dependency rollout failed. Keep the target environment in maintenance and rerun the dedicated workflow after investigation; do not restore the old Worker. Private backups remain in R2.",
    );
    throw Error("Dependency rollout failed; no automatic rollback performed");
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(maintenancePath, { force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, configPath, origin] = process.argv.slice(2);
  if (mode === "migrate") await rollout(configPath, origin);
  else if (mode === "staging") await rollout(configPath, origin, true);
  else
    throw Error(
      "Usage: node --import tsx scripts/dependency-rollout.mjs migrate config.json [https://origin]",
    );
}
