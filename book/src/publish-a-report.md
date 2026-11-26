# Publish your first report

Publish your verification results with `cargo proofs`. This page lists what you
need before you start and the steps common to every tool. The tool pages cover
how each verifier's results become Claims.

## Before you start

Check these before writing any configuration. Each one can block publication.

- [ ] **A supported tool and a registered version.** Kani, Creusot, and Aeneas
  with Lean are supported. The exact version you used must be listed under
  **Supported versions** on the tool's page, such as [Kani](/tool/kani); if it
  is not,
  [request it](https://proofs-rs.zulipchat.com/).
- [ ] **A crate version released on crates.io.** A Report targets one version of
  one library crate. proofs.rs imports that version's public API catalogue from
  crates.io and docs.rs, so the version must be published and its docs.rs build
  must have succeeded.
- [ ] **Source on GitHub.** The source remote must be a GitHub repository
  (`origin` by default). Commit and push all verification inputs, including
  Cargo.lock, before recording. The working tree must be clean.
- [ ] **Harnesses the tool adapter can discover.** For example, Kani publishes only
  `#[kani::proof_for_contract(...)]` harnesses, not ordinary `#[kani::proof]`
  harnesses. See your tool's page.
- [ ] **A plan for differences from the release.** If you verified a fork or a
  patched copy, the CLI does not prove that it matches the crates.io release with
  the same name and version. Explain the relationship in the Report.
- [ ] **Within limits.** A Report can have up to 200 Claims and 128 KiB of data;
  Kani discovery supports up to 100 APIs.

You need Rust 1.91 or newer to install the CLI, and Node.js 24 or newer only for
`cargo proofs preview`.

## Choose your tool

| Tool | Claims come from | Guide |
| --- | --- | --- |
| Kani | `#[kani::proof_for_contract(...)]` harnesses, one Claim per API | [Record with Kani](kani.md) |
| Creusot | Public functions with `requires`/`ensures`, proved by a fresh prover run | [Record with Creusot](creusot.md) |
| Aeneas with Lean | Lean specification theorems about the Aeneas model | [Record with Aeneas and Lean](aeneas.md) |

## Common steps

### 1. Install

```sh
cargo install cargo-proofs --locked
```

### 2. Create proofs.toml

Run inside the crate you verified. For a workspace, add `-p NAME` or
`--manifest-path PATH` to `init`, `run`, `preview`, and `publish`. `login` does
not take these options.

```sh
cargo proofs init --tool kani
```

Use `--tool creusot` or `--tool aeneas` for the other tools; see the tool page
for the options each needs. `init` creates `proofs.toml` and never overwrites an
existing file. It can detect the installed tool version when you
omit `--tool-version`; check that it is the version you actually used.

Then edit `proofs.toml`. Only the title and tool are required:

```toml
[report]
title = "Contract verification of my crate"
# explanation = "What this report covers"
# trusted_assumptions = "Assumptions used in verification"
# limitations = "Scope restrictions"
# environment = "Verification environment"

[tool]
name = "kani"
version = "0.68.0" # Version used; must be listed on /tool/kani
```

The optional fields are what readers use to judge your result. See
[Write a useful report](write-a-report.md) for what to put in them, and
[Configuration and Markdown](configuration.md) for every field and the supported
Markdown.

Commit `proofs.toml` with the rest of your verification inputs, including
`Cargo.lock`, and push. `cargo proofs run` refuses to start while the working
tree has uncommitted or untracked changes:

```sh
git add proofs.toml Cargo.lock
git commit -m "Add proofs.rs configuration"
git push
```

### 3. Sign in

```sh
cargo proofs login
```

Authorize the CLI in your browser with your GitHub account. On first sign-in, or
after the Terms change, accept the current Terms in the browser and run `login`
again. Use `--no-browser` to print the URL instead of opening a browser.

### 4. Record verification

Commit and push first, then run your verifier through `cargo proofs run`. Pass
the verifier's flags, such as `--features` or `--target`, after `--`; the same
flags drive API discovery.

```sh
cargo proofs run -- cargo kani -Z function-contracts
```

The CLI verifies a detached checkout of the pushed commit and prints
`Recording run <RUN_UUID> at <commit>`, then `Saved run <RUN_UUID>: <directory>`.
Only the resulting SARIF record, with embedded logs, is uploaded later; your
source stays on GitHub. A failed run stays local for inspection and cannot be
published.

### 5. Preview

```sh
cargo proofs preview
```

This opens your Report in the browser exactly as readers will see it, marked
**Local preview — not published**. Edit `proofs.toml` and reload to review
changes; prose edits do not need another run. Stop with Ctrl+C. See
[Preview a report locally](preview-a-report.md).

Before publishing, check in the preview that:

- [ ] the number of Claims and the APIs they name match what you meant to verify;
- [ ] **Overview** says what holds and under which conditions, in words a Rust
  user can follow without reading the proofs;
- [ ] **What is trusted** and **Technical limitations** name what was not
  verified;
- [ ] the recorded logs contain nothing you would not publish (see below).

### 6. Publish

```sh
cargo proofs publish --dry-run
cargo proofs publish
```

`--dry-run` prints the data that would be published and ends with
`Dry run: no report published.` The first publication of a crate version may
wait while the service prepares its API catalogue (`Preparing API catalogue…`),
which can take several minutes. `publish` then prints a link to your Report.

## What gets published

Everything in a Report is public, under the license in the
[Terms](/terms):

- your GitHub username, shown as the author;
- the text from `proofs.toml`;
- the recorded run: the SARIF record with the complete stdout and stderr of the
  verifier, the command line, timing, and the tool version;
- the GitHub repository URL and commit of the recorded source.

Review the logs before publishing; they can contain local paths, environment
details, or anything else your build printed. You can withdraw a Report later,
but its history stays public. See [Update, withdraw, and recover](update-a-report.md).

## After publishing

- **Update the Report:** edit `proofs.toml` or record a new run, then run
  `cargo proofs publish` again. See [Update, withdraw, and recover](update-a-report.md).
- **Record bugs and other observations:** use **Add finding** on the Report. See
  [Add findings](findings.md).
- **Rely on a dependency's Report:** see
  [Declare dependency reviews](review-a-dependency.md).
- **Something failed:** see [Troubleshooting](troubleshooting.md).

For every command and option, see the
[CLI documentation](https://github.com/proofs-rs/cargo-proofs/blob/main/README.md).
