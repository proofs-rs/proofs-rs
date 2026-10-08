# proofs.rs

A registry of verification reports and per-API claims for Rust APIs. The service records evidence URLs; it does not run proofs or certify correctness.

Cloudflare Workers (Hono/TypeScript), D1, private R2, Queues, Cron, Workers Assets, GitHub OAuth and optional Cloudflare Email Service. The frontend retains the approved plain-document design. See [backend design](docs/backend-design.md) and [operations](docs/operations.md).

## Development

Requires Node 24 and mdBook 0.4.45 (`cargo install mdbook --version 0.4.45 --locked`). `npm ci`, `npm run build`, `npm run db:local`, then `npm run dev`. Copy `.dev.vars.example` to `.dev.vars` and configure a development GitHub OAuth app to enable sign-in. Callback: `http://localhost:8787/auth/github/callback`. No local auth bypass is exposed by the Worker. `npm test` uses an in-memory SQLite adapter and fixture rustdoc JSON, never a live docs.rs request or email send.

`npm run typecheck`, `npm test`, `npm run build` are the deployment gates. The first migration creates immutable revisions, transaction guards, comment history, independent report/claim stars, comment votes, outbox events and delivery states. A keyset cursor is used for lists. The tool catalogue starts empty. Tools and versions are stored in D1 and can be added or updated through the audited admin API without a deployment.

## Book

The mdBook sources live in `book/src/`, with chapter order in `SUMMARY.md`.
`npm run build` builds the app first, then the book into `dist/book/`; the existing
static asset binding serves it at `/book/` (and redirects `/book` there).
`npm run build:book` rebuilds just the book. Preview through `npm run dev` to use
the same paths and security headers as deployment. The book build externalizes
mdBook’s inline scripts and styles to preserve the site’s Content Security Policy.
CI and deployment workflows install the same pinned mdBook version.

## CI and production

