# One-time dependency snapshot migration

The current service accepts only SARIF `proofs.schemaVersion=2`, with a required
`dependencies` array. Migration `0007_dependency_reviews.sql` adds separate tables
for run resolution snapshots and report revision reviews. Old runs and revisions
start with zero rows. Never infer historical dependencies from a current
Cargo.lock. Old runs cannot support a new dependency review; record a new run.

`scripts/migrate-run-dependencies.mjs` is an offline migration planner. It validates
original bytes against D1 SHA-256 and size, verifies the embedded run ID, then
converts schema-v1 objects to schema v2 with `dependencies: []`. It keeps contracts,
results, logs and provenance unchanged, writes new R2 object keys, and produces
updated hash/size SQL. Already-current objects are left unchanged. This script
never contacts the network or modifies its archive input.

Before deploying the new Worker:

1. Pause publication/upload writes and scheduled run-object cleanup for the whole
   migration. Stop old Worker traffic or use an operator maintenance window; a new
   object must not be collected before its index is switched. Back up D1 and R2.
2. Apply migration `0007_dependency_reviews.sql` while traffic remains stopped.
3. Export `SELECT id,r2_key,sha256,size FROM verification_runs ORDER BY id` as JSON.
   Either a plain row array or Wrangler `--json` result array is accepted. Download
   every referenced R2 object into a private directory preserving its key as the
   relative path. Keep backups private: unpublished runs and logs are private.
4. Run locally (Node 24):

   ```sh
   node scripts/migrate-run-dependencies.mjs runs.json archive-backup/ migration-output/
   ```

   Choose a fresh output directory. Inspect `manifest.json`, converted objects,
   and `apply.sql`. Hash mismatch, missing objects, unsupported schemas or a
   changed embedded run ID abort preparation. The script changes no remote data.
5. Upload every object listed in `manifest.json` to the same archive bucket at its
   exact `key`, using content type `application/sarif+json`. Verify every uploaded
   object's hash and size against the manifest before switching any D1 indexes.
   The originals stay intact for recovery.
6. Execute `apply.sql` as **one atomic D1 transaction/batch**, never as independent
   statements. Its CHECK guards require every old key/hash/size still to match and
   every migrated run to have no dependency rows. A stale index aborts the whole
   switch. Test the deployment tool's transaction behavior on a copy first.
7. Check all referenced objects exist, their indexed hash/size match, every run is
   schema v2 with an array snapshot, and `PRAGMA foreign_key_check` returns no
   violations. Deploy the new Worker, then resume traffic and scheduled cleanup.

If uploading is interrupted, re-upload the already-planned immutable bytes; do
not regenerate a different plan while traffic is running. If SQL fails, keep the
maintenance window and investigate the changed index. Original objects remain
available. Once the SQL commits, rerunning against a fresh export is a no-op.
The normal orphan sweep can reclaim superseded original objects after the
maintenance window; retain the private backup per your retention procedure.

Local CLI schema-v1 runs should be discarded/re-recorded before publication. A
new schema-v2 run is necessary to add reviews because the historical empty
snapshot cannot establish their presence. The service has no continuing legacy
exception. Existing report histories and empty declarations both return the same
`dependencies: []` representation.
