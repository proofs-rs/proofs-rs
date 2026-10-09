# Write a useful report

If you use an AI agent to write your report, use the
[write-proofs-report skill](https://github.com/proofs-rs/proofs-rs/tree/main/skills/write-proofs-report).
It guides the agent to read the evidence and explain guarantees in terms of API
behavior.

## Give your agent the skill and evidence

Paste this into the agent working on your verified crate:

```text
Read and follow this report-writing skill:
https://raw.githubusercontent.com/proofs-rs/proofs-rs/main/skills/write-proofs-report/SKILL.md

Draft the editorial [report] fields in proofs.toml for this crate, using its
source, verification contracts or harnesses, and recorded results. Write for
someone deciding whether they can rely on the API. Explain the concrete
guarantees, applicability to the published crate, assumptions, and remaining
uncertainty. Identify missing evidence rather than filling gaps with guesses.
Preserve unrelated configuration and machine-readable claims. Do not publish.
```

Provide the source revision, contracts or harnesses, recorded verification
results, target and feature configuration, and any differences from the published
crate. Point to their files or URLs; the agent should not need to guess where they
are. If it cannot fetch the skill URL, provide the contents of `SKILL.md` directly.

For repeated use, install the `skills/write-proofs-report` folder from the
repository using your agent's skill installation mechanism. The core instructions
are self-contained in `SKILL.md`; `agents/openai.yaml` supplies optional UI metadata.
To keep a fixed version, use a Git commit permalink instead of `main`.

Continue with [Publish a report](publish-a-report.md) to preview and publish your report.