Pull requests run CLI and service checks. Updates to `main` run the same checks,
then automatically deploy production if every check succeeds. Protect `main` with
required pull requests and CI checks. Production can also be rerun manually on
`main`, including after changing deployment variables. See [operations](docs/operations.md#production-deployment-and-proofsrs).

## Staging

Run Actions → Staging → Run workflow and select the PR branch when staging verification is needed. This shared environment is overwritten by each run; only deploy trusted branches from this repository because the workflow uses staging credentials. Staging is not a production gate. `scripts/provision.mjs` creates/reuses only resources named `proofs-rs-staging-*` and writes the ignored `wrangler.staging.json`. Staging is public on workers.dev, with no Cloudflare Access gate and `noindex` headers. Old Worker and database resources are not modified. The custom domain is intentionally left unconfigured.

Required GitHub Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`: scoped to the account, Workers Scripts edit, D1 edit, R2 edit, Queues edit, and account/subdomain read as required by Cloudflare. R2 and Queues must be enabled. The account uses Workers Paid. Email sending is explicitly disabled.

Optional integration settings (missing integrations are visibly marked, not silently simulated):

- Repository variable `STAGING_GITHUB_CLIENT_ID`, secret `STAGING_GITHUB_CLIENT_SECRET`. OAuth callback: the deployed origin plus `/auth/github/callback`. Use a separate staging OAuth app.
- Variable `ADMIN_GITHUB_IDS`, comma-separated GitHub numeric IDs. Defaults to nyuichi (`540144`).
- `STAGING_EMAIL_FROM`, `STAGING_EMAIL_ALLOWLIST`, `STAGING_EMAIL_DOMAIN`, `STAGING_EMAIL_EVENT_SUBSCRIPTION`: variables after Email Service onboarding and event subscription to `proofs-rs-staging-email-events`. Staging delivers only to the explicit allowlist.
- Secret `CLOUDFLARE_D1_BACKUP_TOKEN`, with D1 export permission. This is separate from the deploy token.
- Optional secret `STAGING_TOKEN_SECRET`. A random Worker-only secret is generated on first deployment and preserved on subsequent deployments. It signs unsubscribe URLs.

No GitHub tokens or client secrets are committed or included in the browser build. Workflow logs contain secret names, not values.

## Data and behavior

- First explicit preparation of a crate/version imports crates.io metadata plus one docs.rs rustdoc JSON; later publications reuse D1. Unsupported rustdoc formats fail closed. Supported formats: 60 and 61. No whole-registry crawl, no re-run of proofs, no HTML scraping fallback.
- Reports publish one crate/version and tool/version with 1–100 claims in one transaction. Claim API/property and IDs are immutable. Shared and individual fields are additive; empty claim titles are generated. Full-report revisions retain stars and history.
- Independent report/claim stars survive revisions. Only non-self report stars contribute to karma; one replaceable policy in `src/core.ts` supplies profile and list/detail scores.
- Comments belong only to reports. Removed claims keep permanent links to their historical report revision.
- Replies form an unbounded-depth tree; every reply level indents. Deleted comments retain a public tombstone and private history.
- Notifications arise only from new comments, deduplicate recipients and skip the author. Unknown send outcomes are not automatically retried.
- Admin APIs require current `ADMIN_GITHUB_IDS` membership. Existing API tokens are accepted for listed owners; browser writes retain session/CSRF checks, and all writes retain terms checks. Every moderation action and history read is audited. There is no public history endpoint.

## Email disabled

`EMAIL_DISABLED=true` skips new email notifications and cancels pending/retry deliveries; it never accumulates a backlog for later sending. The email binding and email-event consumer are omitted. Existing user preferences are retained. docs.rs imports are implemented. No live import or email tests are run. Enabling arbitrary-recipient email later requires Workers Paid and deliberate configuration changes.

## Release boundary

Before production: configure OAuth, domain/DNS and contact mailbox, Email Service if desired, backup credentials, billing notifications, restore access and operator procedures. Publishing the GitHub repository and attaching proofs.rs are separate later actions. No external docs.rs import or email delivery verification is performed by CI.


## CLI authentication and API documentation

Open `/api/docs` for the API reference and `/openapi.json` for OpenAPI 3.1.
The fixed public client ID is `proofs-cli`. Start at `POST /auth/device/code`,
show the returned user code, open the verification URL, and poll
`POST /auth/device/token`. Tokens have publishing scope (plus admin API access while the owner is listed in `ADMIN_GITHUB_IDS`), expire after 90 days,
and can be revoked in Settings or through `POST /api/v1/tokens/revoke`.
The Rust CLI lives in [`cli/`](cli/README.md) so API and client changes can be reviewed together.
Install it from this repository with `cargo install --path cli --locked` (Rust 1.91+).
CLI versions and future releases remain independent of service deployments.

The `CLI and service checks` workflow runs Rust formatting, tests, Clippy and a local
HTTP/Git end-to-end test on Linux/macOS, alongside service type checks, tests and build.
It does not deploy, publish a crate, or send reports to a running proofs.rs instance.

The Worker generates `/openapi.json` at request time from public Hono routes and their shared schemas (`src/openapi.ts`, `src/schemas.ts`). `/api/docs` uses Scalar. Add route-local `operation(...)` metadata when adding a public endpoint; admin routes remain ordinary Hono routes without metadata. No generated specification is checked in.
`hono-openapi` keeps the existing Hono handlers and JSON/form/raw-SARIF handling;
Zod schemas validate JSON/form inputs while handlers retain database-dependent rules.
The generator receives only the public router, so admin routes cannot enter the definition.
The test suite checks coverage against every non-administrative API/auth route,
validates OpenAPI structure, and checks fixture responses against generated schemas.
Scalar loads a pinned browser bundle from jsDelivr; its CSP allowance is limited to
`/api/docs`. The old `/docs/api` URL redirects there.

Recorded verification requires CLI 0.3.0: commit and push the source and Cargo.lock, then `cargo proofs run -- cargo kani ...` and `cargo proofs publish`. The service stores only SARIF 2.1.0 with embedded execution logs. Source remains at the recorded GitHub commit. Nothing generated by run needs a Git push. See [recording and reproduction](cli/README.md#recording-and-reproduction).

### Crate API catalogue display metadata

The crate API endpoint now returns the complete catalogue (`next_cursor: null`),
with current claim counts by property for active public reports. Family rows sum
claim counts across their implementations; zero claims display as an em dash.
The Web UI groups functions, associated functions, inherent methods, and trait
implementations; blanket implementations are a separate subsection. Single
implementations link directly, while multiple implementations start collapsed.

Apply migration `0006_api_item_metadata.sql` before deploying this version.
New imports populate metadata from rustdoc. For existing catalogues, run
`node --import tsx scripts/refresh-catalogs.mjs <wrangler-config>` or refresh each
catalogue through `POST /api/v1/admin/catalogs/:id/refresh`. Refresh fills display
metadata without changing existing API IDs or report references. Before refresh,
the UI retains legacy paths and basic grouping; full external paths and blanket
classification require the archived rustdoc metadata.

### UI visibility flags

`SHOW_STAR_KARMA` and `SHOW_HOME_DISCUSSION` are independent Worker variables,
exposed by `/api/v1/config` as `show_star_karma` and `show_home_discussion`. Only
the string `"true"` enables a flag; missing values default off. Both deployment
configs currently set them to `"false"`. Redeploy with the relevant variable set
to `"true"` to restore its UI.

The first flag controls report/claim stars, stargazer pages, karma, personal
starred lists, account menus and the Book's Star / Karma guidance. Old stargazer
URLs return to their report/claim while hidden. The second controls Latest
discussion and the desktop two-column homepage; mobile remains stacked. Comment
counts, posting, replies and votes remain visible. Storage, API endpoints and
privacy disclosures about retained/API-accessible reaction data are unchanged.

Staging can also be deployed from a same-repository PR whose head branch starts
with `staging/`. The existing staging workflow checks out its exact head commit
and uses the staging environment; other PRs and fork PRs do not deploy. Manual
workflow dispatch remains available.

### Reviewed dependencies

An optional `proofs.toml` section pins the report revision you reviewed for each
named dependency:

```toml
[dependencies]
serde = { report = 123, revision = 2 }
```

The evidence report supplies the crate version. Publication checks its crate and
version against the selected recorded run's Cargo dependency snapshot; only
crates.io sources are supported for this declaration. A Git or path fork with the
same name/version does not count as the crates.io package. Other dependencies may
remain undeclared, and multiple versions may be present: only the evidence
report's exact version is reviewed.

Reviews belong to the consuming report revision and are the report author's
judgment, not independent certification by proofs.rs. Evidence revisions stay
pinned when their report changes; current withdrawal is displayed on old reviews.
A hidden evidence report exposes no content. Changing reviews alone requires no
new run; changing dependencies requires a new recorded run. An omitted section
preserves reviews on update; an explicitly empty `[dependencies]` removes them.
Zero reviews does not mean the crate has zero dependencies.

Apply `0007_dependency_reviews.sql` and migrate historical stored SARIF before
deploying. See [the migration procedure](docs/dependency-migration.md). No
production data is changed by checking out this implementation.
