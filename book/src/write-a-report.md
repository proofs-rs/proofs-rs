# Write a useful report

Your reader wants to use the crate. Help them understand what they can rely on,
whether the result applies to their use, and what remains uncertain.

If you use an AI agent to write your report, use the
[write-proofs-report skill](https://github.com/proofs-rs/proofs-rs/tree/main/skills/write-proofs-report).
It guides the agent to read the evidence and explain guarantees in terms of API
behavior. You remain responsible for checking that the report matches the evidence.

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

## Explain what the result means to a user

A useful report answers three questions:

- **What can I rely on?** State concrete behavior: which inputs produce which
  results, which errors are handled, or which failures are ruled out.
- **Does this cover my use?** Identify the API/version, relevant target and
  features, input restrictions, and whether the evidence applies to the published
  implementation or only a modified fork.
- **What is still assumed or unknown?** Explain how unchecked operations,
  dependencies, callbacks, or other material gaps affect those guarantees.

For example, suppose a decoder's contracts and results establish the following
behavior. An explanation might say:

> For inputs containing only hexadecimal digits, with an even length and an
> output slice exactly half that length, `decode_to_slice` writes the decoded
> bytes and succeeds. Other inputs return an error. These cases do not panic.
> This result covers the slice API on the recorded target with default features
> disabled; allocating convenience APIs are outside its scope.

This is an illustrative example, not a claim about a particular published crate.
Only state each property when the evidence supports it. If the proof applies to a
modified implementation, or depends on an unchecked operation, say so alongside
the guarantee. Do not infer that an error leaves the output unchanged unless that
is established too.

## Put information in the right fields

| Field | What the reader needs |
| --- | --- |
| `title` | The behavior and API covered. |
| `explanation` | Concrete guarantees, with essential qualifications close to them. |
| `trusted_assumptions` | What behavior is assumed, and which guarantees depend on it. |
| `limitations` | Important applicability restrictions and unanswered questions. |
| `environment` | Verification configuration and reproduction context. |

The report displays `trusted_assumptions` as **What is trusted** and `limitations`
as **Technical limitations**. These fields display plain text. Keep source,
specifications, and detailed run information in the linked evidence rather than
filling the explanation with logs or a history of proof attempts.

A passing-check count does not describe a guarantee. A proof of the returned value
does not automatically establish memory safety. A result not established by the
evidence is not necessarily a bug. Keep these distinctions clear, and avoid an
overall safety score or an unsupported recommendation to adopt the crate.

## Review and publish

Read the opening paragraph as a crate user: can you tell what is guaranteed and
whether it applies to you? Check each guarantee against the actual specification
and result, including its assumptions. Resolve material evidence gaps before
publishing any claim that depends on them.

Continue with [Publish a report](publish-a-report.md) to record the evidence,
preview the upload, and publish it.
