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
export function safeFailureCode(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  for (const [prefix, code] of [
    ["Archive hash/size mismatch", "archive_hash_size_mismatch"],
    ["Archive run ID mismatch", "archive_run_id_mismatch"],
    ["Unsupported record schema", "unsupported_record_schema"],
    ["Missing v2 dependency snapshot", "missing_dependency_snapshot"],
    ["Database backup verification failed", "database_backup_mismatch"],
    ["Migrated archive verification failed", "converted_object_mismatch"],
    ["Stored dependency snapshot mismatch", "stored_snapshot_mismatch"],
    ["Legacy record remains", "legacy_record_remaining"],
    ["Run count changed", "run_count_changed"],
    ["Wrangler operation could not start", "wrangler_start_failed"],
  ])
    if (message.startsWith(prefix)) return code;
  if (
    [
      "invalid_sarif",
      "invalid_proofs_sarif",
      "embedded_log_required",
      "embedded_source_not_allowed",
      "invalid_command",
      "invalid_run_times",
      "invalid_run_contracts",
      "invalid_run_contract",
      "unverified_contract",
      "unsuccessful_run",
    ].includes(error?.code)
  )
    return error.code;
  const wrangler =
    /^Wrangler (deploy|d1) operation failed(?: \(code (\d{4,6})\))?$/.exec(
      message,
    );
  if (wrangler)
    return `wrangler_${wrangler[1]}_failed${wrangler[2] ? "_" + wrangler[2] : ""}`;
  const maintenance =
    /^Maintenance ([a-z-]+) operation failed \((\d{3})\)$/.exec(message);
  if (
    /^maintenance_[a-z-]+_(?:http_\d{3}_(?:maintenance_response|operation_failed|other_response)|network_failure)$/.test(
      error?.rolloutCode || "",
    )
  )
    return error.rolloutCode;
  if (maintenance)
    return `maintenance_${maintenance[1]}_http_${maintenance[2]}`;
  if (error instanceof SyntaxError) return "invalid_json";
  return "unclassified_failure";
}
const maintenanceActions = new Set([
  "index",
  "snapshots",
  "archive-page",
  "object",
  "copy",
  "lock",
  "unlock",
  "apply",
]);
export async function maintenanceRequest(
  method,
  action,
  url,
  options,
  fetcher = fetch,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
) {
  if (!maintenanceActions.has(action))
    throw Error("Invalid maintenance action");
  const retryable =
    method === "GET" ||
    (method === "PUT" && action === "object") ||
    (method === "POST" && ["lock", "copy"].includes(action));
  const attempts = retryable ? 12 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetcher(url, {
        ...options,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (attempt + 1 < attempts) {
        await wait(Math.min((attempt + 1) * 1000, 5000));
        continue;
      }
      const error = Error("Maintenance network request failed");
      error.rolloutCode = `maintenance_${action}_network_failure`;
      throw error;
    }
    if (response.ok) return response;
    let classification = "other_response";
    // Read only a bounded prefix, never print response contents or headers.
    const reader = response.body?.getReader();
    if (reader) {
      try {
        const { value } = await reader.read();
        const text = new TextDecoder().decode(value?.slice(0, 512)).trim();
        if (text === "Maintenance in progress. Please retry later.")
          classification = "maintenance_response";
        if (text === "Migration operation failed")
          classification = "operation_failed";
      } catch {
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    if (
      [408, 429, 502, 503, 504].includes(response.status) &&
      attempt + 1 < attempts
    ) {
      console.log(
        `Maintenance retry: action=${action} status=${response.status} response=${classification} attempt=${attempt + 1}`,
      );
      await wait(Math.min((attempt + 1) * 1000, 5000));
      continue;
    }
    const error = Error(
      `Maintenance ${action} operation failed (${response.status})`,
    );
    error.rolloutCode = `maintenance_${action}_http_${response.status}_${classification}`;
    throw error;
  }
}
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
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-32768);
    });
    child.on("error", () =>
      reject(Error("Wrangler operation could not start")),
    );
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(
            Error(
              `Wrangler ${args[0]} operation failed${/\[code:\s*(\d{4,6})\]/.exec(stderr)?.[1] ? " (code " + /\[code:\s*(\d{4,6})\]/.exec(stderr)[1] + ")" : ""}`,
            ),
          ),
    );
  });
}
export async function verifyRegisteredRecords(index, client) {
  for (const row of index) {
    const bytes = Buffer.from(
      await client("GET", "object", undefined, row.r2_key),
    );
    const migrated = migrateRecord(bytes, row);
    readRecord(JSON.parse((migrated?.bytes || bytes).toString()));
  }
}
export async function migrateArchive(
  index,
  client,
  archive,
  output,
  backupPrefix,
  progress = () => {},
) {
  progress("verify_registered_records");
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
  progress("plan_conversion");
  const manifest = await planMigration(index, archive, output);
  progress("upload_converted_records");
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
  progress("apply_guarded_index");
  await client("POST", "apply", { statements: atomicStatements(sql) });
  progress("verify_saved_snapshots");
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
    const response = await maintenanceRequest(method, action, url, {
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
    return method === "GET" && action === "object"
      ? response.arrayBuffer()
      : response.json();
  };
  let phase = "prepare_maintenance";
  const progress = (next) => {
    phase = next;
    console.log(`Dependency rollout phase: ${phase}`);
  };
  try {
    await writeFile(
      maintenancePath,
      JSON.stringify(maintenanceConfig(config, token)),
      { mode: 0o600 },
    );
    progress("deploy_maintenance");
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
    progress("fence_writes");
    await client("POST", "lock", {});
    // Read-only integrity preflight exposes deterministic archive failures before
    // the long drain; all records are checked again after backups and draining.
    progress("preflight_registered_records");
    await verifyRegisteredRecords(await client("GET", "index"), client);
    progress("drain_previous_invocations");
    // Queue/scheduled old invocations have a 15-minute wall-time ceiling. Give
    // them a full drain window before releasing the write fences. Log no data.
    console.log(
      "Draining previous invocations for 16 minutes while D1 writes are fenced.",
    );
    for (let minute = 0; minute < 16; minute++)
      await new Promise((resolveWait) => setTimeout(resolveWait, 60_000));
    // Confirm this exact maintenance deployment is serving before snapshotting.
    progress("read_run_index");
    const index = await client("GET", "index");
    const dump = join(work, "database.sql");
    const exportEnv = {
      ...process.env,
      CLOUDFLARE_API_TOKEN:
        process.env.CLOUDFLARE_D1_BACKUP_TOKEN ||
        process.env.CLOUDFLARE_API_TOKEN,
    };
    progress("export_database_backup");
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
    progress("verify_database_backup");
    const dumpBytes = await readFile(dump);
    await client("PUT", "object", dumpBytes, `${backupPrefix}/database.sql`);
    const backup = Buffer.from(
      await client("GET", "object", undefined, `${backupPrefix}/database.sql`),
    );
    if (digest(backup) !== digest(dumpBytes))
      throw Error("Database backup verification failed");
    progress("copy_archive_backup");
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
    progress("apply_schema_migrations");
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
      progress,
    );
    progress("release_write_fences");
    await client("POST", "unlock", {});
    progress("completion_gate");
    await gate(config);
    // Only the reviewed schema-v2 Worker can resume serving. Never restore the old Worker.
    progress("deploy_current_worker");
    await command(["deploy", "--config", configPath]);
    console.log(
      `Dependency rollout complete; ${changed} run records converted and the schema-v2 Worker deployed. Private backups remain in R2.`,
    );
  } catch (error) {
    console.error(
      `Dependency rollout failure: phase=${phase} code=${safeFailureCode(error)}`,
    );
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
