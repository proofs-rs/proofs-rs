# Verification record profile

SARIF 2.1.0 is the canonical execution record. CLI recordings persist one
`run.sarif.json`; there is no separate execution metadata file. The service
accepts the complete file in one `POST /api/v1/runs/{uuid}/sarif` request and
validates it before writing evidence. An identical retry returns the existing
record; changing its contents or owner is rejected.

Each document has one run and one invocation. The invocation must have completed
successfully with exit code zero. At least one embedded output stream is required.

| Information | SARIF location |
| --- | --- |
| Run UUID | `runs[0].automationDetails.guid` |
| Verifier name/version | `runs[0].tool.driver` |
| Source repository and fixed commit | `runs[0].versionControlProvenance[0].repositoryUri` / `revisionId` |
| Executable and arguments | `invocations[0].executableLocation.uri` / `arguments` |
| Working directory, relative to the Git root | `invocations[0].workingDirectory.uri` |
| Start/end times and exit status | `invocations[0].startTimeUtc`, `endTimeUtc`, `exitCode`, `executionSuccessful` |
| Environment overrides | `invocations[0].environmentVariables` |
| Raw output | `invocations[0].stdout`, `stderr`, or `stdoutStderr`, referencing `artifacts[index].contents.text` |
| Individual checks | `results`, with `properties.harness` linking each check to a contract |

The only proofs.rs extension is `runs[0].properties.proofs`:

```json
{
  "schemaVersion": 2,
  "dependencies": [{
    "crate": "serde",
    "version": "1.0.228",
    "source": "registry+https://github.com/rust-lang/crates.io-index"
  }],
  "crate": "example",
  "version": "1.0.0",
  "contracts": [{
    "harness": "example::check_f",
    "api_paths": ["example::f"],
    "properties": ["no_ub"],
    "precondition": "true",
    "file": "src/lib.rs",
    "first_line": 1,
    "last_line": 8
  }],
  "target": null,
  "platform": "linux x86_64",
  "rustc": "rustc -vV output",
  "recorderVersion": "0.3.0"
}
```

`schemaVersion`, `crate`, `version`, `contracts`, and `dependencies` are required.
The snapshot contains the selected package's reachable resolved Cargo packages,
with exact versions and source identities, captured using `cargo metadata --locked`
in the run worktree with the invocation's Cargo feature and target flags.
`cargo tree --locked --package <selected-package>` with the same flags limits this
snapshot to that package, avoiding features enabled only by sibling workspace
members. Package versions and source identities remain those from locked metadata.
Ambiguous source identities or unsupported package-selection options stop recording. It is
resolution evidence, not a statement that all these packages were compiled.
Path packages retain a stable `path+<relative-package-directory>` source identity and Git/alternative registry packages
retain their Cargo source; they cannot satisfy a crates.io review by name/version
alone. The selected package itself is excluded. `[]` is a valid empty snapshot.
 `target` records
adapter configuration when applicable. Platform/compiler/recorder values are
optional context. Every published contract must have observed successful results.
The service resolves the registered tool version from the SARIF driver; a client
cannot supply an inconsistent tool ID or independent execution metadata.

D1 retains only the run UUID, author, crate/version and tool-version search indexes,
SHA-256, byte size, R2 key and creation time, plus normalized dependency rows
for publication checks. Execution details and contracts are
read from SARIF when needed. `GET /runs/{uuid}` returns the storage/index summary;
`GET /runs/{uuid}/sarif` returns the canonical document. Source file contents are
not embedded; only referenced output stream artifacts may contain text.

R2 and D1 cannot commit atomically. Each upload attempt uses a unique object key.
If registration fails, its object is removed after checking that D1 did not commit.
A scheduled sweep reclaims unregistered objects older than 24 hours, including
crash leftovers. Valid registered runs are preserved even before report publication.

Historical schema-v1 objects must be migrated once to schema v2 with empty
snapshots and new hash/size indexes before deployment. New v1 uploads are rejected.
See [the migration procedure](dependency-migration.md).
