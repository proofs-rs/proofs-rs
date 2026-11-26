# Update, withdraw, and recover

## Update a report

Run `cargo proofs publish` again from the same crate to revise your Report. The
CLI publishes a new revision and keeps existing Claim IDs; an unchanged Report
produces no revision (`No changes; no new revision published.`). Earlier
revisions stay readable.

- **Prose only:** edit `proofs.toml` and publish. No new run is needed.
- **Proofs, source, or dependencies changed:** commit and push, record a new run
  with `cargo proofs run`, then publish. `publish` uses the latest run; select
  another with `--run <RUN_UUID>`.
- **New crate version:** a changed crate version starts a **new Report**. A
  Report's crate and version cannot change.

Fields you omit from `proofs.toml` keep their published text; an explicitly empty
value (`""`) clears it. Claim titles and explanations set through the
[HTTP API](api-documentation.md) are preserved. Contracts and evidence always come from the selected run.

Use `cargo proofs publish --dry-run` to see exactly what will change before you
publish.

## Removed claims

If a contract or theorem is missing from the new run, its Claim is removed only
after a yes/no prompt. In a noninteractive environment, pass `--yes` to approve.
Removed Claims keep their history and permanent links. If you restore the
contract later on the same machine, the CLI reuses its old Claim ID.

## Publish from another machine

The CLI remembers which Report it published in local state outside the
repository. On another machine, or after losing that state, attach to the
existing Report explicitly:

```sh
cargo proofs publish --report 123
```

The CLI matches Claims by API (and by theorem name for Aeneas). Without
`--report`, it would create a new Report.

## Conflicts

If the Report changed on the server since your last CLI publication, for example
through edits on the website, the CLI shows the differences and stops. The check
compares revision numbers, not content, so editing `proofs.toml` to match the
server does not clear it. Review the differences with `--dry-run`, adjust your
configuration if needed, then publish over the latest revision:

```sh
cargo proofs publish --force
```

`--force` overwrites the fields controlled by `proofs.toml` and preserves other
editorial fields. It does not approve Claim removal or bypass checks on the
recorded run.

## Interrupted publication

Before writing, the CLI saves the exact request. If publication is interrupted,
for example by a network failure, retry the saved request instead of creating a
second Report:

```sh
cargo proofs publish --resume
```

## Withdraw a report

To withdraw a Report, open it while signed in and use **Withdraw report**. A
withdrawn Report remains readable with a withdrawal notice, but cannot be updated
or receive new Findings. Reports that pinned it as dependency evidence show its
withdrawal. To have content removed rather than withdrawn, see
[Get help and give feedback](get-help.md).

For details of local publication state and matching rules, see
[Revisions, conflicts, and recovery](https://github.com/proofs-rs/cargo-proofs/blob/main/README.md#revisions-conflicts-and-recovery)
in the CLI documentation.
