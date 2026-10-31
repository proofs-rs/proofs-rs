# Development

The service runs on Cloudflare Workers with Hono/TypeScript, D1, private R2,
Queues, Cron, Workers Assets, GitHub OAuth and optional Cloudflare Email Service.
See [backend design](backend-design.md) for the data model and
[operations](operations.md) for deployment and configuration.

## Local setup

Requires Node 24 and mdBook 0.4.45 (`cargo install mdbook --version 0.4.45 --locked`). `npm ci`, `npm run build`, `npm run db:local`, then `npm run dev`. Copy `.dev.vars.example` to `.dev.vars` and configure a development GitHub OAuth app to enable sign-in. Callback: `http://localhost:8787/auth/github/callback`. No local auth bypass is exposed by the Worker. `npm test` uses an in-memory SQLite adapter and fixture rustdoc JSON, never a live docs.rs request or email send.

`npm run typecheck`, `npm test`, and `npm run build` are required checks. The first migration creates immutable revisions, transaction guards, comment history, independent report/claim stars, comment votes, outbox events and delivery states. A keyset cursor is used for lists. Migration 0009 registers Aeneas and an initial pinned Lean revision; other catalogue entries remain operator-managed. Tools and versions are stored in D1 and can be added or updated through the audited admin API without a deployment.

## HTML pages

The Worker renders page content on the server (`src/site.ts` and `src/site-views.ts`).
Links and GET searches navigate normally; writes use POST forms backed by the existing
API validation, permissions, CSRF and idempotency checks. App JavaScript handles legacy hash URLs, version-selector submission and the
internal theme override. Use `?theme=base` for the plain view or `?theme=a` for
the document theme; selection persists in the same tab, including the Book. Personalized HTML is
not cached. The JSON API and CLI protocol retain their existing responses.

Crate searches, report lists, API claim lists, activity lists and stargazers use
keyset pagination links. Crate versions and API catalogues, report claims, complete
comment/reply trees and revision history, tool/version catalogues and active tokens
are included in the initial HTML. Home shows the latest 12 entries. Recorded run
summaries and reproduction commands are rendered with the report; complete logs
have a separate HTML page and remain available in the SARIF download.

## Local UI demo

Use the real Worker, D1 and R2 locally with synthetic fixtures:

```sh
npm ci
npm run dev:demo
```

Open <http://127.0.0.1:8787/__demo>. The scenario index links to home, crate,
API, report, claim and finding pages, long reports with revisions and recorded
logs, empty states and paginated lists. Switch between **Author (demo_mira)**,
**Other user (demo_nora)** and **Logged out**. Each page has a link back to the
scenario index; switching from that link returns to the page you were viewing.
The normal sign-in link also opens the local user switcher.

The author can edit Findings, change related APIs and add links through the
usual forms and API. Both users can post comments. Ownership, CSRF and terms
checks use the normal application code and actual session cookies. The Report's
API section shows linked Claims and Findings. The API detail page retains its
current production behavior.

Restarting preserves edits. To restore all demo data, **stop the server**, then:

```sh
npm run demo:reset
npm run dev:demo
```

The runner prevents concurrent startup/reset using a process lock. It recovers
a lock left by a terminated process on the next invocation. All demo D1/R2
state lives in `.wrangler/demo`; it is separate from the default `npm run dev`
state and staging. Only that directory is deleted by reset. The dedicated
`wrangler.local.json` uses loopback, local bindings and a separate Worker
entrypoint. It has no queues, scheduled jobs or remote resource bindings. The
normal staging seed and deployment commands remain separate.

After dependency installation, these scenarios work without external services.
Dependency metadata and synthetic SARIF/logs are preloaded into local R2.
Missing dependency metadata produces the normal unavailable state without
falling back to crates.io. External links require connectivity. GitHub OAuth,
new crate imports, email and proof execution are not part of this demo.
Stars/activity examples are enabled locally, independently of production flags.

Changes to Worker/SSR code trigger Wrangler reloads. Changes under `public/`
are copied to `.wrangler/demo-assets`; refresh the browser to see them. The demo
does not require Rust, Lean or mdBook. When mdBook 0.4.45 is on `PATH`, Docs
links serve the real Book, built with the same CSP post-processing as
`npm run build:book`. Otherwise they open a local layout fixture: existing Book
Markdown and SUMMARY.md are rendered into the mdBook 0.4.45 page structure using
its vendored standard CSS and the real shared header/theme assets. The demo
prints which one it serves at startup. Changes under `book/` and `demo/book/`
are rebuilt in either mode; refresh the browser to see them.

