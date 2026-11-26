# Troubleshooting

If your problem is not listed, ask on [Zulip](https://proofs-rs.zulipchat.com/) or
[report a bug](get-help.md).

## Recording

### `Commit and push source changes before cargo proofs run`

The working tree has uncommitted changes or untracked files. Commit them,
including Cargo.lock, and push; remove or ignore files that are not inputs.

### `Push the source commit before cargo proofs run`

The current commit is not on the source remote. Push it. To use a remote other
than `origin`, set `remote` under `[git]` in `proofs.toml`.

### `Source remote must be a GitHub repository`

Only GitHub remotes are supported, so that readers can follow source links and
reproduce the run.

### `No #[kani::proof_for_contract] harnesses found in the selected library/configuration`

Only contract harnesses are published. If you see
`Note: N ordinary #[kani::proof] harness(es) are not publication targets.`, see
[Record with Kani](kani.md#which-harnesses-become-claims). Also check that the
features and target after `--` enable your harnesses.

### `No regular Kani check results found; quiet/terse output cannot be published`

Run Kani with its regular serial output. Quiet, terse, and parallel output are
rejected.

### `Cannot resolve … in harness …` or `Ambiguous contract target …`

Discovery could not map the harness target to exactly one function. Glob
imports, macro-generated functions, and ambiguous reexports are not resolved.
Name the target by an explicit path.

### `No publishable contracts found`

Discovery found no API to publish for the selected tool configuration. For
Creusot with `target = "annotated"`, check that public functions carry
`requires` or `ensures`; see [Record with Creusot](creusot.md).

## Publishing

### `… version … is not registered/selectable on this server; request it before publishing`

The tool version in `proofs.toml` is not registered.
[Request it](https://proofs-rs.zulipchat.com/),
or use a registered version listed on [Tools](/tools).

### `crate_version_not_found`

proofs.rs could not import the crate version's API catalogue from crates.io
and docs.rs. Check that this exact version is published on crates.io and that
its docs.rs build succeeded. Unreleased versions cannot be published.

### An API is missing or matches several public APIs

The service's public API catalogue is authoritative. Private functions, and
functions without a public path, cannot be Claims.

### `Accept current terms in the browser, then run login again`

The Terms have changed since you last signed in. Accept them in the browser,
then run `cargo proofs login` again.

### `Server report changed since the last CLI publication`

See [Conflicts](update-a-report.md#conflicts).

### `No recorded run`

Record a successful run with `cargo proofs run` first. `preview` and `publish`
do not run verification.

## Preview

### Unknown `preview` command

Your CLI is older than the `preview` feature. Update it with
`cargo install cargo-proofs --locked`.

### Port in use

Stop the earlier preview server, or omit `--port` to pick a free port.

### Changes are missing after updating the CLI

Stop and restart preview. Reloading the browser refreshes report data, not the
UI bundle.

## Frequently asked questions

### I verified a fork or a patched copy. Can I publish it?

Yes, if the crate name and version match a crates.io release. The CLI does not
check that your source matches the release, so explain the differences under
`limitations`. See [Write a useful report](write-a-report.md).

### My crate version is not on crates.io yet.

Publish the release first. A Report targets a crates.io version.

### I only have ordinary `#[kani::proof]` harnesses.

Express the property as a function contract and check it with a
`#[kani::proof_for_contract]` harness. See [Record with Kani](kani.md).

### My crate is in a workspace.

Pass `-p NAME` or `--manifest-path PATH` to `init`, `run`, `preview`, and
`publish`; `login` does not take them. A virtual workspace
with several packages requires `-p`.
