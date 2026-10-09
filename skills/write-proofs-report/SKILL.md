---
name: write-proofs-report
description: Write or revise proofs.rs verification reports for Rust crate and API users deciding what they can rely on. Use when drafting report explanations, assumptions, limitations, or proofs.toml editorial fields from verification artifacts, or rewriting process-heavy reports into evidence-backed guarantees and remaining risks.
---

# Write a proofs.rs report

Write for a developer who wants to use the crate or API and needs to judge its reliability. Assume familiarity with Rust, not with the verifier. Answer: **For my use of this API, what behavior is established, under what conditions, and what remains uncertain?**

## 1. Establish what the evidence supports

Read the supplied source, contracts or harnesses, verification results, and configuration before drafting. Follow evidence links when available. Treat old report prose as claims to check, not as proof. If only summaries are accessible, identify the draft as based on those summaries and list the missing evidence separately. Never imply that you inspected or reran unavailable artifacts.

Build a small working inventory; do not dump it into the report:

- Exact crate version, source revision, API, and relationship to the published crate. Identify verification-only changes and the evidence connecting changed code to the released implementation. Shared names or version numbers do not establish equivalence.
- Verified target, features, input domains, preconditions, harness bounds, and relevant dependencies or callbacks. Distinguish arbitrary inputs from a finite set of test cases or a bounded model.
- Actual behavioral specifications and successful results for that source. Separate body proofs from assumptions, helper contracts, specifications, tests, audits, and archived runs. A specification's existence does not establish that its implementation satisfies it.
- Assumptions and uncovered behavior that affect the reader's use. An absent assumption list does not mean there are no assumptions. Zero declared dependency reviews does not mean zero dependencies.

For each proposed guarantee, record its source/contract, supporting result, conditions, and assumptions. Check that evidence covers callees and compositions needed by the claim: proving a caller against helper contracts does not prove the helpers. If old and new runs cover different scopes, attach each claim to the right run and source; do not combine them into a fictitious complete run.

If evidence is insufficient or contradictory, narrow the claim and identify the gap. Ask only for information needed to resolve a material uncertainty; otherwise produce a clearly qualified draft. Do not invent a proof, diagnosis, or bug to complete a report.

## 2. Translate guarantees into API behavior

Lead with the useful behavior, not the verifier, workflow, difficulty, or number of checks. Use the API's actual semantics:

- Explain which inputs produce which results, including important error cases, when the contracts establish them.
- State absence of panics only over the proved input domain and relevant dependencies/callbacks. Distinguish termination, panics, aborts, and allocation failures when material.
- State memory-safety coverage independently of output correctness. Proving scalar-value or UTF-8 preconditions at one unsafe call does not establish all Rust undefined-behavior obligations.
- Explain stateful guarantees over repeated calls only when the evidence establishes the invariant and its initialization/preservation. One-step correctness alone may not establish end-to-end output histories.
- Keep domain distinctions: a hash algorithm's exact output does not establish collision resistance; a parser's state-table conformance does not by itself establish conformance to a format specification.

Prefer “For every input in [domain], [API] returns [specified result]” to “exact functional contracts were verified.” Include a short example only when it clarifies a guarantee already supported by evidence; never present the example as proof.

Do not infer confidence percentages, security ratings, or “safe to adopt” verdicts. Avoid unqualified “safe,” “fully verified,” “cannot crash,” and “production-ready.” Give the reader the evidence needed to make that judgment.

## 3. Make conditions and remaining uncertainty usable

Put a condition that materially changes the opening guarantee next to that guarantee, even if it also belongs in a limitations field. In particular, surface a modified verification fork, important input bounds, or an unchecked callback immediately. State the relationship to the crates.io release explicitly; if equivalence is unestablished, say the result applies to the fork and does not establish the same guarantee for the release.

For each material assumption, explain **what behavior is assumed and which guarantee depends on it**. A helper name or “physical permissions unproved” is not enough. For example, explain that a raw buffer conversion is assumed to preserve valid access to initialized bytes, so the result is conditional on that conversion and does not establish complete memory safety.

