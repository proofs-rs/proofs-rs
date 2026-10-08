# Publish a report

Publish your verification reports with `cargo proofs`.

## Getting started with Kani

### 1. Install

```sh
cargo install cargo-proofs --locked
```

Requires Rust 1.91 or newer.

### 2. Set up your report

Run inside the crate you verified.

```sh
cargo proofs init --tool kani
```

Discovers `#[kani::proof_for_contract(...)]` harnesses and creates No UB and Panic contract claims.

Edit `proofs.toml` to set the report title and check the tool version used for verification. You can also add an explanation, assumptions, limitations, and environment.

<details>
<summary>Example proofs.toml</summary>

```toml
[report]
title = "Contract verification of my crate"
# explanation = "What this report covers"
# trusted_assumptions = "Assumptions used in verification"
# limitations = "Scope restrictions"
# environment = "Verification environment"

[tool]
name = "kani"
version = "0.66.0" # Version used for verification
```

</details>

### 3. Sign in

```sh
cargo proofs login
```

Authorize the CLI in your browser with your GitHub account.

### 4. Preview and publish

Commit and push your source and Cargo.lock before recording verification.

```sh
cargo proofs run -- cargo kani
```

Only SARIF results with embedded logs are uploaded. Source stays on GitHub. No additional push is needed between run and publish.

```sh
cargo proofs publish --dry-run
cargo proofs publish
```

The CLI prints a link to your published report. Run `cargo proofs publish` again to update the same report.

Using another tool? See [Tools](/tools) for supported tools and instructions.

[CLI documentation →](https://github.com/proofs-rs/proofs-rs/blob/main/cli/README.md)

### Field names and page labels

The pages display `trusted_assumptions` as **What is trusted** and `limitations` as **Technical limitations**. The JSON and CLI configuration keys remain unchanged. Report-level and claim-level fields retain their existing scope; tool limitations are maintained separately. This is a display-name change, not a change to the meaning or contents of existing reports.
