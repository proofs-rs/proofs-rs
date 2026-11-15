import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderPreview, type Snapshot } from "../preview/render";
import { createViews } from "../src/site-views";
import { claimTitle } from "../web/claim-title";
import { renderRecordedRun } from "../web/recorded-run";

function fixture(): Snapshot {
  return {
    server: "https://staging.example",
    warnings: [],
    report: {
      id: null,
      title: "Local report",
      crate: "demo",
      version: "1.0.0",
      explanation: "## Details\n**Overview** <script>alert(1)</script>",
      trusted_assumptions: "Shared trust",
      limitations: "Shared limits",
      environment: "Local environment",
      evidence_url: "https://github.com/demo/repo/tree/abc",
      run_ids: ["run"],
      tool: "Kani",
      tool_version: "1",
      tool_version_id: "kani-1",
      tool_limitations: "Tool limits",
      direct_dependencies: null,
      dependencies: [
        {
          crate: "dep",
          report: 42,
          revision: 2,
          version: "1.0.0",
          withdrawn: true,
        },
      ],
      claims: [
        {
          id: "preview-claim-0",
          api_item_id: "api-f",
          display_path: "demo::f",
          signature: "pub fn f(x: u8)",
          kind: "function",
          is_unsafe: 0,
          claim_number: 1,
          title: "",
          precondition: "x > 0",
          explanation: "**Claim text**",
          evidence_url: "https://github.com/demo/repo/blob/abc/lib.rs#L1",
          trusted_assumptions: "Claim trust",
          limitations: "Claim limits",
        },
      ],
    },
    sarif: {
      runs: [
        {
          invocations: [
            {
              executableLocation: { uri: "cargo" },
              arguments: ["kani"],
              workingDirectory: { uri: "./" },
              executionSuccessful: true,
              exitCode: 0,
              startTimeUtc: "2026-10-18T00:00:00Z",
              endTimeUtc: "2026-10-18T00:00:01Z",
              stdout: { index: 0 },
            },
          ],
          artifacts: [{ contents: { text: "log <script>unsafe</script>" } }],
          versionControlProvenance: [
            {
              repositoryUri: "https://github.com/demo/repo",
              revisionId: "abc",
            },
          ],
          properties: {
            proofs: {
              contracts: [
                {
                  harness: "check_f",
                  api_paths: ["demo::f"],
                  precondition: "x > 0",
                },
              ],
            },
          },
          results: [
            {
              kind: "pass",
              message: { text: "Verified f" },
              properties: { harness: "check_f" },
            },
          ],
        },
      ],
    },
  };
}

test("preview uses production report, claim, Markdown and recorded-run rendering", () => {
  const data = fixture();
  const views = createViews(
    { user: null },
    { show_star_karma: false },
    () => "",
  );
  const preview = new JSDOM(renderPreview(data, "/report").html);
  const production = new JSDOM(views.reportBody(data.report));
  for (const selector of [".report-limitations", ".report-environment"]) {
    assert.equal(
      preview.window.document.querySelector(selector)!.textContent,
      production.window.document.querySelector(selector)!.textContent,
    );
  }
  const claim = {
    ...data.report.claims[0],
    title: claimTitle("", "demo::f", "Kani", "1"),
    tool: "Kani",
    tool_version: "1",
    tool_version_id: "kani-1",
    tool_limitations: "Tool limits",
    shared_trusted_assumptions: "Shared trust",
    shared_limitations: "Shared limits",
  };
  const localClaim = new JSDOM(
    renderPreview(data, "/claim/preview-claim-0").html,
  );
  const liveClaim = new JSDOM(views.claimContent(claim));
  for (const selector of ["h1", ".signature", ".report-explanation"]) {
    assert.equal(
      localClaim.window.document.querySelector(selector)!.innerHTML,
      liveClaim.window.document.querySelector(selector)!.innerHTML,
    );
  }
  assert.deepEqual(
    [...localClaim.window.document.querySelectorAll(".report-section")].map(
      (e) => e.textContent,
    ),
    [...liveClaim.window.document.querySelectorAll(".report-section")].map(
      (e) => e.textContent,
    ),
  );
  const localRun = new JSDOM(renderPreview(data, "/runs/run").html);
  const liveRun = new JSDOM(
    renderRecordedRun(
      data.sarif,
      "run",
      0,
      { ...data.report, id: "preview" },
      true,
    ),
  );
  assert.equal(
    localRun.window.document.querySelector(".recorded-run")!.textContent,
    liveRun.window.document.querySelector(".recorded-run")!.textContent,
  );
  for (const dom of [
    preview,
    production,
    localClaim,
    liveClaim,
    localRun,
    liveRun,
  ])
    dom.window.close();
});