For each material gap, explain **which user question the evidence leaves unanswered**. Distinguish behavior proved under assumptions, behavior checked only by tests or review, behavior not established, and actual observed failures. Preserve their actual scope.

Do not describe an unproved property as a known vulnerability, or present a trusted assumption as a discovered defect. Avoid a generic catalogue of hypothetical risks. Include common tool assumptions compactly with a link when needed; foreground unusual local assumptions and limitations relevant to this API. Do not paste unrelated tool caveats into every report.

## 4. Write the report

Use the requested language; default to English for public proofs.rs contributions. Aim for a short overview that can be understood without opening an artifact. Add detail only when it changes applicability or the meaning of a guarantee.

Use this order, adapting headings and length to the case:

1. **Summary:** identify the API/version and concrete behavior established, with any qualification essential to understanding it.
2. **What is established:** a few distinct, user-facing guarantees with relevant domains and concise evidence references. Omit this section if the summary already states everything.
3. **Applicability and remaining uncertainty:** explain whether this applies to the published crate, relevant configuration, material assumptions, and unanswered questions.
4. **Evidence:** link to exact source/specifications and recorded results; put detailed reproduction information here or in an attached artifact.

Prefer one short paragraph or a few bullets per topic. Give each fact one primary home. Omit empty sections, repeated qualifications, phase histories, intermediate goal counts, solver logs, scratch paths, and descriptions of how hard the proof was. Keep such material in evidence artifacts when useful. Do not hide material limitations in those artifacts.

Organize the overview by user-visible behavior, never by fresh versus archived runs, proof phases, or artifact types. Keep those distinctions in evidence references or brief review notes unless they change applicability. Do not narrate your investigation. Translate “satisfies its panic contract” into what that contract actually allows or rules out; if the contract is unavailable, say that the panic guarantee could not be determined from the supplied material. State evidence provenance once rather than repeatedly saying “the report says.” For a small scope, aim for roughly 150–250 words of reader-facing prose; let necessary conditions determine the final length.

Choose a title about the behavior and scope, e.g. “Panic freedom of Parser::advance under a non-panicking receiver,” only if that is what the evidence supports. Avoid titles implying broader coverage than the body.

When writing existing proofs.rs fields, inspect the current schema/configuration first. Where these fields are supported, use:

- `report.title`: behavior and scope.
- `report.explanation`: the short user-facing account of guarantees, with essential qualifications inline.
- `report.trusted_assumptions`: assumed behavior and consequences for the stated guarantees.
- `report.limitations`: applicability restrictions and important unanswered user questions.
- `report.environment`: concise verification configuration and reproducibility details, not the conclusion.

Keep narrative guarantees accurate even if machine-readable labels are coarser. Explain the actual supported property in prose; do not inflate or mutate machine-readable claims to match a desired narrative. Preserve unrelated configuration, dependency reviews, tool settings, contracts, and evidence. Never invent fields or fabricate SARIF results. Use the destination's supported text format: current proofs.rs editorial fields display plain text, so do not rely on rendered Markdown tables, headings, or links there.

Produce a draft or requested file edits. Publishing, rerunning verification, changing proof code, or editing contracts requires authorization beyond merely writing a report. Do not rerun expensive proofs just to restate existing results. When emitting TOML, preserve unrelated fields and parse the result to validate syntax.

## 5. Review from the user's side

Before delivering, check:

- Can a crate user state the concrete guarantee after the opening paragraph?
- Can they tell whether their release, target, features, and input/callback behavior are covered?
- Is every positive guarantee supported by an inspected artifact, or explicitly attributed to an unverified source summary?
- Are important assumptions next to the guarantees they qualify, with their consequences explained?
- Are output correctness, panic behavior, memory safety, and security properties kept distinct where relevant?
- Does the draft distinguish “not established” from “unsafe,” and bounded checks from broader proofs?
- Can they find evidence without reading a proof-development history?

Remove any sentence that neither helps interpret a guarantee nor helps locate its evidence. Deliver the report plus only material evidence gaps or review notes; do not append the working inventory or this checklist.
