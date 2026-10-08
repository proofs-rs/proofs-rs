# cargo-proofs

A Rust CLI for publishing verification reports to [proofs.rs](https://proofs.rs). For Kani, it discovers `#[kani::proof_for_contract(...)]` harnesses and publishes two claims per API: `no_ub` and `panic_contract`, both under the target's `requires` conditions.

Creusot publishes only `panic_contract`, not `no_ub` or functional correctness claims.

Commit and push the source and Cargo.lock to GitHub, then run verification through `cargo proofs run` before publishing. The CLI records observed results and embeds stdout/stderr in SARIF 2.1.0. `publish` uploads only that SARIF. Source remains on GitHub; no additional push is needed between run and publish.

Reports remain author-submitted evidence, not independent service certification. A harness may constrain inputs, concrete types, stubs, or execution beyond the extracted `requires`; describe those restrictions in the report's assumptions/limitations.

## Install

Rust 1.91 or newer, Cargo, and the selected verification tool must be installed:

```sh
cargo install cargo-proofs --locked
cargo proofs --help
```

The CLI is developed in `cli/` alongside the service. To install a checkout, run `cargo install --path cli --locked` from the repository root. Only the CLI package is distributed on crates.io; access to the service repository is not required to install a published version.

## Quick start

Run inside the crate to verify:

```sh
cargo proofs init --tool-version 0.66.0 --title 'Contract verification of my crate'
cargo proofs login
# Commit and push all verification inputs, including Cargo.lock, before run.
cargo proofs run -- cargo kani
cargo proofs publish --dry-run
cargo proofs publish
```

`init` can detect the installed Kani version if `--tool-version` is omitted. Check that this is the version actually used for verification. It never overwrites an existing `proofs.toml`.

```toml
[report]
title = "Contract verification of my crate" # required
# explanation = "Optional report explanation"
# trusted_assumptions = "Optional shared assumptions"
# limitations = "Optional scope restrictions"
# environment = "Optional verification environment"

[tool]
name = "kani"
version = "0.66.0" # must be registered/selectable on the selected service

```

Crate name/version come from Cargo metadata, including workspace inheritance. There is no `[crate]` section. One selected library crate and one tool/version are supported per publication. Use `-p NAME` or `--manifest-path PATH` to select a workspace package. A virtual workspace with multiple packages requires `-p`.

Staging has separate login credentials and publication state:

```sh
cargo proofs login --server https://proofs-rs-staging.proofs-rs.workers.dev
cargo proofs publish --server https://proofs-rs-staging.proofs-rs.workers.dev --dry-run
```

You may set `PROOFS_SERVER` instead. The default is `https://proofs.rs`. Tokens are stored in a per-server file in the OS user config directory (`cargo-proofs`), with mode 0600 on Unix. Set `PROOFS_CONFIG_DIR` to override that credentials directory. Tokens are never saved in the repository. `logout` revokes the token before removing it. HTTP is allowed only for loopback development servers; redirects are not followed.

## Dependency reviews

Attach a specific report revision for a dependency in `proofs.toml`:

```toml
[dependencies]
serde = { report = 123, revision = 2 }
```

Report and revision IDs must be positive integers. Entries accept only `report` and `revision`; crate versions come from the recorded run. Names use the actual package name even when Cargo renames the dependency. Each selected report must target a crate/version present in the recorded crates.io dependency snapshot and remain active. Multiple resolved versions of a crate are supported.

New runs record `properties.proofs.schemaVersion = 2` and a required dependency snapshot containing each reachable resolved package's crate, version, and Cargo source. The snapshot retains identities from `cargo metadata --locked` in the detached verification worktree. `cargo tree --locked` scopes the graph to the selected package with the verifier's features and compilation target, so sibling workspace features cannot add dependencies to the snapshot. Workspace dependencies, transitive dependencies and distinct versions retain their resolved identities. Publishing uses this snapshot rather than the current checkout's lockfile.

Omitting `[dependencies]` preserves the existing report's reviews when revising. An explicit empty `[dependencies]` clears them. Editing reviews reuses the selected recorded run; selecting another run revalidates reviews against that run. Publishing requires a version 2 recording; record verification again to migrate older runs. `publish --dry-run` displays review additions and removals and checks referenced report revisions; the service performs final authoritative validation. Interrupted publication resumes the exact saved review references.

## Discovery

- Supports library free functions and concrete methods, including trait implementation methods identified as `<Type as Trait>::method`, nested/ordinary external modules, explicit `use` aliases and public reexports, `#[kani::...]` and `#[cfg_attr(kani, kani::...)]`.
- `requires` predicates are conjoined. No `requires` means `true`, for both claims, including safe APIs.
- Ordinary `#[kani::proof]` harnesses are ignored with a notice. Their target/scope cannot be safely inferred from arbitrary code.
- Multiple contract harnesses for one API, ambiguous targets/reexports, and `include!` source trees stop publication. Glob imports are not used to guess targets. Macro-generated functions/harnesses are not expanded or discovered; this is a source parser, not a Rust compiler frontend.
- Conditional compilation is evaluated with `kani`, the selected Cargo features, and `rustc --print cfg` for the host or `--target`. Pass `--features foo,bar`, `--all-features`, `--no-default-features`, and `--target` to match verification. Build-script/custom cfgs are not inferred; encountered unsupported cfgs stop discovery. Integration-test targets are not scanned. Target-dependent dependency feature unification and RUSTFLAGS are not used to infer library features.
- For standard `Default`, `Clone`, and `Hasher` implementations, discovery also records the short trait spelling used by rustdoc catalogues. Arbitrary external trait basenames are not guessed.
- The service's imported public API catalogue is authoritative. Missing APIs or multiple public API matches stop publication; no silent skipping.
- The local fork's implementation may differ from the published crate with the same name/version. The CLI does not prove equivalence; evidence identifies the exact source commit.

## Creusot

```sh
cargo proofs init --tool creusot --tool-target annotated --tool-version VERSION --title 'My verification report'
cargo proofs login
cargo proofs run -- cargo creusot
cargo proofs publish --dry-run
cargo proofs publish
```

Use the version actually used for verification; it must be registered on the service. `init` tries `cargo creusot version` when `--tool-version` is omitted. Review tool-version limitations on proofs.rs, including any panics outside the verifier's coverage.

```toml
[report]
title = "My verification report"

[tool]
name = "creusot"
version = "VERSION"
target = "annotated" # required: "annotated" or "all"
```

- `annotated`: public free functions and concrete methods with `requires` or `ensures`.
- `all`: public free functions and concrete methods even without these annotations. This selects source APIs; it does not attest that every function was verified.
- Both exclude `trusted`, `logic`, `predicate`, `law`, and `check(ghost)` functions, including explicitly imported aliases. Private functions/types and APIs without a public path are excluded. Trait declarations, macro-generated APIs and glob reexports are not discovered. Explicit function/type/module reexports are supported; complex reexport chains may require future compiler-backed discovery.
- Recognizes bare attributes, `creusot_std::...` / legacy `creusot_contracts::...`, and `cfg_attr`. Explicit macro imports/aliases are resolved; arbitrary user-defined wrapper macros and renamed dependency crates are unsupported. Bare attribute names are interpreted as Creusot attributes under this tool selection.
- `requires` retains its original Pearlite source text, including `@`, `^`, quantifiers and implication. Multiple predicates are parenthesized and joined with `&&`; absence means `true`. `ensures` only selects an API, never becomes a precondition or functional correctness claim.
- Evidence points to the API declaration and body, including its attributes. Logic bodies are not parsed as Rust expressions.
- Conditional compilation uses `creusot` instead of `kani`, together with selected Cargo features and platform cfgs. The existing source-discovery limitations still apply.

`[tool].target` selects APIs; CLI `--target` selects the Rust compilation target. They are separate settings. Kani does not accept `[tool].target`: its targets remain explicit `proof_for_contract` harnesses.

## Recording and reproduction

`run` checks the installed tool version against `proofs.toml`. Commit and push the verification inputs, including Cargo.lock, before recording. `[git].remote` selects the remote (default `origin`). A clean working tree and a commit reachable on that remote are required. Source URLs use GitHub and the full commit SHA.

Verification runs in a detached temporary Git worktree at that commit, with a separate build directory and locked dependency resolution. Git determines the checkout contents; there is no custom source collector, archive, file-count limit, or source upload size limit. The worktree registration and files are removed on success and errors. Tracked input changes during verification prevent publication.

Each run directory contains only `run.sarif.json`. SARIF is the canonical record for source provenance, command, timing, contracts, results and embedded stdout/stderr. The latest-run pointer and report publication state are local navigation/retry state, not duplicate execution records. Review the logs before publishing. The complete SARIF has an 8 MiB limit. `publish` sends it in one request; there is no separate metadata registration.

- Kani: regular serial check output is supported. Checks are associated with the exact observed contract harness. Quiet/terse output, parallel jobs, options disabling safety checks, and unknown result formats are rejected. Unexecuted harnesses do not generate claims; unreachable checks remain labeled unreachable.
- Creusot: a prover run must create fresh `proof.json` sessions that map unambiguously to selected APIs. Compilation alone, unchanged stale sessions, unresolved proof goals, and unsupported proof layouts do not certify an API. Free-function sessions and Creusot 0.13 method sessions are supported. Method sessions are matched by the generated Coma declaration source span and method name; ambiguous matches are rejected.
- A failed process, changed worktree, or run without verified contracts cannot be published. Failed recordings remain local for inspection.
- Pass compilation flags **after** `--`, as part of the actual verifier command, for example `cargo proofs run -- cargo kani --features foo`. The same flags drive contract discovery. Select the workspace package with `-p NAME` as appropriate.
- One run per CLI publication is supported. `publish` selects the latest recording, or use `publish --run UUID` for an explicit recording. Changes to tool configuration or crate/version require a new run.

The report's collapsed **Reproduce** section contains Git clone/checkout commands for the external commit, the exact recorded command, check-to-claim links, execution metadata, the SARIF download, and embedded logs. Install the report's tool version and recorded Rust toolchain first. System dependencies are not bundled. Only `RUSTFLAGS`, `CARGO_ENCODED_RUSTFLAGS`, and `RUSTDOCFLAGS` environment overrides are recorded.

## Revisions, conflicts, and recovery

Publication state is stored in the OS local data directory under `cargo-proofs/`, isolated by server, author, package manifest, crate and version. It is not committed. One process may publish a given package/state at a time.

- Repeat `publish` revises the same report and preserves existing claim IDs. An unchanged report produces no revision.
- A changed crate version starts a new report (the service makes report crate/version immutable).
- On another machine, or after losing local state, use `publish --report ID` to attach explicitly. The CLI matches claims by API/property and refuses duplicate matches.
- Titles/explanations and other individual editorial fields from the server are preserved. The report title is controlled by TOML; shared optional fields are preserved when absent, or cleared when explicitly `""`. Contracts and evidence are controlled by the selected SARIF record.
- If the server revision changed since the last publication, show the differences and stop. `publish --dry-run` previews the prospective update. `publish --force` applies the local/config-owned fields over the latest server state, preserving unspecified editorial fields. It still sends `expected_revision` so a concurrent edit after fetching is rejected.
- Missing contracts remove claims only after a yes/no prompt. Noninteractive approval requires `--yes`. `--force` does not approve deletions or bypass recorded-run checks. Removed claims retain their history/permanent links on the service. Locally known removed claim IDs are reused if their contracts are later restored; recovering removed IDs on a different machine is not automatic.
- Before a write, the CLI saves the exact request and idempotency key atomically. If publication is interrupted, `publish --resume` retries that saved request rather than generating another report. It prints the saved payload and uses its original recorded evidence. Definite rejected requests are cleared so they can be corrected; ambiguous/network failures retain the journal.

`--dry-run` never publishes a report or updates its local baseline, but authenticates, reads the selected SARIF, and may ask the service to import the API catalogue. It does not upload artifacts or perform the final server-side run validation. Imports can take several minutes. The report limit is 100 claims (50 Kani APIs or 100 Creusot APIs) and 128 KiB; automatic splitting is deliberately unsupported.

## Development

```sh
cd cli
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
cargo build --locked
python3 tests/e2e.py target/debug/cargo-proofs
```

CI runs tests on Linux and macOS. Tests use temporary Git repositories and local HTTP servers; they never publish to proofs.rs, run Kani/Creusot, or push user source repositories.