test("preview routes stay local, metadata links use configured origin, and no actions are exposed", () => {
  const data = fixture();
  const dom = new JSDOM(renderPreview(data, "/report").html);
  const d = dom.window.document;
  assert(d.body.textContent.includes("Local preview — not published"));
  assert(d.body.textContent.includes("New report"));
  assert(!d.body.textContent.includes("Report #null"));
  assert(d.querySelector('a[href="/claim/preview-claim-0"]'));
  assert.equal(
    d.querySelector(".api-name")!.getAttribute("href"),
    "/claim/preview-claim-0",
  );
  assert.equal(
    d.querySelector('a[href="https://staging.example/api/api-f"]'),
    null,
  );
  assert.equal(
    renderPreview(data, d.querySelector(".api-name")!.getAttribute("href")!)
      .status,
    200,
  );
  assert(d.querySelector('a[href="https://staging.example/report/42?v=2"]'));
  assert(
    d.querySelector('a[href="https://staging.example/tool-version/kani-1"]'),
  );
  assert(d.querySelector('a[href="/runs/run#logs"]'));
  assert(d.querySelector('a[href="/api/v1/runs/run/sarif"]'));
  assert.equal(d.querySelector("form"), null);
  assert.equal(d.querySelector(".star-controls"), null);
  assert.equal(d.querySelector(".markdown-body script"), null);
  assert.equal(d.querySelector('link[rel="canonical"]'), null);
  data.report.claims[0].api_item_id = "preview-api-0";
  data.warnings.push("API mapping unverified: <f>");
  const missing = new JSDOM(renderPreview(data, "/claim/preview-claim-0").html);
  assert(
    missing.window.document.body.textContent.includes(
      "API mapping unverified: <f>",
    ),
  );
  assert.equal(
    missing.window.document.querySelector('a[href*="/api/preview-api-"]'),
    null,
  );
  assert.equal(renderPreview(data, "/claim/missing").status, 404);
  data.report.id = 12;
  data.report.base_revision = 3;
  assert(
    renderPreview(data, "/report").html.includes(
      "Draft revision of report #12 (based on v3)",
    ),
  );
  assert.equal(data.report.claims[0].title, "");
  dom.window.close();
  missing.window.close();
});

