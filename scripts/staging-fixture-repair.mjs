// One-time repair of two exact synthetic objects committed in 40d3a7f.
// Never repair arbitrary user records or accept changed bytes under old hashes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrateRecord } from "./migrate-run-dependencies.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originalHash =
  "9ffcb3cc0ebaa92bfe4fb9c96e3ca8f68726b44f77e316c68e9e565170e4f11a";
const ids = [
  "c9769922-6967-59a1-93c0-2a1fb7e1e5bf",
  "5f6678ff-ff2e-5d08-80a9-7848968b9a7e",
];
export function repairStagingFixture(bytes, row) {
  const position = ids.indexOf(row.id);
  if (
    position < 0 ||
    row.r2_key !== `staging-layout-v1/${row.id}.sarif.json` ||
    row.sha256 !== originalHash ||
    row.size !== 1827 ||
    bytes.length !== 1827 ||
    hash(bytes) !== originalHash
  )
    return migrateRecord(bytes, row);
  // Replacement metadata was explicitly added for these synthetic fixtures in
  // PR38; preserve their existing synthetic logs/results/provenance/contracts.
  const replacement = readFileSync(
    new URL(`../fixtures/layout-run-${position}.sarif.json`, import.meta.url),
  );
  const sha256 = hash(replacement);
  migrateRecord(replacement, { ...row, sha256, size: replacement.length });
  return {
    bytes: replacement,
    sha256,
    size: replacement.length,
    r2_key: row.r2_key + `.dependencies-v2.${sha256}.sarif.json`,
  };
}