In the fixture, the sidebar starts closed on first visit, toggles with mouse or
keyboard, remembers its state across chapters, and supports part titles, nested
chapters and previous/next navigation. It is for sidebar/header/content layout
checks and omits full-text search, syntax highlighting, the theme picker and
sidebar resizing. Use the real build for final validation.

### Maintaining scenarios

- `demo/scenarios.ts` defines stable user/record IDs and scenario links.
- `demo/seed.ts` loads the existing staging SQL/SARIF fixtures and adds local
  Findings, trait APIs, empty states, comments and dependency references. All
  additional evidence is labelled synthetic; no proof was run. Existing staging
  fixture generation and upload behavior are unchanged.
- Bump `DEMO_SEED_VERSION` when changing seed contents. The runner will request
  `demo:reset` instead of overwriting edits. The current catalog extractor
  version is also part of the seed version. Failed initial seeding can be
  retried; completion is recorded only after D1/R2 loading and foreign-key checks.
- Add new representative URLs to the scenario index. Use fixed IDs, avoid
  external fetches, and seed any required evidence/cache objects into local R2.

```sh
npm run typecheck
npm run test:demo
```

The integration test uses isolated temporary local D1/R2 and a real Worker with
outbound `fetch` disabled. It checks navigation, sessions, HTML and JSON Finding
edits, related APIs, comments, pagination, revision/log access, ownership,
restart persistence and reset. It also checks that the production bundle excludes
demo authentication. Temporary test data is removed when the test finishes.

## Book

The mdBook sources live in `book/src/`, with chapter order in `SUMMARY.md`.
`npm run build` builds the app first, then the book into `dist/book/`; the existing
static asset binding serves it at `/book/` (and redirects `/book` there).
`npm run build:book` rebuilds just the book. Preview through `npm run dev` to use
the same paths and security headers as deployment. The book build externalizes
mdBook’s inline scripts and styles to preserve the site’s Content Security Policy.
CI and deployment workflows install the same pinned mdBook version.

## Data and behavior

- First explicit preparation of a crate/version imports crates.io metadata plus one docs.rs rustdoc JSON; later publications reuse D1. Unsupported rustdoc formats fail closed. Supported formats: 60 and 61. No whole-registry crawl, no re-run of proofs, no HTML scraping fallback.
- Reports publish one crate/version and tool/version with 1–100 claims in one transaction. Claim API and IDs are immutable. Shared and individual fields are additive; empty claim titles are generated. Full-report revisions retain stars and history.
- Independent report/claim stars survive revisions. Only non-self report stars contribute to karma; one replaceable policy in `src/core.ts` supplies profile and list/detail scores.
- Comments belong only to reports. Removed claims keep permanent links to their historical report revision.
- Replies form an unbounded-depth tree; every reply level indents. Deleted comments retain a public tombstone and private history.
- Notifications arise only from new comments, deduplicate recipients and skip the author. Unknown send outcomes are not automatically retried.
- Admin APIs require current `ADMIN_GITHUB_IDS` membership. Existing API tokens are accepted for listed owners; browser writes retain session/CSRF checks, and all writes retain terms checks. Every moderation action and history read is audited. There is no public history endpoint.

## CLI authentication and API documentation

Open `/api/docs` for the API reference and `/openapi.json` for OpenAPI 3.1.
The fixed public client ID is `proofs-cli`. Start at `POST /auth/device/code`,
show the returned user code, open the verification URL, and poll
`POST /auth/device/token`. Tokens have publishing scope (plus admin API access while the owner is listed in `ADMIN_GITHUB_IDS`), expire after 90 days,
and can be revoked in Settings or through `POST /api/v1/tokens/revoke`.
The Rust CLI lives in [`cli/`](../cli/README.md) so API and client changes can be reviewed together.
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

