# Record with Creusot

This page covers what is specific to Creusot. Follow
[Publish your first report](publish-a-report.md) for the common steps; in
short: install, `init` as below, commit and push `proofs.toml` and `Cargo.lock`,
`login`, `run` as below, `preview`, then `publish`. Unlike Kani, `init` needs
`--tool-target`.

## Set up and record

```sh
cargo proofs init --tool creusot --tool-target annotated --tool-version VERSION
cargo proofs run -- cargo creusot
```

Use the Creusot version you actually verified with; it must be registered on the
service. `init` tries `cargo creusot version` when `--tool-version` is omitted.
The resulting tool section looks like this:

```toml
[tool]
name = "creusot"
version = "VERSION"
target = "annotated" # required: "annotated" or "all"
```

`[tool].target` selects which APIs become Claims. It is unrelated to the Rust
compilation target, which you pass as `--target` after `--`.

## Which functions become Claims

- `annotated`: public free functions and concrete methods with `requires` or
  `ensures`.
- `all`: public free functions and concrete methods, even without these
  annotations. This selects source APIs; it does not attest that every function
  was verified.

Both exclude `trusted`, `logic`, `predicate`, `law`, and `check(ghost)` functions,
private items, and APIs without a public path. Trait declarations,
macro-generated APIs, and glob reexports are not discovered.

`requires` keeps its original Pearlite text as the Claim's precondition; several
predicates are parenthesized and joined with `&&`, and absence means `true`.
The recording also captures the function signature and each active `requires`
and `ensures` expression, preserving their original spacing and comments.
Postconditions remain separate from preconditions.

## Review the recorded specification

Both the local preview and the published Claim page show a **Creusot
specification** section with the signature, preconditions and postconditions.
For example, a mutable reference's final value can appear as `(^x)@` in an
`ensures` expression. The section links to the source at the recorded Git commit
and to the corresponding recorded check.

The displayed specification comes from the selected verification recording,
not from the current working tree or editable Claim explanation. Describe the
meaning of the specification and its limits in the Report and Claim explanations.
Older recordings remain readable; rerun verification to capture and display
their specifications.

Creusot uses the same recorded formal-evidence storage and Claim reference path
as Aeneas. Its payload is identified by `kind: "creusot"`; it contains the Rust
signature and predicates rather than a Lean proposition. Predicate definition
bodies and per-predicate definition links are not captured by the current
source extractor. The recorded-source link lets readers inspect that source;
Aeneas retains its separate compiler-derived direct-definition links.

## What a run must show

The prover run must create fresh `proof.json` sessions that map unambiguously to
the selected APIs. Compilation alone, unchanged stale sessions, unresolved proof
goals, and unsupported proof layouts do not certify an API. Review the tool
version's limitations on [Tools](/tools), including any panics outside the
verifier's coverage.

Continue with [Preview and publish](publish-a-report.md#5-preview).