test("preview resolves inline definition links at the same recorded revision as live views", async () => {
  const { formalSourceLinks } = await import("../web/formal-evidence");
  const snapshot = fixture();
  const claim = snapshot.report.claims[0];
  claim.evidence_ref = { run_id: "run", harness: "check_f" };
  const contract = snapshot.sarif.runs[0].properties.proofs.contracts[0];
  contract.formal = {
    theorem: "check_f",
    binders: [
      {
        kind: "variable",
        name: "s",
        type: "Demo.State",
        type_segments: [{ text: "Demo.State", ref: "Demo.State" }],
      },
    ],
    conclusion: "s = s",
    statement: "∀ s : Demo.State, s = s",
    mapping: "manual",
    source: { file: "Proofs.lean", first_line: 2, last_line: 3 },
    definitions: [
      {
        name: "Demo.State",
        module: "Demo",
        source: { file: "Demo.lean", first_line: 5, last_line: 8 },
      },
    ],
  };
  const result = renderPreview(snapshot, "/claim/preview-claim-0");
  const preview = new JSDOM(result.html).window.document;
  const live = new JSDOM(
    createViews({ user: null }, {}, () => "").claimContent({
      ...claim,
      formal_evidence: formalSourceLinks(
        contract.formal,
        "https://github.com/demo/repo",
        "abc",
      ),
    }),
  ).window.document;
  const href = (d: Document) =>
    d.querySelector(".lean-expression a")?.getAttribute("href");
  assert.equal(
    href(preview),
    "https://github.com/demo/repo/blob/abc/Demo.lean#L5-L8",
  );
  assert.equal(href(preview), href(live));
});

test("Finding drafts appear after Overview, remain separate from successful checks, and have local anchors", () => {
  const snapshot = fixture();
  snapshot.report.finding_drafts = [
    {
      title: "Signed read <bug>",
      body: "Return **-1**, but returns 255.\n\n```rust\ntry_get_int(1)\n```\n\n[Issue](https://example.test/issue)\n\n<script>bad()</script>\n\n[bad](javascript:alert(1))",
      evidence_url: "https://example.test/evidence",
      api_item_ids: [],
    },
  ];
  snapshot.sarif.runs[0].properties.proofs.localOnly = true;
  snapshot.sarif.runs[0].versionControlProvenance[0].repositoryUri =
    "file:///local/source";
  const result = renderPreview(snapshot, "/report");
  const dom = new JSDOM(result.html),
    d = dom.window.document;
  assert.equal(d.querySelector(".report-explanation"), null);
  assert.match(
    d.querySelector(".report-outcome")!.textContent!,
    /1 verified claim · 1 finding\b/,
  );
  assert.match(
    d.querySelector("#findings")!.textContent!,
    /Local Finding draft · Not submitted/,
  );
  assert.equal(
    d.querySelector("#finding-draft-1 h3 a")!.getAttribute("href"),
    "/finding/draft-1",
  );
  assert.equal(
    d.querySelector("#finding-draft-1 h3")!.textContent,
    "Signed read <bug>",
  );
  assert.equal(d.querySelectorAll("#findings form").length, 0);
  assert.equal(d.querySelector("#findings .markdown-body"), null);
  const detail = new JSDOM(renderPreview(snapshot, "/finding/draft-1").html)
    .window.document;
  assert.equal(detail.querySelector(".finding strong")?.textContent, "-1");
  assert.match(
    detail.querySelector(".finding pre code")!.textContent!,
    /try_get_int/,
  );
  assert.equal(
    detail.querySelectorAll(".finding script, .finding a[href^='javascript:']")
      .length,
    0,
  );
  assert.doesNotMatch(
    d.querySelector("#findings")!.textContent!,
    /not_reported|Expected behavior|Reproduction steps/,
  );

  assert.match(
    d.querySelector(".recorded-run")!.textContent!,
    /cannot be uploaded or published/,
  );
  assert.equal(
    [...d.querySelectorAll("a")].filter(
      (a) => a.textContent === "Source on GitHub",
    ).length,
    0,
  );
  assert.equal(snapshot.sarif.runs[0].results.length, 1);
  assert.equal(snapshot.report.findings, undefined);
  dom.window.close();
  snapshot.report.finding_drafts[0].body = "";
  assert.throws(() => renderPreview(snapshot, "/report"));
});

