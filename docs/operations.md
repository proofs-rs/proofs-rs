# Operations

## Deployment and recovery

The Staging workflow provisions a separate D1 database, R2 bucket and job and dead-letter Queues. A failure at provisioning generally means missing API-token scopes or a service not enabled; fix configuration and rerun the workflow. Do not substitute the legacy database ID. A successful deploy is followed by public, read-only checks of HTML and the API. GitHub/Email integration configuration is reported separately.

Back up D1 daily at 02:17 UTC through its export API; poll pending exports on the five-minute Cron. Store SQL dumps privately in R2 `backups/`, retaining the newest 30. Requires `CLOUDFLARE_D1_BACKUP_TOKEN`. RPO target: 24 hours. RTO target: one business day. Check Worker Cron errors and R2 backup timestamps. D1 Time Travel is an additional platform recovery mechanism, not the only backup.

Restore into a new private database, never directly into a serving database. Download the selected SQL backup and **all latest** `erasures/` objects from the current R2 bucket with operator access. Import SQL into a local SQLite file, then run `node scripts/sanitize-restore.mjs private.sqlite latest-erasure-markers/`. This reapplies user erasures and exceptional body redactions, invalidates sessions, cancels pending mail and pauses imports/mail. Export the sanitized database and import it into a new D1 instance. Check integrity and bindings, then change the Worker DB binding. Restore service only after confirming erasures and moderation records. Keep downloaded backups in private temporary storage and remove them after use. The erasure ledger must not be restored from an older snapshot. If ledger access fails, stop the restore.

## Administrative API

Admin access is determined on every request by the owner's numeric GitHub ID in the current `ADMIN_GITHUB_IDS` configuration, for both browser sessions and API tokens. The stored role from the last login is not authoritative. Removing an ID takes effect for existing credentials once the configuration is deployed.

Existing API tokens issued through `cargo proofs login` (device flow, `publish` scope) can access the admin API when their owner is currently listed. No CLI changes, special token, or new scope are required. This also grants administrative access to previously issued tokens belonging to listed users; other users' tokens remain unable to access admin routes. Token expiry, revocation, account suspension, terms acceptance for writes, and audit logging still apply.

For curl, send `Authorization: Bearer <token>`. Cookies, Origin, and CSRF are not required with Bearer authentication. For example, with the token available privately in `PROOFS_API_TOKEN`:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $PROOFS_API_TOKEN" \
  https://proofs.rs/api/v1/admin/audit
