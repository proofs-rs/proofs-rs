import { hash, now, rows, stmt, Fault, type Env } from "./core";
import type { readRecord } from "./runs";
import { apiOrigin } from "./recorded-api-sql";

type Record = ReturnType<typeof readRecord>;
export interface RecordedBinding {
  contract_index: number;
  api_item_id: string;
  display_path: string;
  origin: "recorded" | "rustdoc";
}
// Select one exact recorded spelling per contract. In particular do not erase
// generic arguments, synthesize inherited defaults, or guess a rustdoc alias.
export async function recordBindings(
  db: D1Database,
  record: Record,
): Promise<RecordedBinding[]> {
  const saved = await storedBindings(db, record.id);
  const paths = [...new Set(record.contracts.flatMap((c: any) => c.api_paths))];
  const candidates = await rows(
    db,
    `SELECT a.id,a.canonical_key,${apiOrigin()} origin FROM api_items a JOIN releases r ON r.id=a.release_id JOIN crates cr ON cr.id=r.crate_id WHERE cr.name=? AND r.version=? AND a.canonical_key IN (SELECT value FROM json_each(?))`,
    record.crate,
    record.version,
    JSON.stringify(paths),
  );
  return Promise.all(
    record.contracts.map(async (contract: any, index: number) => {
      const persisted = saved.find((b) => b.contract_index === index);
      if (persisted) {
        if (!contract.api_paths.includes(persisted.display_path))
          throw new Fault(409, "immutable_run");
        return persisted;
      }
      const existing = contract.api_paths
        .map((path: string) => candidates.find((c) => c.canonical_key === path))
        .find(Boolean);
      const path = existing?.canonical_key ?? contract.api_paths[0];
      return {
        contract_index: index,
        display_path: path,
        api_item_id:
          existing?.id ??
          (await hash(
            JSON.stringify([
              "recorded-api-v1",
              record.crate,
              record.version,
              path,
            ]),
          )),
        origin: existing?.origin ?? "recorded",
      };
    }),
  );
}
export function observationStatements(
  env: Env,
  record: Record,
  bindings: RecordedBinding[],
) {
  const release =
    "SELECT r.id FROM releases r JOIN crates cr ON cr.id=r.crate_id WHERE cr.name=? AND r.version=?";
  return [
    stmt(
      env.DB,
      "INSERT INTO crates(name) VALUES(?) ON CONFLICT DO NOTHING",
      record.crate,
    ),
    stmt(
      env.DB,
      "INSERT INTO releases(crate_id,version,created_at) SELECT id,?,? FROM crates WHERE name=? ON CONFLICT DO NOTHING",
      record.version,
      now(),
      record.crate,
    ),
    ...bindings.flatMap((b) => [
      stmt(
        env.DB,
        `INSERT INTO api_items(id,release_id,canonical_key,display_path,kind,is_unsafe,signature,upstream_url) SELECT ?,r.id,?,?,'callable',0,'','' FROM (${release}) r WHERE true ON CONFLICT(release_id,canonical_key) DO NOTHING`,
        b.api_item_id,
        b.display_path,
        b.display_path,
        record.crate,
        record.version,
      ),
      ...(b.origin === "recorded"
        ? [
            stmt(
              env.DB,
              "INSERT INTO api_item_provenance SELECT id,'recorded' FROM api_items WHERE id=? AND kind='callable' AND signature='' AND upstream_url='' ON CONFLICT DO NOTHING",
              b.api_item_id,
            ),
          ]
        : []),
      stmt(
        env.DB,
        `INSERT INTO run_api_observations(run_id,contract_index,api_item_id) SELECT ?,?,a.id FROM api_items a WHERE a.release_id=(${release}) AND a.canonical_key=? ON CONFLICT DO NOTHING`,
        record.id,
        b.contract_index,
        record.crate,
        record.version,
        b.display_path,
      ),
    ]),
  ];
}
export async function storedBindings(
  db: D1Database,
  run: string,
): Promise<RecordedBinding[]> {
  return rows(
    db,
    `SELECT o.contract_index,a.id api_item_id,a.display_path,${apiOrigin()} origin FROM run_api_observations o JOIN api_items a ON a.id=o.api_item_id WHERE o.run_id=? ORDER BY o.contract_index`,
    run,
  );
}
