// Offline, one-time migration planner. Never contacts D1 or R2.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const safePath = (root, key) => {
  const base = resolve(root),
    file = resolve(base, key);
  if (
    !key ||
    key.startsWith("/") ||
    key.includes("\\") ||
    !file.startsWith(base + sep)
  )
    throw Error("Invalid archive key");
  return file;
};

export function migrateRecord(bytes, row) {
  if (sha256(bytes) !== row.sha256 || bytes.length !== row.size)
    throw Error(`Archive hash/size mismatch for ${row.id}`);
  const document = JSON.parse(bytes.toString("utf8"));
  const run = document.runs?.[0],
    proofs = run?.properties?.proofs;
  if (document.runs?.length !== 1 || run?.automationDetails?.guid !== row.id)
    throw Error(`Archive run ID mismatch for ${row.id}`);
  if (proofs?.schemaVersion === 2) {
    if (!Array.isArray(proofs.dependencies))
      throw Error("Missing v2 dependency snapshot");
    return null;
  }
  if (proofs?.schemaVersion !== 1)
    throw Error(`Unsupported record schema for ${row.id}`);
  // Historical records have no dependency evidence. Never reconstruct it from a current lockfile.
  proofs.schemaVersion = 2;
  proofs.dependencies = [];
  const migrated = Buffer.from(JSON.stringify(document, null, 2) + "\n");
  if (migrated.length > 8 * 1024 * 1024)
    throw Error("Migrated record exceeds 8 MiB");
  const sha = sha256(migrated);
  return {
    bytes: migrated,
    sha256: sha,
    size: migrated.length,
    r2_key: row.r2_key + `.dependencies-v2.${sha}.sarif.json`,
  };
}

export async function planMigration(
  rows,
  inputDirectory,
  outputDirectory,
  transform = migrateRecord,
) {
  if (resolve(inputDirectory) === resolve(outputDirectory))
    throw Error("Output must differ from the archive backup");
  const manifest = [],
    guards = [],
    updates = [];
  const seen = new Set();
  // Validate all inputs before writing deliverables.
  for (const row of rows) {
    if (seen.has(row.id)) throw Error("Duplicate run ID");
    seen.add(row.id);
    const result = transform(
      await readFile(safePath(inputDirectory, row.r2_key)),
      row,
    );
    if (!result) continue;
    manifest.push({
      id: row.id,
      old_key: row.r2_key,
      old_sha256: row.sha256,
      old_size: row.size,
      key: result.r2_key,
      sha256: result.sha256,
      size: result.size,
      bytes: result.bytes,
    });
    guards.push(
      `INSERT INTO dependency_migration_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM verification_runs WHERE id=${quote(row.id)} AND r2_key=${quote(row.r2_key)} AND sha256=${quote(row.sha256)} AND size=${Number(row.size)}) AND NOT EXISTS(SELECT 1 FROM run_dependencies WHERE run_id=${quote(row.id)}) THEN 1 ELSE 0 END;`,
    );
    updates.push(
      `UPDATE verification_runs SET r2_key=${quote(result.r2_key)},sha256=${quote(result.sha256)},size=${result.size} WHERE id=${quote(row.id)};`,
    );
  }
  await mkdir(outputDirectory, { recursive: true });
  for (const entry of manifest) {
    const file = safePath(outputDirectory, entry.key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, entry.bytes, { flag: "wx" });
  }
  // Apply as one atomic D1 batch. The CHECK then aborts all updates if any index changed.
  const sql = [
    "-- Apply only after uploading every manifest object, with writes and cleanup paused.",
    "CREATE TABLE dependency_migration_guard(ok INTEGER NOT NULL CHECK(ok=1));",
    ...guards,
    ...updates,
    "DROP TABLE dependency_migration_guard;",
    "",
  ].join("\n");
  await writeFile(resolve(outputDirectory, "apply.sql"), sql, { flag: "wx" });
  const publicManifest = manifest.map(({ bytes, ...entry }) => entry);
  await writeFile(
    resolve(outputDirectory, "manifest.json"),
    JSON.stringify(publicManifest, null, 2) + "\n",
    { flag: "wx" },
  );
  return publicManifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [index, archive, output] = process.argv.slice(2);
  if (!index || !archive || !output)
    throw Error(
      "Usage: node scripts/migrate-run-dependencies.mjs runs.json archive-backup/ output/",
    );
  const exported = JSON.parse(await readFile(index, "utf8"));
  const rows =
    Array.isArray(exported) && exported[0]?.results
      ? exported.flatMap((x) => x.results)
      : exported;
  if (!Array.isArray(rows))
    throw Error("Expected verification_runs rows or Wrangler JSON results");
  const manifest = await planMigration(rows, archive, output);
  console.log(`Prepared ${manifest.length} records. No remote data changed.`);
}