test("existing report preview renders published Markdown and remote history without draft identities", () => {
  const snapshot = fixture();
  snapshot.report.id = 12;
  snapshot.report.findings = [
    {
      id: "published",
      report_id: 12,
      origin_revision_no: 1,
      title: "An observation",
      body: "**Published** body",
      validity: "reported",
      upstream_status: "not_reported",
      updated_at: "2026-10-23T00:00:00Z",
      links: [],
      apis: [],
    },
    {
      id: "invalid",
      report_id: 12,
      origin_revision_no: 1,
      title: "Historical",
      body: "Old body",
      validity: "invalid",
      upstream_status: "not_reported",
      updated_at: "2026-10-23T00:00:00Z",
      links: [],
      apis: [],
    },
  ];
  const dom = new JSDOM(renderPreview(snapshot, "/report").html),
    d = dom.window.document;
  assert.equal(d.querySelector("#finding-published .markdown-body"), null);
  assert.match(d.querySelector(".report-outcome")!.textContent!, /1 finding\b/);
  assert.equal(d.querySelectorAll(".finding").length, 2);
  assert.doesNotMatch(
    d.querySelector("#findings")!.textContent!,
    /Local Finding draft/,
  );
  assert.equal(
    d.querySelector("#finding-published h3 a")?.getAttribute("href"),
    "/finding/published",
  );
  assert.equal(d.querySelectorAll("#findings form").length, 0);
  dom.window.close();
  const detail = new JSDOM(renderPreview(snapshot, "/finding/published").html);
  assert.equal(
    detail.window.document.querySelector(".finding strong")?.textContent,
    "Published",
  );
  assert.equal(renderPreview(snapshot, "/finding/missing").status, 404);
  detail.window.close();
  snapshot.report.findings[0].withdrawn_at = "2026-10-23T12:00:00Z";
  const withdrawn = new JSDOM(renderPreview(snapshot, "/report").html);
  assert.match(
    withdrawn.window.document.querySelector(".report-outcome")!.textContent!,
    /0 findings/,
  );
  assert.equal(
    withdrawn.window.document.querySelectorAll(".finding").length,
    2,
  );
  withdrawn.window.close();
});

test("finding draft API associations link resolved paths and label unresolved paths", () => {
  const data = fixture();
  data.report.finding_drafts = [{ title: "Observation", body: "Body" }];
  data.report.finding_draft_apis = [
    [
      { id: "api-f", display_path: "demo::f" },
      { display_path: "demo::<missing>", unverified: true },
    ],
  ];
  const dom = new JSDOM(renderPreview(data, "/report").html);
  const finding = dom.window.document.querySelector(".finding")!;
  assert.equal(
    finding.querySelector('a[href="https://staging.example/api/api-f"]')
      ?.textContent,
    "demo::f",
  );
  assert.match(finding.textContent!, /demo::<missing> \(API unverified\)/);
  assert.equal(finding.querySelector('a[href*="undefined"]'), null);
  assert.equal(finding.querySelector("missing"), null);
  dom.window.close();
});

