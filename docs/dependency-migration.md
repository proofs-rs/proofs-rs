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

## Automated production rollout

The dedicated `.github/workflows/dependency-rollout.yml` runs only on the exact
same-repository `ops/dependency-review-migration` branch, or a manual dispatch on
main. Ordinary feature branch pushes cannot trigger production migration. Create
that ops branch at the reviewed PR commit, after its CI passes. It uses the existing
production environment and Cloudflare secrets; it does not rotate or replace them.
The shared production concurrency group prevents overlapping deployments.

The workflow builds the reviewed version, provisions the existing bindings, then
runs `node --import tsx scripts/dependency-rollout.mjs migrate wrangler.production.json <production-origin>`:

1. Deploy a temporary Worker with the exact production name, routes, bindings and
   queue consumers. It returns HTTP 503, performs no scheduled work, and retries
   queue messages with a one-hour delay and increased retry allowance. A random
   operator token exists only in process memory; only its hash enters temporary
   Worker variables. Existing Worker secrets are preserved.
2. Install temporary D1 write-fence triggers, including protection from old
   in-flight Worker invocations. Allow 16 minutes for previous queue/scheduled
   invocations to drain. Operator writes are allowed only inside atomic batches
   which remove their bypass row before commit.
3. Export D1 privately and upload/verify the SQL backup in the private archive.
   Copy/verify every current non-backup R2 object into a private backup namespace.
   Existing backups remain intact. No SQL dump, SARIF contents or operator token
   enters Actions logs or uploaded Actions artifacts. Local temporary files are
   removed when the process finishes.
4. Apply schema migrations. The new constant-v2 schema column also makes the
   old uploader's positional nine-column INSERT fail, protecting against late
   schema-v1 uploads after maintenance ends; the current uploader names columns
   explicitly. Validate every registered SARIF hash/size and current
   record shape, use the offline planner for v1-to-v2 empty snapshots, then upload
   and verify the new objects. Automated migrated keys use
   `dependency-snapshots-v2/` so an old in-flight `runs/` cleanup cannot collect
   them before the index switch.
5. Apply all guarded index updates and the completion marker in one D1 batch.
   Recheck every registered record and its normalized dependency rows, plus foreign
   keys. Remove temporary fences only after those checks pass.
6. Deploy only the reviewed schema-v2 Worker and run read-only smoke checks. The
   workflow never rolls back to the schema-v1 Worker. After success, merge the PR;
   normal Production deployment will validate the completion gate again.

Normal `.github/workflows/production.yml` uses the separate read-only
`scripts/dependency-rollout-gate.mjs` before any migration or deployment. It checks
both the completion marker and absence of temporary write fences. It performs no
historical data conversion. A failed/interrupted rollout leaves maintenance in
place; rerun the dedicated workflow at the reviewed commit after investigation.
Already-converted records are verified and preserved on retry. If the final
schema-v2 deployment succeeded but its response was lost, the running Worker may
already be the reviewed version; it is never automatically replaced by the old
version. Do not manually deploy old code against migrated storage.

D1 export uses the existing `CLOUDFLARE_D1_BACKUP_TOKEN` when configured, otherwise
the existing deploy token. Missing export permission or unavailable bindings stops
the rollout in maintenance; the workflow does not request additional permissions.
Backups contain private records and temporary write fences. Keep them in private
R2 and follow the restore/erasure procedures before any restore. Retain the backup
prefix per the existing operational policy; it is not an Actions artifact.

## Offline/operator alternative

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


## Staging rollout

Trusted `staging/*` pull requests use the existing Staging workflow. Before normal
migration/deployment, it runs the same one-time conversion against strictly guarded
staging Worker, D1, R2, queue names and origin. Production routes/resources are
rejected before maintenance. It retains all existing runs, backs up D1 and private
R2, fences writes and drains old invocations for 16 minutes, verifies converted
objects and snapshots, then deploys the v2 Worker. No fixture reset is required.

After the completion marker is present and maintenance fences are absent, later
staging deployments skip conversion and require the read-only completion gate.
A failed initial rollout leaves staging in maintenance: investigate and rerun the
same trusted staging PR workflow; do not restore the old Worker. Private backup
contents stay in R2, never Actions logs or artifacts. The existing backup-token
secret is reused when available. Staging fixture seeding skips objects for existing
run IDs, preserving migrated keys and hashes. The public smoke check also checks
`/book/review-a-dependency.html` and its publishing tutorial link.


Rollout logs include fixed phase names and allowlisted failure codes, never raw
Cloudflare errors, private run IDs, archive keys, SQL, or record contents. Registered
archive integrity is checked before the drain and again during conversion. For
`archive_hash_size_mismatch`, keep maintenance in place and compare the indexed
hash/size with private archive backups and the original record; never update a
hash just to accept the current object. A permission failure during
`export_database_backup` requires correcting the existing token's access or using
the existing D1 backup-token secret before retrying. No backup check is bypassed.
Retries conservatively repeat the 16-minute drain; a historical failure without a
persisted fence timestamp cannot prove that old invocations have finished.
