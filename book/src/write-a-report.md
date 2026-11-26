# Write a useful report

Write for a Rust developer deciding whether they can rely on your crate or API,
without assuming they know your verifier. Readers should be able to answer: what
behavior is established, under what conditions, why the evidence is meaningful,
and what remains uncertain.

## What to put in each field

| Field | Shown as | What to write |
| --- | --- | --- |
| `title` | Report title | The behavior and scope, such as "Panic freedom of `parse` for all inputs". |
| `explanation` | **Overview** | What the API does, the concrete guarantees, and the conditions they depend on. |
| `trusted_assumptions` | **What is trusted** | Behavior assumed without proof, such as stubs, trusted helpers, or allocator success, and why each is acceptable. |
| `limitations` | **Technical limitations** | What is not covered: differences from the crates.io release, restricted targets or features, bounded inputs, and open questions. |
| `environment` | **Reproduce › Environment** | Run configuration that readers need to reproduce the result, such as toolchain patches. |

Some guidelines:

- **State concrete behavior.** Prefer "For every `x < u32::MAX`, `increment(x)`
  returns `x + 1` without panicking" to "exact functional contracts were
  verified".
- **Keep conditions next to the guarantee.** If a guarantee holds only for some
  inputs, targets, or features, say so in the same sentence.
- **Explain trust, don't just list it.** For each trusted operation, say what is
  assumed, which guarantee depends on it, and why you accept it. "Trusted helper"
  alone does not let readers judge the boundary.
- **Explain adaptations.** If you verified a fork, say what changed, why, and
  whether equivalence to the release was proved or only argued.
- **Do not overstate.** Avoid unqualified "safe", "fully verified", or
  "production-ready". Distinguish formal proof, tests, and source reasoning.
- **Leave process details out of prose.** Commands, solver logs, and goal counts
  are already in the recorded run.

## Example

```toml
[report]
title = "Panic freedom and overflow behavior of increment"
explanation = '''
`increment(x)` adds one to a `u32`.

For every `x < u32::MAX`, it returns `x + 1` and does not panic. The proof
covers all inputs in that range, not a sample.
'''
trusted_assumptions = '''
None beyond the Rust compiler and Kani's model of Rust semantics.
'''
limitations = '''
- Calls with `x == u32::MAX` are outside the precondition and panic in debug
  builds.
- Verified on the crate source at the recorded commit, which is identical to the
  crates.io release.
'''

[tool]
name = "kani"
version = "0.68.0"
```

All fields except `title` support Markdown; see
[Configuration and Markdown](configuration.md#markdown-in-reports). Use
[Preview a report locally](preview-a-report.md) to read the result as a reader
would.

## Claim explanations

`cargo proofs` publishes each Claim with a generated title, such as
`Verification of my_crate::parse (with Kani 0.68.0)`, and no explanation of its
own. The Claim page then points readers to the Report's **Overview**, so make
the Overview name each verified API and what it guarantees.

A Claim can also carry its own title, explanation, trusted assumptions, and
limitations. These can currently be set only by publishing a Report revision
through the [HTTP API](api-documentation.md). `cargo proofs publish` keeps them
when it later revises the Report.

## Using an AI agent

If you use an AI agent to draft the report, give it the
[write-proofs-report skill](https://proofs.rs/skills/write-proofs-report/SKILL.md).
It guides the agent to read the evidence and explain guarantees in terms of API
behavior. Paste this into the agent working on your verified crate:

```text
Read and follow this report-writing skill:
https://proofs.rs/skills/write-proofs-report/SKILL.md

Draft the editorial [report] fields in proofs.toml for this crate, using its
source, verification contracts or harnesses, and recorded results. Write for
someone deciding whether they can rely on the API. Explain the concrete
guarantees, applicability to the published crate, assumptions, and remaining
uncertainty. Identify missing evidence rather than filling gaps with guesses.
If adding [[report.findings]], write each title and Markdown body in English.
Include only findings that add information beyond the report body; do not repeat
the overview, assumptions, or limitations.
Preserve unrelated configuration and machine-readable claims. Do not publish.
```

Provide the source revision, contracts or harnesses, recorded verification
results, target and feature configuration, and any differences from the published
crate. Point to their files or URLs; the agent should not need to guess where they
are. If it cannot fetch the skill URL, provide the contents of `SKILL.md` directly.

For repeated use, save the public Markdown as `write-proofs-report/SKILL.md`
and install it with your agent's skill installation mechanism. Keep the
downloaded file if you need a fixed version of the instructions.

Review the draft yourself before publishing: you are responsible for every
statement in the Report.

Continue with [Publish your first report](publish-a-report.md#5-preview) to
preview and publish your report.
