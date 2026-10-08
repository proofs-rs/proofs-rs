import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { readRecord } from "../src/runs";
import {
  migrateRecord,
  planMigration,
} from "../scripts/migrate-run-dependencies.mjs";
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const record = () =>
  Buffer.from(
    JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          automationDetails: { guid: "10000000-0000-4000-8000-000000000001" },
          tool: { driver: { name: "Kani", version: "0.68.0" } },
          invocations: [
            {
              executableLocation: { uri: "cargo" },
              arguments: ["kani"],
              workingDirectory: { uri: "./" },
              startTimeUtc: "2026-10-01T00:00:00Z",
              endTimeUtc: "2026-10-01T00:00:01Z",
              executionSuccessful: true,
              exitCode: 0,
              stdout: { index: 0 },
            },
          ],
          versionControlProvenance: [
            {
              repositoryUri: "https://github.com/test/source",
              revisionId: "a".repeat(40),
            },
          ],
          results: [
            {
              kind: "pass",
              message: { text: "passed" },
              properties: { harness: "check" },
            },
          ],
          properties: {
            proofs: {
              schemaVersion: 1,
              crate: "example",
              version: "1.0.0",
              contracts: [
                {
                  harness: "check",
                  api_paths: ["example::f"],
                  properties: ["no_ub"],
                  precondition: "true",
                  file: "src/lib.rs",
                  first_line: 1,
                  last_line: 3,
                },
              ],
            },
          },
          artifacts: [{ contents: { text: "original proof log" } }],
        },
      ],
    }),
  );
const index = (bytes: Buffer) => ({
  id: "10000000-0000-4000-8000-000000000001",
  sha256: digest(bytes),
  size: bytes.length,
  r2_key: "runs/author/old.sarif.json",
});

test("historical SARIF becomes current empty snapshot without reconstructing dependencies", () => {
  const bytes = record(),
    result = migrateRecord(bytes, index(bytes))!;
  const migrated = JSON.parse(result.bytes.toString());
  assert.deepEqual(migrated.runs[0].properties.proofs.dependencies, []);
  assert.equal(migrated.runs[0].properties.proofs.schemaVersion, 2);
  assert.deepEqual(readRecord(migrated).dependencies, []);
  assert.equal(
    migrated.runs[0].artifacts[0].contents.text,
    "original proof log",
  );
  assert.equal(result.sha256, digest(result.bytes));
  assert.equal(result.size, result.bytes.length);
  assert.equal(
    migrateRecord(result.bytes, { ...index(bytes), ...result }),
    null,
  );
  assert.throws(
    () => migrateRecord(Buffer.from("tampered"), index(bytes)),
    /hash\/size/,
  );
  assert.throws(
    () => migrateRecord(bytes, { ...index(bytes), id: "wrong" }),
    /run ID/,
  );
});

test("offline migration writes new R2 objects and guards all D1 updates atomically", async () => {
  const temp = await mkdtemp(join(tmpdir(), "proofs-dependencies-"));
  const db = new DatabaseSync(":memory:");
  try {
    const archive = join(temp, "archive"),
      output = join(temp, "output"),
      bytes = record(),
      row = index(bytes);
    await mkdir(join(archive, "runs/author"), { recursive: true });
    await writeFile(join(archive, row.r2_key), bytes);
    const manifest = await planMigration([row], archive, output);
    assert.equal(manifest.length, 1);
    assert.deepEqual(await readFile(join(archive, row.r2_key)), bytes);
    const newBytes = await readFile(join(output, manifest[0].key));
    assert.equal(digest(newBytes), manifest[0].sha256);
    db.exec(
      "CREATE TABLE verification_runs(id TEXT PRIMARY KEY,r2_key TEXT,sha256 TEXT,size INTEGER); CREATE TABLE run_dependencies(run_id TEXT);",
    );
    db.prepare("INSERT INTO verification_runs VALUES(?,?,?,?)").run(
      row.id,
      row.r2_key,
      row.sha256,
      row.size,
    );
    const sql = await readFile(join(output, "apply.sql"), "utf8");
    // A changed index must prevent the whole migration, including earlier records.
    db.exec("UPDATE verification_runs SET sha256='changed'; BEGIN");
    assert.throws(() => db.exec(sql), /CHECK/);
    db.exec("ROLLBACK");
    assert.equal(
      db.prepare("SELECT r2_key FROM verification_runs").get()!.r2_key,
      row.r2_key,
    );
    db.prepare("UPDATE verification_runs SET sha256=?").run(row.sha256);
    db.prepare("INSERT INTO run_dependencies VALUES(?)").run(row.id);
    db.exec("BEGIN");
    assert.throws(() => db.exec(sql), /CHECK/);
    db.exec("ROLLBACK");
    db.exec("DELETE FROM run_dependencies");
    db.exec("BEGIN");
    db.exec(sql);
    db.exec("COMMIT");
    assert.deepEqual(
      {
        ...db.prepare("SELECT r2_key,sha256,size FROM verification_runs").get(),
      },
      {
        r2_key: manifest[0].key,
        sha256: manifest[0].sha256,
        size: manifest[0].size,
      },
    );
    const migratedIndex = {
      ...row,
      r2_key: manifest[0].key,
      sha256: manifest[0].sha256,
      size: manifest[0].size,
    };
    assert.deepEqual(
      await planMigration([migratedIndex], output, join(temp, "again")),
      [],
    );
  } finally {
    db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("schema migration initializes empty declarations and permanently blocks old positional uploads", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE verification_runs(id TEXT PRIMARY KEY,author_id TEXT,crate TEXT,version TEXT,tool_version_id TEXT,sha256 TEXT,size INTEGER,r2_key TEXT,created_at TEXT); CREATE TABLE maintenance(id INTEGER PRIMARY KEY); CREATE TABLE report_revisions(report_id INTEGER,revision_no INTEGER,PRIMARY KEY(report_id,revision_no));",
    );
    db.exec(
      "INSERT INTO verification_runs VALUES('old','author','crate','1','tool','hash',1,'old-key','time');",
    );
    db.exec(
      readFileSync(
        new URL("../migrations/0007_dependency_reviews.sql", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM run_dependencies").get()!.n,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM report_dependencies").get()!.n,
      0,
    );
    assert.throws(
      () =>
        db.prepare("INSERT INTO verification_runs VALUES(?,?,?,?,?,?,?,?,?)"),
      /10 columns/,
    );
    db.prepare(
      "INSERT INTO verification_runs(id,author_id,crate,version,tool_version_id,sha256,size,r2_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run("new", "author", "crate", "1", "tool", "hash", 1, "new-key", "time");
    assert.equal(
      db
        .prepare(
          "SELECT snapshot_schema_version FROM verification_runs WHERE id='new'",
        )
        .get()!.snapshot_schema_version,
      2,
    );
    assert.throws(
      () =>
        db.exec(
          "UPDATE verification_runs SET snapshot_schema_version=1 WHERE id='new'",
        ),
      /CHECK/,
    );
  } finally {
    db.close();
  }
});
