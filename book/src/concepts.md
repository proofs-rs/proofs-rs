# Concepts

## Report

A Report is the unit in which verification results are published and discussed. It concerns one version of one crate and groups together the verification tool and version used, an explanation of the verification, assumptions, limitations, evidence, and individual Claims.

## Claim

A Claim is a verification statement about a particular API. For example, it may state that, under the specified assumptions and within the stated verification scope, the API does not exhibit undefined behavior or panic. A Claim is not a comprehensive guarantee about the crate as a whole.

## Tool

A Tool represents the verification tool used. Known limitations are recorded by version and are kept separate from assumptions or limitations specific to an individual Report.

## Discussion

Comments allow public questions, objections, and responses concerning a Report. Discussion takes place at the Report level. Updates to a Report are preserved as Revisions, so earlier versions remain available for reference.

## Reproduce

Reproduce provides the information needed to rerun a verification, including the relevant Git commit, invocation, tool version, check results, and logs. Execution records are stored in SARIF format, while verification source code is referenced by a specific commit in an external repository. These records describe the contributor’s execution; they do not imply that proofs.rs has independently reproduced the result. In the future, the service may add automated reproduction or AI-assisted checks.

## Reviewed dependencies

A report can list dependencies whose verification reports its author reviewed.
Each entry pins one evidence report revision and its crate version. The service
checks that this package was present in the recorded Cargo dependency resolution;
it does not independently certify the author's judgment or claim that every
resolved package was compiled during verification. The list may cover only part
of a crate's dependencies. A count of zero means no dependency reviews were
declared.

Evidence does not automatically follow newer report revisions. If an evidence
report is later withdrawn, the historical entry remains and shows its current
withdrawal. Hidden evidence is marked unavailable without revealing its content.
