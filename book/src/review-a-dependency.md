# Review a dependency

Use a dependency's verification report as evidence for your own report. This
walkthrough reviews a `serde` dependency, pins the evidence you read, and publishes
that declaration with your crate's verification results.

Start with a crate configured for `cargo proofs`, with verification harnesses of
its own. If you have not set that up, follow [Publish a report](publish-a-report.md)
first. Recording your crate does not automatically run proofs for its dependencies.

## 1. Identify the package you use

Check your committed Cargo.lock and the features and target used by your verifier.
For example, from your crate's directory:

```sh
cargo tree --locked --package your-crate --target x86_64-unknown-linux-gnu
```

Replace `your-crate` and the target with your actual package and target. Add the
same `--features`, `--all-features`, or `--no-default-features` options you use for
verification. Find the dependency's package name, resolved version, and source.
Use the package name `serde` even if Cargo.toml gives it a different dependency
alias. If several versions occur, you will review the version covered by your
chosen evidence report.

## 2. Read an evidence report

[Search proofs.rs](/crates) for the dependency and open its crate page. Choose a
public, non-withdrawn report for the resolved crates.io version.

Read the report and the claims for the APIs your crate uses. Check the claim's
preconditions, **What is trusted**, and **Technical limitations**, including the
verification tool's limitations and the recorded environment. Decide whether the
evidence applies to your use:
a claim about one API under stated assumptions is not a guarantee for the entire
library or your application.

Open the specific report revision you reviewed and note its report number and
revision number. A newer revision does not replace this evidence automatically.
If you cannot find suitable evidence, you can verify the dependency itself and
publish a report from its source using the [existing publishing
steps](publish-a-report.md). Return here once that report is public.

## 3. Pin your review in proofs.toml

Add this section to **your consuming crate's** `proofs.toml`:

```toml
[dependencies]
# Example placeholders only: replace both numbers with the evidence you reviewed.
serde = { report = 123, revision = 2 }
```

The example numbers do not identify a recommended or known report. There is one
report reference per package name. Do not add `version` or `rationale` fields:
the referenced report supplies the version, and publication checks it against the
saved run. You may leave other dependencies unlisted.

## 4. Record your crate with the intended dependencies

Commit and push your source and Cargo.lock, then record the same verification
command, features, and target you checked in step 1. For example:

```sh
cargo proofs run -- cargo kani --target x86_64-unknown-linux-gnu
```

The CLI records a dependency resolution snapshot from the committed checkout,
using locked Cargo metadata and package-scoped Cargo tree. Publication compares
your review with that saved snapshot; changing the current working tree's lockfile
cannot change a previous run's evidence. The snapshot describes resolved packages,
not a claim that every package was compiled or verified.

If your selected run predates dependency snapshots, record a new run. Historical
runs were migrated with empty snapshots and cannot support a new dependency review.
If you already have a current run with the intended dependencies, adding or
changing only the evidence reference does not require another run.

## 5. Preview, publish, and inspect

```sh
cargo proofs publish --dry-run
cargo proofs publish
```

The dry run shows the dependency reference being added. Publication checks that
the evidence is available and its crate and exact version occur with a crates.io
source in the recorded snapshot. A Git or path fork with the same name and version
cannot satisfy this check.

Open the resulting report and find **Reviewed dependencies (1)**. Check the package
version and follow the evidence link to the exact revision you read. This is your
declaration as the report author; proofs.rs does not independently certify your
judgment, source equivalence, or the correctness of the combined application.

## Update or remove the review

When updating a dependency, commit and push the new lockfile and source, record a
new run, review matching evidence, and update the reference before publishing.
When only the evidence report or revision changes, edit the reference and publish
using the existing matching run.

Omitting `[dependencies]` preserves the previous reviews when updating your
report. To remove all reviews, publish with an explicitly empty section:

```toml
[dependencies]
```

The report will show zero reviewed dependencies. This does not mean the crate has
zero dependencies; publishing with unreviewed dependencies is allowed.

## If publication fails

- **The dependency is absent or its version differs:** check the selected run's
  snapshot and the evidence report's version. Record a new run for changed
  dependencies; a report for another version cannot cover them.
- **The source differs:** a Git, path, or alternative registry package is not
  interchangeable with a crates.io package by name and version.
- **The report or revision is unavailable:** check the numbers and choose public,
  non-withdrawn evidence. `--force` does not bypass these checks.

If evidence is withdrawn later, your historical review remains and displays its
current withdrawal. Hidden evidence is marked unavailable. Review replacement
evidence yourself and pin it explicitly when you next update your report.