```

Browser sessions still require same-origin requests and the `/api/v1/me` CSRF value for writes. Never copy a session or token into an issue. `POST /api/v1/admin/action` takes `{action,target,reason,...}`. Reason is mandatory.

| Action                                | Additional fields                                      | Result                                                                  |
| ------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| report_visibility / comment_visibility | value: public or hidden                                | Hide/restore content                                                    |
| suspend / restore_user                | none                                                   | Account status; suspension revokes sessions                             |
| redact_comment                        | none                                                   | Erase current and retained text, remove votes, preserve thread          |
| redact_revision                       | revision_no                                            | Exceptional redaction with audit and restore marker                     |
| delete_user                           | none                                                   | Ghost attribution, remove private profile/contact/session/votes/stars |
| pause                                 | target: imports_paused or email_paused; value: boolean | Background work stop                                                    |
| retry_email                           | none                                                   | Explicit operator-approved retry, including unknown outcomes            |
| tool                                  | name, description, url, active                         | Curated tool catalogue                                                  |
| tool_version                          | tool_id, version, selectable                           | Curated version catalogue                                               |

`GET /api/v1/admin/comments/:id/history` audits the read. `GET /api/v1/admin/audit` lists recent audit records. `GET /api/v1/admin/deliveries` lists unresolved delivery failures. Keep unknown delivery outcomes under review; retry only after evaluating possible duplicate mail. Inspect the dead-letter Queue in Cloudflare. Replaying an outbox event is safe; creating a new delivery for an uncertain send is not automatically safe.

## Email and authentication

Use separate OAuth registrations for local/staging/production. GitHub username and confirmed primary email synchronize on sign-in. A failure to fetch email preserves a previously confirmed address and the callback shows an email-retry hint. An unverified/no-primary-email response disables the address. Never store GitHub OAuth access tokens.

Cloudflare Email Service requires an onboarded DNS domain. The custom domain is a later setup step; deploy the application independently. Set the sending binding, allowlist and event subscription metadata together. Unknown event sources are refused and go to the dead-letter queue. The service does not parse or link @mentions. Notification content is plain text and contains a permalink, not the comment body.

## Terms updates and contact

Update the Terms and summary, increment `TERMS_VERSION`, then deploy. Existing accounts must explicitly agree before publishing, starring or voting. Reading, notification preferences, logout and requesting account deletion remain available. Signup consent is a notice beside the GitHub button. Retain the last accepted version/time on the account, not a per-post consent log. Keep `contact@proofs.rs` reachable before production and document a temporary direct operator channel during staging while the domain is not configured.

## Billing and service controls

The approved planning estimate is approximately USD 5/month at small scale with Workers Paid, plus usage beyond included quotas. The design contains the detailed assumptions and source links; this is not a spending cap. Set Cloudflare billing/usage notifications around the agreed USD 10/month review threshold in the account dashboard. Notifications do not automatically stop charges. Investigate spikes in Worker requests/CPU, D1 rows read/written, R2 operations/storage, Queues and email. Pause imports/email with the admin API when necessary. Cloudflare account-level budgets and email notifications are operator configuration, not activated by this repository.

## Known integration limits

The parser allowlists rustdoc formats 60 and 61 and rejects unsupported syntax or unresolved external reexports instead of fabricating API data. crates.io/docs.rs calls happen only on explicit user preparation. This implementation deliberately has no live import/email test in CI. Staging includes explicitly synthetic examples without shared demo logins.

## Report schema reset (2026-09-21)

The report model initializes a new D1 database and R2 bucket named
`proofs-rs-staging-reports-v1` / `proofs-rs-production-reports-v1`, plus separate
`*-reports-jobs` / `*-reports-dead` queues. No old claims, users, tokens, sessions,
imports, mail deliveries or audit records are copied. Old resources are retained
unbound for now; this deployment does not delete their contents. Remove obsolete
resources separately once the new deployment is accepted. Never bind the rewritten
migration set to a pre-report database or restore an old claim-schema backup into it.

The account has been upgraded to Workers Paid. Email remains explicitly disabled
in both committed configurations (`EMAIL_DISABLED=true`), with no sending binding
or event consumer. Existing OAuth secrets are reused. A new database requires
users to sign in again and reauthorize CLIs. Production gets an empty tool catalogue;
staging alone gets fixture tools. Live import/email tests remain excluded.

## Production deployment and proofs.rs

The Production workflow uses `wrangler.production.base.json`, generates an ignored
`wrangler.production.json`, and creates `proofs-rs-production-reports-v1` D1/R2 plus
`proofs-rs-production-reports-jobs`/`proofs-rs-production-reports-dead` Queues. Staging data is not
copied. Email is controlled by `PRODUCTION_EMAIL_ENABLED`.

Daily flow: PR → CLI and service CI → merge to main → the same CI → automatic
production deployment. `.github/workflows/cli.yml` runs on pull requests and is
reused by Production through `workflow_call`, without passing deployment secrets.
All CLI matrix jobs and the service job must succeed before deployment. The deploy
job rebuilds the same SHA with the committed lockfile, then applies migrations,
deploys the Worker, refreshes catalogues, configures secrets and runs smoke checks.
Staging success and manual owner approval are not required.

For optional PR verification, run Actions → Staging → Run workflow and select the
PR branch in this repository. Staging is shared and each run replaces it. Deploy
only trusted branches: staging workflows use credentials. Fork PRs need a reviewed
branch in this repository before staging deployment.

Production also supports Run workflow on main for operational configuration changes.
Non-main runs cannot deploy. Production runs share a concurrency group and running
deployments are not cancelled. Before any provisioning or migration, a run checks
that its SHA is still the current main tip; outdated runs fail rather than redeploy
an older commit. A newer push during deployment is handled by the subsequent run.

Protect main with required PRs and successful service and CLI checks, including for
administrators. The production environment must not require reviewer approval for
automatic deployment. Repository administrators can still change workflows and
protection settings; grant repository write access only to trusted contributors.

For an incident, merge a fix or revert PR and let Production redeploy. There is no
rollback workflow. Reverting code does not undo D1 migrations, R2 changes or sent
email. Keep migrations backward-compatible with the previous application version;
perform destructive schema changes separately after old code no longer needs them.
A failed post-deployment smoke check does not automatically restore the prior version.

Before custom-domain activation:

1. Add `proofs.rs` to the same Cloudflare account, Free website plan. Preserve and
   verify the existing DNS records, especially MX/TXT and `mail.proofs.rs`; public
   DNS checks do not enumerate all existing subdomains. Export the Istanco DNS
   zone or review its full record list before switching nameservers. Check DNSSEC
   and remove an old DS record if required by Cloudflare's onboarding instructions.
2. At Istanco, set the two nameservers assigned by Cloudflare; wait for Active.
   Do not invent a CNAME at the domain apex or overwrite existing email records.
3. Create a separate GitHub OAuth App: homepage `https://proofs.rs`, callback
   `https://proofs.rs/auth/github/callback`. Save client ID as repository variable
   `PRODUCTION_GITHUB_CLIENT_ID` and client secret as repository secret
   `PRODUCTION_GITHUB_CLIENT_SECRET`. Keep the staging registration unchanged.
