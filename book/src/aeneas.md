# Record with Aeneas and Lean

Aeneas translates Rust, through Charon, into a functional model that can be
verified in Lean. `cargo proofs` records **committed Lean proofs of that model**,
automatically resolving Rust APIs and specification theorems from Aeneas metadata, or using explicit mappings.

This page covers what is specific to Aeneas. The
[common steps](publish-a-report.md#common-steps) for signing in, previewing, and
publishing apply as well. Requires Rust 1.91 or later and cargo-proofs 0.4.0 or
later:

```sh
cargo install cargo-proofs --locked
```

## 1. Pin the registered Aeneas revision

The [Aeneas tool page](/tool/aeneas) lists registered revisions. The initial
registered revision is
[`be86ab0f1989d04944292b345b24c435be3ad10a`](https://github.com/AeneasVerif/aeneas/tree/be86ab0f1989d04944292b345b24c435be3ad10a),
which uses Lean 4.35.0. Use the same Aeneas revision to generate the model and
for the Lean library dependency. Use its compatible Charon pin as described in
the [upstream installation and extraction instructions](https://github.com/AeneasVerif/aeneas/tree/be86ab0f1989d04944292b345b24c435be3ad10a#usage).

For a Lean project in `proofs/` next to the Rust package's `Cargo.toml`, put
`leanprover/lean4:v4.35.0` in `proofs/lean-toolchain`. A minimal
`proofs/lakefile.toml` has:

```toml
name = "demo-proofs"

[[lean_lib]]
name = "Proofs"

[[require]]
name = "aeneas"
git = { url = "https://github.com/AeneasVerif/aeneas", subDir = "backends/lean" }
rev = "be86ab0f1989d04944292b345b24c435be3ad10a"
```

Run `lake update` in `proofs/` to resolve and write `lake-manifest.json`.
Generate the model and write proofs using Aeneas's instructions. The example
on this page uses this layout; replace the names with your actual proof:

```text
my-crate/
├── Cargo.toml
├── Cargo.lock
├── proofs.toml
├── src/lib.rs
└── proofs/
    ├── lean-toolchain
    ├── lakefile.toml
    ├── lake-manifest.json
    ├── Generated/            # Aeneas model and translation.json
    ├── Proofs.lean           # root module: import Proofs.Increment
    └── Proofs/
        └── Increment.lean    # theorem demo.increment_spec
```

Module names follow file paths: `Proofs/Increment.lean` is module
`Proofs.Increment`. With automatic selection from the `Proofs` entry module, the
root module `Proofs.lean` must import each proof module to be searched, for
example `import Proofs.Increment`. Custom Lake source directories are not
supported.

## 2. Create proofs.toml

From the Rust package directory (the one containing `Cargo.toml`):

```sh
cargo proofs init --tool aeneas --tool-version be86ab0f1989d04944292b345b24c435be3ad10a
```

The revision must be the full 40-character Aeneas commit in your Lake manifest.
Review the generated report fields, then choose how specifications are selected:
automatically from Aeneas metadata (next section), or with
[explicit mappings](#explicit-selection-and-existing-projects).

## 3. Select specifications automatically

Generate the committed model and mapping together, using the pinned translator:

```sh
charon cargo --preset=aeneas --dest-file model.llbc -- --lib --locked
aeneas -backend lean -emit-json -dest proofs/Generated model.llbc
```

Then edit the `[tool]` section of `proofs.toml` to name the proof entry modules:

```toml
[tool]
name = "aeneas"
version = "be86ab0f1989d04944292b345b24c435be3ad10a"
lean_dir = "proofs"
proof_modules = ["Proofs"]
translation_manifest = "Generated/translation.json"
```

The manifest path is relative to `lean_dir` and defaults to `translation.json`.
Commit it with the generated Lean, Rust and proofs. Entry modules and their
transitive imports are searched only where their sources belong to this Lake
package. Dependency packages such as Aeneas and Mathlib are excluded. Ordinary
helper theorems are ignored; recognized specifications with unresolved public
APIs produce diagnostics. Loop helpers are never treated as independent APIs.

If an API has several specification theorems, each becomes a separate claim with
its own assumptions, conclusion and recorded evidence. A theorem that applies
only to a specific argument remains separate from a universally quantified theorem.
Zero selected specifications is an error. There is no `discover` subcommand.
Because `proof_modules = ["Proofs"]` names the root module, every module that
`Proofs.lean` imports, directly or transitively, is searched.

### Explicit selection and existing projects

Instead of, or in addition to, automatic resolution, edit the `[tool]` section
of the `proofs.toml` created in step 2 to map theorems to APIs explicitly:

```toml
[tool]
name = "aeneas"
version = "be86ab0f1989d04944292b345b24c435be3ad10a"
lean_dir = "proofs"

[[tool.proofs]]
api = "increment"
module = "Proofs.Increment"
theorem = "demo.increment_spec"
precondition = "x < u32::MAX"
```

`api` is a public Rust callable path relative to the library. `precondition` is
optional author prose; existing text is retained. Empty prose means readers must
consult the proposition, including input types and type class instances. It does
not mean “no conditions.” Explicit mappings take precedence over automatic
resolution, and may select a theorem outside Aeneas's standard specification
shape. A manually selected theorem is never automatically assigned another API.
Projects without a translation manifest can continue to use only these mappings.
Each selected theorem maps to one public Rust callable. Multiple `[[tool.proofs]]`
entries may name the same API with different theorems. A manual mapping overrides
that theorem's automatic mapping; other specifications for the API are still included.
`lean_dir` is relative to `Cargo.toml` and defaults to `"."`. For how Claim IDs
are kept when theorems are added, removed, or renamed, see
[Aeneas evidence details](aeneas-reference.md#claim-identity-across-revisions).

## 4. Commit, record, preview, and publish

Commit and push Rust source, `Cargo.lock`, `proofs.toml`, the generated Lean
model and proof sources, `lakefile.toml` (or `lakefile.lean`),
`lake-manifest.json`, and `lean-toolchain` together. Ignore `.lake/` and Lean
compiled artifacts such as `.olean` and `.ilean`; the recorder builds the
mapped modules from source in a detached checkout.

From the Lean project directory:

```sh
cd proofs
cargo proofs run --manifest-path ../Cargo.toml -- lake build
cargo proofs preview --manifest-path ../Cargo.toml
cargo proofs publish --manifest-path ../Cargo.toml --dry-run
cargo proofs publish --manifest-path ../Cargo.toml
```

The preview command requires Node.js 24 or newer. Review the report and each local
claim page, then stop the server with Ctrl+C before continuing. It reads the
recorded run without running Lean again. See [Preview a report locally](preview-a-report.md)
for editing prose, selecting another run, and interpreting warnings.

Sign in with `cargo proofs login` before publishing if needed. The tool revision
must be registered and selectable on the service. Changes to mappings or
preconditions require another recording.

## What a recorded result establishes

The recorder builds every mapped module explicitly, then checks that each
mapped name is a Lean theorem. The transitive axiom audit allows only `propext`,
`Classical.choice`, and `Quot.sound`. It rejects `sorryAx`, custom axioms
(including axiomatized external models), missing theorems, and failed builds.
The recorded SARIF stores each theorem's full proposition, which Claim pages show
as a Readable Lean view; see [Aeneas evidence details](aeneas-reference.md) for
the recorded evidence format.

The checked result is the named Lean theorem under the allowed axioms.
Charon/Aeneas extraction is **not rerun** by the recorder. In the report,
explain why the model matches the Rust commit and any additional trusted boundaries.
The manifest is translation provenance, not evidence that translation was rerun or
that the committed Rust, manifest and Lean are synchronized. Review the specification's strength as well as the proof.

The current adapter supports the default Cargo configuration, ordinary module
paths (`Proofs/Increment.lean` for `Proofs.Increment`), and the official pinned
Aeneas Git dependency. It does not support custom Lake source directories,
local-path Aeneas dependencies, feature/target-specific extraction, or the Coq,
F*, and HOL4 backends. See the [version's limitations](/tool-version/aeneas-be86ab0f1989d04944292b345b24c435be3ad10a)
and [CLI documentation](https://github.com/proofs-rs/cargo-proofs/blob/main/README.md#aeneas-lean).

## Use a cumulative Aeneas patch

A registered **official base commit + one committed cumulative patch** can replace
an official Git dependency. No public fork or experimental branch is required.
This supports the OCaml translator and `backends/lean` models, lemmas and tactics.
The Charon pin, Lean release, `aeneas` package name and Lake dependency configuration
of the base must remain unchanged. Other tools do not yet support patches.

First commit your changes in a separate local Aeneas checkout. Save its complete
committed difference into the proof repository (new files must first be committed):

```sh
# In the modified Aeneas checkout; BASE_COMMIT is the registered full 40-character SHA.
git diff --binary --full-index --no-ext-diff --no-textconv BASE_COMMIT HEAD -- > /path/to/proof-repo/proofs/toolchain/aeneas.patch
```

Add this to the existing `[tool]` section of `proofs.toml`:

```toml
patch = "proofs/toolchain/aeneas.patch"
```

The patch path is relative to the selected Cargo package, where `proofs.toml`
lives. Add `.proofs-toolchain/` to `proofs/.gitignore`, then run:

```sh
cargo proofs prepare --manifest-path Cargo.toml
```

Prepare works before the first Lake update and before committing or pushing. It
restores `.proofs-toolchain/aeneas/` inside `lean_dir`. It does not edit tracked
Lake configuration, execute proofs, translate Rust, create a Run, or publish.
It refuses unmanaged destinations and edited managed sources; move those aside
before preparing again if you want to preserve local edits.

Replace the Aeneas require entry in `proofs/lakefile.toml`:

```toml
[[require]]
name = "aeneas"
path = ".proofs-toolchain/aeneas/backends/lean"
```

Then complete the first record:

```sh
cd proofs
lake update
lake build
# Commit and push proofs.toml, the patch, sources, lean-toolchain,
# lakefile and lake-manifest.json, plus Cargo.lock. Exclude .lake/ and .proofs-toolchain/.
cargo proofs run --manifest-path ../Cargo.toml -- lake build
cargo proofs preview --manifest-path ../Cargo.toml
cargo proofs publish --manifest-path ../Cargo.toml
```

For a patch update, regenerate the single cumulative diff against the same
registered base, run prepare and Lake update/build again, commit/push the inputs,
and record a new Run. Changed bytes at the same patch path require a new Run;
`--force` cannot override this. Description-only edits can reuse the previous Run.
Prepare and run both support the normal `--manifest-path` and `-p` selectors;
run must execute from the configured Lean directory.

Record always restores from the published proof commit into a new isolated
checkout. It builds the patched Lean library from source with Lake cache downloads
disabled, confirms Lake's effective dependency and selected Lean version, extracts
theorems, and audits transitive axioms (only `propext`, `Classical.choice` and
`Quot.sound`). It checks source content, file modes and source additions/deletions
afterward. It does not build the OCaml translator or run Charon/Rust → Lean.
`translation_rerun` remains false. Restoring a translator source does not establish
which translator generated the committed model.

Run metadata records provenance once in `properties.proofs.toolchain`:
`schema_version = 1`, a `components` map and role-specific `uses`. Aeneas's
`lean_library` and `translator` roles share the same source component; Charon is
an official pinned Git source and Lean an official release. Only Aeneas is
materialized. Uses record dependency resolution, proof-checker execution, and
unexecuted translator/frontend stages. These observations are facts about this
Run, not proof grades or binary authentication.

Three comparisons are separate: the **input fingerprint** includes paths,
configuration and source bytes for local Run reuse; **source identity** includes
tool/repository/base/patch digest (not patch path or component ID); **observations**
include the restored tree and actual version output. Report revisions containing
patched Runs require the same toolchain source identities, and equal identities
must have equal restored trees. Patched/legacy mixtures are rejected. The original
Run remains immutable. Its stored patch link is fixed to the recorded proof commit.

Preview/publish compare current inputs without fetching or rebuilding; deleting
the managed directory does not invalidate matching evidence. Reproduce prepares
the recorded package before building and auditing Lean. Existing Runs without
metadata remain usable and show provenance as **not recorded**. Base tool
limitations describe the official base. The service validates submitted records;
it does not independently reproduce the author's execution or review the patch.

### Independently patched Charon

Use `tool.charon_patch` alongside or instead of `tool.patch`; see the
[configuration guide](configuration.md#charon-patches). The Charon base comes from
the official Aeneas `charon-pin`. Prepare restores patched sources but does not
run Rust-to-Lean extraction. Commit Rust sources, generated models and proofs so
an isolated checkout can build them without repository-specific setup hooks.

When `tool.expand_api` is enabled, API enumeration also includes inherited default
methods from active traits defined in the selected crate. Explicit implementations
replace those defaults. Private traits and unknown external trait defaults are not
exposed. This enumerates callable paths only and supplies no proof of their behavior.
