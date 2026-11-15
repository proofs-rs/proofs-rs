# Real Creusot proof and recording check

This fixture covers a return value, a precondition and the final value of a
mutable reference (`(^x)@`). It uses `creusot-std = "=0.13.0"` and a committed
Cargo.lock. It is a replacement fixture; the previous chat's source is unavailable.

From `cli/`, with Creusot and its official pinned dependencies on PATH:

```sh
. /workspace/formal-tools/activate.sh
cargo +1.91.1 build --locked
python3 tests/real_creusot.py target/debug/cargo-proofs /workspace/scratch/creusot-real-check
```

The output directory must not exist. The test preserves logs, generated Coma,
actual `proof.json` files and the recorded SARIF there. It first proves all three
APIs with Alt-Ergo using `--no-cache`, then invokes `cargo proofs run` in a new
detached checkout, which generates new proof files. It checks successful SARIF
results and prover leaves, and checks that compilation alone cannot produce a
successful recorded run.

Generated `target/`, `verif/` and `.why3find/` cache files are excluded from the
test's source commit. Source and Cargo.lock remain tracked, so the recorder's
input-change check stays enabled. The standalone proof uses `-- --locked`;
the recorder rejects nested `--`, so its run uses `cargo creusot --no-cache`
and checks that tracked inputs remain unchanged.

Only GitHub's advertised URL is replaced by a local Git remote, following the
existing `e2e.py` convention. No compiler, Why3find or prover is mocked. Nothing
is uploaded and the source URL in this test evidence is not a public source.

Required versions from Creusot 0.13.0's `creusot-deps.opam`:

- OCaml 5.3.0
- Why3 commit `54c92f96bb0711d6e991c18f10bfbc08d90d028b`
- Why3find commit `eab37557d3e24e1913a3c4f44bc5528ef497c6c9`
- Alt-Ergo 2.6.2 (the fixture selects this prover)

To check the unchanged real SARIF against production server handlers, from the
repository root:

```sh
PROOFS_REAL_CREUSOT_SARIF=/workspace/scratch/creusot-real-check/run.sarif.json \
  node --import tsx --test tests/real-creusot.ts
```

This uses an in-memory database and archive. It checks preparation without
storage, ingestion and retry, exact stored bytes, Report validation/creation,
Claim API responses and public Claim HTML containing the recorded preconditions.
It also starts the real CLI preview against the saved local run, checks all three
Claim pages and verifies that preview serves the complete original SARIF data
(JSON formatting may differ).
It does not write to the external service. The initial Python test only covers
the recorder; the TypeScript checks are a separate explicit step.

The Python test also checks exact signature/requires/ensures extraction against
the fixture, including `(^x)@`. The TypeScript checks compare Claim API spec data
with the recorded spec, verify all expressions in public and preview HTML, and
follow the preview's recorded-check link. The proof trees come from real
Alt-Ergo executions, unlike the synthetic verifier outputs in `e2e.py` and the
standard producer/consumer contract suite.