Recorded verification requires CLI 0.3.0: commit and push the source and Cargo.lock, then `cargo proofs run -- cargo kani ...` and `cargo proofs publish`. The service stores only SARIF 2.1.0 with embedded execution logs. Source remains at the recorded GitHub commit. Nothing generated by run needs a Git push. See [recording and reproduction](../cli/README.md#recording-and-reproduction).

## Crate API catalogue

The crate API endpoint now returns the complete catalogue (`next_cursor: null`),
with current claim counts for active public reports. Family rows sum
claim counts across their implementations; zero claims display as an em dash.
The Web UI groups functions, associated functions, inherent methods, and trait
implementations; blanket implementations are a separate subsection. Single
implementations link directly, while multiple implementations start collapsed.

## Reviewed dependencies

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

For existing installations, see [the migration procedure](dependency-migration.md).

## Finding to GitHub Issue

Report authors can choose **Create GitHub issue** on a saved Finding or its Report
when crates.io lists a supported HTTPS GitHub upstream repository. The recorded
verification repository, which may be a fork, is not used. Missing, unsupported,
or unavailable upstream metadata hides the prompts. Findings without an Issue
link also offer **Add issue URL**. Both prompts disappear once an Issue link is
registered; PR links alone do not hide them. Removing the Issue link restores them.
The ordinary **Add issue or PR link** form remains available for other hosts.

**Create GitHub issue** redirects directly to GitHub. When the repository has
Issue templates or an Issue template configuration directory, it opens the
GitHub template chooser with the title and no body. The lookup covers legacy
Markdown templates in the root, `.github`, and `docs` directories, template/form
folders, and defaults inherited from the owner's public `.github` repository.
A failed or incomplete configuration lookup preserves the full draft on a local
fallback page with a retry link and copy controls, rather than silently dropping
the body. Authors can retry or copy the draft before opening GitHub’s chooser.
Successful upstream and template lookups are cached in R2 for five minutes;
GitHub requests have a shared five-second timeout and require no credentials.

When no templates are configured, GitHub's creation page is prefilled with the
Finding title and complete Markdown body, followed by a horizontal rule (`---`)
and one sentence linking to the origin Report revision. If the encoded URL exceeds 8 KiB, a local fallback
page lets authors copy the complete body; unusually long titles also fall back
to copying. Text selection works without JavaScript, and copy buttons use the
Clipboard API when available.

No GitHub write permission is requested and no issue is posted by the service.
After posting on GitHub, return to **Add issue or PR link** to register its URL
and edit the upstream status as appropriate. Opening the action does not change
Finding state. CLI previews do not expose it. The local demo uses synthetic
repository and template fixtures without fetching crates.io or GitHub.

## Local CLI preview development

`preview/server.ts` runs in Node.js 24+ and uses the same page shell, report/claim
views, Markdown sanitizer, and recorded-run renderer as the Worker. Rust owns
local configuration, recorded runs, read-only service requests, and publication
state lookup. Versioned JSON Lines over child stdin/stdout carry snapshots;
credentials never cross this boundary. Node stdout is reserved for this protocol.

After changing shared views, public assets, or preview code, run
`npm run build:preview`. Commit `cli/preview/server.cjs` and
`cli/preview/THIRD_PARTY_NOTICES.txt`; `npm run check:preview` checks deterministic
regeneration in CI and the CLI release workflow. Cargo packages these files and
requires no npm build during installation. From the repository root:

```sh
npm run build:preview
cargo build --manifest-path cli/Cargo.toml --locked
python3 cli/tests/preview.py cli/target/debug/cargo-proofs
npm run check:preview
```

The E2E test uses a local read-only mock service and a temporary project outside
the source checkout. It checks new and revised reports, data reload, missing API
metadata, state preservation, HTTP boundaries, and child-process cleanup.

Use a separate Cargo target directory for builds from the packaged archive (CI
uses `cli/target/package-check`) so they cannot replace the development binary.
After rebuilding the bundle and CLI, stop and restart any running preview to pick
up UI changes. Browser reload alone refreshes configuration and report data.

The preview maps API names in the report to local claim pages, while the ordinary
site keeps its API catalogue links. Metadata links use the configured service
origin. Shared-view changes must preserve both sets of link behavior.

## Crate README badges

Each crate page includes a Shields.io badge and a **Copy Markdown** button under
**README badge**. Badges are pinned to the selected crate version. The public
`GET /api/v1/crates/:name/:version/badge` endpoint returns Shields.io endpoint JSON:

```json
{
  "schemaVersion": 1,
  "label": "proofs.rs",
  "message": "160 claims",
  "color": "blue"
}
```

The count includes claims in the latest revisions of public, non-withdrawn
reports for that release, including zero when no such claims exist. Unknown
crates or releases return 404. Use
`https://img.shields.io/endpoint?url=<URL-encoded endpoint URL>` as the image URL
and link it to the crate page with `?version=...`. Shields.io caches the image,
so changes may take time to appear.

## CLI export and ingestion contract gate

Run `cargo build --manifest-path cli/Cargo.toml --locked` followed by
`npm run test:cli-contract`. This required gate runs the actual CLI's recording
and publisher code with the production Worker preparation/upload handlers as its
peer. Verifier processes are synthetic: this checks protocol compatibility, not
proof validity. Real Lean/Aeneas audit tests remain separate.

The generator copies the exact `run.sarif.json` bytes immediately after successful
recording, or `diagnostic.sarif.json` bytes for candidates expected to fail. It records SHA-256, producer version, binary
hash and checkout revision in a versioned corpus manifest. No source, tool, proof
or time fields are rewritten. `PROOFS_CONTRACT_OUTPUT` selects a fresh empty
output directory; an existing corpus cannot silently be reused.

The server consumer uses the real `src/schemas.ts`, `readRecord`, HTTP handlers
and migration-backed SQLite/R2 fixture. Every accepted record must prepare,
upload, validate and publish locally with the same bytes, exact API bindings and
formal evidence; failed records must be rejected. The returned bindings also go
back through the actual CLI publisher. Missing corpus, stale checkout/binary,
missing mandatory cases, altered bytes and semantic mismatches fail the gate.
A negative self-check proves that missing data and even a rehashed but invalid
formal manifest cannot pass.

Mandatory coverage is registered once in
`cli/tests/fixtures/recording-contract-cases.json`: Kani, Creusot annotated/all,
Aeneas manual/manifest, macro expansion, concrete generic/const instances,
inherited defaults, multiple theorems, structural paths, aliases, dependencies,
toolchain provenance, the maximum claim count and failed recordings. The consumer checks coverage against
the actual exported fields instead of trusting labels. Any new adapter or export
mode must add a producer scenario and semantic coverage assertion there.

`npm run test:recording-contract` consumes an existing fresh manifest named by
`PROOFS_CLI_CONTRACT` and fails if it is absent. Set `PROOFS_TEST_CLI` when testing a
non-default binary. CI runs the complete generation/consumption gate in each
Linux/macOS Rust matrix entry, against the packaged binary, and before CLI release.
Synthetic corpus artifacts are retained on failure for diagnosis. The ordinary
service unit suite does not replace this dedicated required gate.

Current wire compatibility is `proofs.schemaVersion = 2`, with formal evidence
version 1. Keep supported versions additive; an incompatible exporter change
requires a coordinated reader/version change and migration or compatibility
policy, never a weakened consumer test. The corpus manifest's `formatVersion` is
a test-artifact format and does not change the public wire version.


### Validation before CLI storage

`src/schemas.ts`'s `S.sarif` input shape generates the checked-in
`cli/protocol/recording-v2.schema.json`. Run `npm run build:recording-schema` when
changing it. `npm run check:recording-schema` rejects stale generated contracts
in the CLI gate, service CI and release verification. The Cargo package embeds
this self-contained schema in the binary; validation needs neither Node nor a
server connection. JSON Schema network/file resolution features are disabled.

After verification and source-integrity checks succeed, the CLI validates the
8 MiB limit and the bundled schema **before creating a publishable run or updating
latest**. A shape mismatch reports that server-side changes are required to
support the extracted output, with a bounded field/constraint location and no
rejected value dump. Coordinate the producer/server contract change rather than
bypassing the guard. Failed verification, extraction and size limits are separate
errors and do not suggest a server schema change.

Rejected candidates are saved only under `diagnostics/<UUID>/diagnostic.sarif.json`
for inspection and never replace the previous latest run. The contract gate feeds
these exact rejected bytes to the server as negative cases. It also checks a
successful verifier emitting an unsupported formal-evidence version, and proves
that subsequent publication still uses the preceding valid recording.

This offline guard checks input shape. Zod refinements, `readRecord` cross-field
semantics, ownership and registered tool versions remain server checks. The
actual CLI-to-production-handler contract gate remains required for those rules;
passing the offline guard does not guarantee a deployed server accepts a record.