test("unrecorded draft renders configuration without inventing evidence", () => {
  const snapshot: import("../preview/render").DraftSnapshot = {
    mode: "draft",
    server: "https://unused.example",
    warnings: [],
    sarif: null,
    report: {
      title: "  Draft report  ",
      crate: "demo",
      version: "1.0.0",
      tool: "aeneas",
      tool_version: "a".repeat(40),
      explanation: "**Overview** <script>unsafe()</script>",
      trusted_assumptions: "Trusted translation",
      limitations: "Explicit limits",
      environment: "Local environment",
      mappings: [
        {
          id: "draft-mapping-0",
          api: "Crc<u8>::checksum",
          module: "Proofs.Crc",
          theorem: "Crc.checksum_spec",
          precondition: "width < 9 && coherent",
        },
      ],
      findings: [
        {
          title: "Finding <draft>",
          body: "**Details** <script>unsafe()</script>",
          api_paths: ["demo::f"],
        },
      ],
    },
  };
  const before = JSON.stringify(snapshot);
  const report = new JSDOM(renderPreview(snapshot, "/report").html).window
    .document;
  assert.equal(report.querySelector("h1")?.textContent, "Draft report");
  assert(report.body.textContent.includes("Unverified draft"));
  assert(report.body.textContent.includes("Configured proof mappings (1)"));
  assert(report.body.textContent.includes("Crc<u8>::checksum"));
  assert(report.body.textContent.includes("Local environment"));
  assert(report.querySelector('a[href="/claim/draft-mapping-0"]'));
  assert(!report.querySelector("script:not([src])"));
  assert(!report.body.textContent.includes("verified claims"));
  assert(!report.body.textContent.includes("Verified APIs"));
  assert(!report.querySelector('a[href*="/runs/"]'));
  assert(!report.querySelector('a[href*="/blob/"]'));
  assert(!report.querySelector('a[href*="/tree/"]'));
  const detail = new JSDOM(
    renderPreview(snapshot, "/claim/draft-mapping-0").html,
  ).window.document;
  assert(detail.body.textContent.includes("Crc.checksum_spec"));
  assert(detail.body.textContent.includes("width < 9 && coherent"));
  assert(detail.body.textContent.includes("Trusted translation"));
  const finding = new JSDOM(renderPreview(snapshot, "/finding/draft-1").html)
    .window.document;
  assert(finding.body.textContent.includes("Finding <draft>"));
  assert(
    finding.querySelector("strong")?.textContent.includes("Local preview"),
  );
  assert(finding.querySelector(".markdown-body strong"));
  assert(!finding.querySelector("script:not([src])"));
  for (const path of [
    "/runs/missing",
    "/api/v1/runs/missing/sarif",
    "/claim/missing",
    "/finding/missing",
    "/missing",
  ]) {
    const page = renderPreview(snapshot, path);
    assert.equal(page.status, 404);
    assert(page.html.includes("Unverified draft"));
  }
  assert.equal(JSON.stringify(snapshot), before);
  snapshot.report.mappings = [];
  const textOnly = renderPreview(snapshot, "/report").html;
  assert(textOnly.includes("This draft displays report text only."));
  assert(!textOnly.includes("verified claims"));
});

test("draft patch display describes configuration without Run observations", () => {
  const snapshot: import("../preview/render").DraftSnapshot = {
    mode: "draft",
    server: "https://unused.example",
    warnings: [],
    sarif: null,
    report: {
      title: "Patch draft",
      crate: "bytes",
      version: "1.12.1",
      tool: "aeneas",
      tool_version: "a".repeat(40),
      mappings: [
        {
          id: "draft-mapping-0",
          api: "f",
          module: "Proofs",
          theorem: "f_spec",
          precondition: "true",
        },
      ],
      toolchain_configuration: {
        components: {
          aeneas: {
            tool: "aeneas",
            source: {
              kind: "git_patch",
              repository: "https://github.com/AeneasVerif/aeneas",
              base_commit: "a".repeat(40),
              patch: {
                path: "toolchain/<patch>.patch",
                sha256: "b".repeat(64),
              },
            },
          },
        },
        patch_path_base: "package",
        lean_dir: "proofs",
        managed_dependency: ".proofs-toolchain/aeneas/backends/lean",
      },
    },
  };
  for (const path of ["/report", "/claim/draft-mapping-0"]) {
    const html = renderPreview(snapshot, path).html;
    const page = new JSDOM(html).window.document;
    assert.match(page.body.textContent!, /Unverified draft/);
    assert.ok(
      page.body.textContent!.includes("Configured patch (package-relative)"),
    );
    assert.ok(page.body.textContent!.includes("b".repeat(64)));
    assert.ok(!page.querySelector("patch"));
    assert.ok(!page.querySelector('a[href*="/runs/"]'));
    assert.ok(
      !html.includes("materialized") && !html.includes("process_executed"),
    );
  }
  const html = renderPreview(snapshot, "/report").html;
  assert.ok(
    html.includes(`Aeneas ${"a".repeat(12)} + patch ${"b".repeat(12)}`),
  );
});