4. Set repository variable `PRODUCTION_CUSTOM_DOMAIN=true`, then run Production.
   Wrangler attaches `proofs.rs` as a Worker Custom Domain and provisions HTTPS.
   The deployment token needs zone access for custom domain creation in addition
   to its existing Workers/D1/R2/Queues permissions. Do not broaden to all zones.
5. Verify HTTPS, GitHub login, Tokens, the API docs link, and `contact@proofs.rs`
   delivery before announcing launch. Tool catalogue starts empty.

Until activation, the production Worker is accessible via its workers.dev URL;
OAuth can remain unconfigured during this preparation phase. All callbacks and
CSRF checks use the configured APP_ORIGIN. Production tokens/users are separate
from staging. `scripts/domain-status.mjs` only reads onboarding status and cannot
change nameservers. The Cloudflare account credentials remain in GitHub Secrets.

## Staging demo fixtures

`Seed staging demo` adds the original Sites-style examples to the existing staging
D1 database only. It runs at the end of a staging deploy, or manually on main.
It is separate from migrations and the Production workflow. The runner verifies
both the staging health response and the exact database name before writing.
All statements are INSERT OR IGNORE: repeats do not duplicate fixtures or overwrite
existing rows. Current fixture set: 6 crates, 8 reports, 13 claims, 10 report revisions, 16 comments,
4 synthetic users, nested/deleted/edited comments, independent report/claim stars and comment votes.

Demo usernames use `demo_` and impossible negative GitHub IDs, no login sessions,
email contacts or notification events. Version suffix `-demo.1` isolates these
releases from real imports. Evidence URLs use example.com and text marks the data
as synthetic. Demo API signatures are illustrative and have no doc_snapshots;
they are for browsing, comments and voting, not publishing new reports or testing
docs.rs import. Use a real release for publication tests. No proof was run.
The generator and original sample data are retained in scripts/fixtures.

## Recorded verification evidence (CLI 0.3.0)

The schema and application support SARIF-only verification runs. New databases use the current migration baseline.

SARIF is the canonical verification record. One upload request validates and registers the complete document. D1 `verification_runs` contains ownership/search indexes and the SARIF hash, size and R2 location; execution metadata and contracts are not duplicated in D1. `run_dependencies` separately indexes saved Cargo dependency resolution for publication validation; `report_dependencies` retains author review declarations by report revision. R2 stores each attempt under `runs/<author>/<run>/<attempt>.sarif.json`. Limits: 8 MiB including logs, 90 registered runs per author per UTC day. See [the SARIF profile](sarif.md).

Failed registrations remove their attempt object after checking for a committed DB row. The daily scheduled sweep also removes unregistered objects older than 24 hours. Valid registered runs remain readable to their owner before publication; public access follows report visibility.

### Deployment prerequisite

For the dependency-review release, apply `0007_dependency_reviews.sql` and follow
[the one-time SARIF v2 migration](dependency-migration.md) while writes and object
cleanup are stopped. Its offline planner produces converted archive objects and
guarded hash/size/index updates; it does not modify production data itself.
Historical dependency snapshots and review lists become empty.

Existing installations must be converted in a separate, one-time operator operation before deploying this version. Data-specific transformations and object deletion are not part of the application, schema baseline, or normal deployment workflows. Preserve report/claim identities and verify the converted SARIF and external source reference before deleting obsolete storage. Do not deploy against an unconverted database. Restored databases must also satisfy the current schema before serving traffic.

Published evidence is retained with report history. Completed runs awaiting report publication remain private; include their R2 objects in backup/restore procedures. Do not expire it with a blanket lifecycle rule. Embedded logs may contain author-supplied data; removing an account anonymizes ownership but does not remove published evidence, consistent with retained reports. When responding to an erasure request for evidence contents, hide every referencing report, remove the affected R2 objects, and retain the existing audited restore marker process so backups cannot republish removed content.

### Verification run commands

A run may use any nonempty executable name and zero or more arguments, including
`python3 verify-core.py` or `./verify-core`. The server stores this command; it
does not execute it. The registered verifier name/version must match the SARIF
tool, and exit status and per-contract results are validated from that same document. The command executable is not required to match the verifier name.

After deploying rustdoc format 60 support, retry a failed import by calling
`POST /api/v1/publish/prepare` for the same crate/version. Failed jobs do not block
a new preparation job; no database migration or manual job edit is required.


### Dependency-review rollout automation

Normal Production deployment requires the completed SARIF v2 rollout marker and
no active migration write fences. Execute the dedicated **One-time dependency
snapshot rollout** workflow first, by creating the same-repository
`ops/dependency-review-migration` branch at the reviewed PR commit (or dispatching
on main). This is an explicit operational branch; feature branch pushes do not
run it. The migration deploys maintenance, drains old invocations, writes private
D1/R2 backups, atomically migrates/validates evidence, and deploys the reviewed new
Worker. Failure leaves maintenance rather than reverting to schema-v1 code.
See [the full workflow and recovery procedure](dependency-migration.md).
