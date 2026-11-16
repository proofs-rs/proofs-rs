import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createViews } from "../src/site-views";

test("finding related links identify destinations in Web and preview views", () => {
  const links = [
    {
      kind: "pr",
      url: "https://github.com/owner/repo/pull/123?diff=split#discussion",
    },
    { kind: "issue", url: "https://github.com/owner/repo/issues/456/" },
    {
      kind: "report",
      url: "https://proofs.rs/report/8?v=2",
      target_report_id: 8,
      target_revision_no: 2,
    },
    { kind: "commit", url: "https://github.com/owner/repo/commit/abcdef" },
    {
      kind: "release",
      url: "https://github.com/owner/repo/releases/tag/v1.2",
      version: "1.2",
    },
    { kind: "pr", url: "https://git.example.test/owner/repo/merge_requests/9" },
    {
      kind: "issue",
      url: "https://github.com.example.test/owner/repo/issues/1",
    },
    {
      kind: "commit",
      url: "https://example.test/" + "long-path/".repeat(50),
      version: "<img src=x onerror=alert(1)>",
    },
  ].map((link, i) => ({ id: `link-${i}`, ...link }));
  const finding = {
    id: "finding-1",
    report_id: 8,
    origin_revision_no: 1,
    title: "Finding",
    body: "Description",
    updated_at: "2026-10-25",
    validity: "reported",
    upstream_status: "not_reported",
    apis: [],
    links,
    edit_version: 3,
  };
  for (const preview of [false, true]) {
    const actions: unknown[] = [];
    const { findingItem } = createViews(
      { user: null },
      {},
      (name, fields) => {
        actions.push({ name, fields });
        return "<button>Remove link</button>";
      },
      { preview },
    );
    const dom = new JSDOM(findingItem(finding, true));
    const d = dom.window.document;
    assert.equal(
      d.querySelector(".finding-related-links h4")?.textContent,
      "Related links",
    );
    const anchors = [...d.querySelectorAll(".finding-links a")];
    assert.deepEqual(
      anchors.slice(0, 7).map((a) => a.textContent),
      [
        "PR · owner/repo#123",
        "Issue · owner/repo#456",
        "Report #8 · v2",
        "Commit · github.com/owner/repo/commit/abcdef",
        "Release · github.com/owner/repo/releases/tag/v1.2 · 1.2",
        "PR · git.example.test/owner/repo/merge_requests/9",
        "Issue · github.com.example.test/owner/repo/issues/1",
      ],
    );
    anchors.forEach((a, i) => {
      assert.equal(a.getAttribute("href"), links[i].url);
      assert.equal(a.getAttribute("target"), "_blank");
      assert.equal(a.getAttribute("rel"), "noopener noreferrer");
    });
    assert.match(
      anchors.at(-1)!.textContent!,
      /<img src=x onerror=alert\(1\)>/,
    );
    assert.equal(d.querySelector("img"), null);
    assert.equal(actions.length, links.length);
    assert.deepEqual(actions[0], {
      name: "delete-finding-link",
      fields: {
        id: "finding-1",
        link_id: "link-0",
        edit_version: 3,
        _back: "/finding/finding-1",
      },
    });
    assert(!findingItem({ ...finding, links: [] }).includes("Related links"));
    assert(!findingItem(finding, false, [], true).includes("Related links"));
    dom.window.close();
  }
});

test("report body removes redundant labels and groups claims by API with revision links", () => {
  const c = {
    title: "Report",
    crate: "sample",
    version: "1.0.0",
    tool: "Verifier",
    tool_version: "1",
    tool_version_id: "v",
    explanation: "Body <script>unsafe</script>",
    trusted_assumptions: "Assume A",
    limitations: "Report limit",
    tool_limitations: "Tool limit",
    environment: "Machine details",
    run_ids: ["run-1"],
    evidence_url: "https://example.test/evidence",
    claims: [1, 2, 3].map((n) => ({
      id: "claim-" + n,
      api_item_id: "api-1",
      display_path: "sample::decode",
      kind: "function",
      signature: "pub fn decode()",
      claim_number: n,
      report_revision: 3,
      title: "Claim " + n,

      star_count: 0,
      precondition: "input is valid",
      explanation: "Claim explanation",
    })),
  };
  const { claimContent, reportContent, reportBody, reportAPIs } = createViews(
    { user: null },
    { show_star_karma: false },
    () => "",
  );
  const dom = new JSDOM(
    "<main>" + reportContent(c) + reportBody(c) + reportAPIs(c) + "</main>",
  );
  const d: any = dom.window.document;
  assert.equal(d.querySelector('a[href^="/crate/"]'), null);
  assert.equal(d.querySelector(".report-explanation"), null);
  assert.equal(d.querySelector("script"), null);
  assert.equal(d.querySelector("dt"), null);
  assert.equal(d.querySelector(".report-environment").tagName, "DETAILS");
  assert.equal(d.querySelector(".report-environment").open, false);
  assert.equal(
    d.querySelector(".report-environment").parentElement.id,
    "reproduce",
  );
  assert.equal(
    d.querySelector("#reproduce").parentElement.className,
    "report-section report-evidence",
  );
  assert.equal(d.querySelector(".api-claim-count"), null);
  assert.equal(d.querySelector(".catalog-columns"), null);
  assert(!d.body.textContent.includes("Preconditions"));
  assert.match(
    d.querySelector(".report-limitations").textContent,
    /Report limit.*Tool limit/s,
  );
  assert.equal(d.querySelector(".report-apis h2").textContent, "APIs (1)");
  assert.equal(d.querySelectorAll('a[href="/api/api-1"]').length, 0);
  assert.equal(d.querySelectorAll(".inline-spec").length, 3);
  assert.equal(
    d.querySelectorAll('.report-api-claims a[href^="/claim/"]').length,
    0,
  );
  assert.match(
    d.querySelector(".api-contract").textContent,
    /Recorded precondition/,
  );
  assert.match(d.querySelector(".api-contract").textContent, /input is valid/);
  assert(
    ![...d.querySelectorAll("h2")].some((n: any) =>
      n.textContent.startsWith("Claims"),
    ),
  );
  assert(!d.body.textContent.includes("Shared"));
  dom.window.close();
});

test("dependencies list all direct crates with reports on the right and API-style empty markers", () => {
  const { reportBody } = createViews(
    { user: null },
    { show_star_karma: false },
    () => "",
  );
  const dom = new JSDOM(
    reportBody({
      direct_dependencies: [
        {
          crate: "dependency<script>",
          requirement: "^1.2",
          kind: "normal",
          optional: false,
          target: null,
          reports: [
            { report: 10, revision: 2, version: "1.2.3", reviewed: true },
          ],
        },
        {
          crate: "withdrawn",
          requirement: "2",
          kind: "build",
          optional: true,
          target: 'cfg(target_os = "linux")',
          reports: [
            {
              report: 11,
              revision: 1,
              version: "2.0.0",
              reviewed: true,
              withdrawn: true,
            },
          ],
        },
        {
          crate: "without-report",
          requirement: "3",
          kind: "dev",
          optional: false,
          target: null,
          reports: [],
        },
      ],
      dependencies: [
        {
          crate: "dependency<script>",
          version: "1.2.3",
          report: 10,
          revision: 2,
        },
        {
          crate: "withdrawn",
          version: "2.0.0",
          report: 11,
          revision: 1,
          withdrawn: true,
        },
        { crate: "transitive", version: "4.0.0", report: 12, revision: 3 },
        { crate: "private", version: "3.0.0", report: null, revision: null },
      ],
    }),
  );
  const d = dom.window.document;
  assert.equal(d.querySelector("h2")!.textContent, "Dependencies (3)");
  const rows = d.querySelectorAll(".catalog-row");
  assert.equal(rows.length, 3);
  assert.equal(
    rows[0].querySelector('a[href^="/report/"]')!.getAttribute("href"),
    "/report/10?v=2",
  );
  assert.match(rows[0].textContent!, /reviewed/);
  assert.equal(rows[2].querySelector(".api-claim-count")!.textContent, "—");
  assert.match(rows[1].textContent!, /build · optional/);
  assert.match(rows[1].textContent!, /cfg\(target_os = "linux"\)/);
  assert.match(rows[1].textContent!, /Withdrawn/);
  assert.equal(d.querySelector("script"), null);
  assert.match(rows[0].textContent!, /dependency<script>/);
  assert.equal(
    d.querySelector(".dependency-reviews summary")!.textContent,
    "Other reviewed evidence (2)",
  );
  assert.equal(
    d.querySelector(".dependency-reviews a")!.getAttribute("href"),
    "/report/12?v=3",
  );
  assert.equal(d.querySelectorAll(".dependency-reviews a").length, 1);
  dom.window.close();
});

test("missing metadata is distinct from a crate with zero dependencies", () => {
  const { reportDependencies } = createViews({ user: null }, {}, () => "");
  const empty = new JSDOM(reportDependencies({ direct_dependencies: [] }));
  assert.equal(
    empty.window.document.querySelector("h2")!.textContent,
    "Dependencies (0)",
  );
  assert.match(
    empty.window.document.body.textContent!,
    /No direct dependencies/,
  );
  const unavailable = new JSDOM(
    reportDependencies({ direct_dependencies: null }),
  );
  assert.equal(
    unavailable.window.document.querySelector("h2")!.textContent,
    "Dependencies",
  );
  assert.match(
    unavailable.window.document.body.textContent!,
    /Unable to load dependencies/,
  );
  empty.window.close();
  unavailable.window.close();
});

test("crate report summaries show the reviewed count without a denominator", () => {
  const { reportSummary } = createViews(
    { user: null },
    { show_star_karma: false },
    () => "",
  );
  const dom = new JSDOM(
    reportSummary(
      { id: 1, title: "Report", claim_count: 2, dependency_count: 3 },
      true,
    ),
  );
  assert.match(
    dom.window.document.body.textContent!,
    /3 reviewed dependencies/,
  );
  assert.doesNotMatch(dom.window.document.body.textContent!, /3\s*\//);
  dom.window.close();
});

test("report summaries fit on one meta line", () => {
  const { reportSummary } = createViews(
    { user: null },
    { show_star_karma: true },
    () => "",
  );
  const card = (report: object) =>
    new JSDOM(
      reportSummary({
        id: 1,
        title: "Report",
        crate: "sample",
        version: "1.0.0",
        tool_id: "aeneas",
        tool: "Aeneas",
        tool_version: "be86ab0f1989d04944292b345b24c435be3ad10a",
        claim_count: 1,
        dependency_count: 0,
        finding_count: 0,
        author_id: "alice",
        username: "alice",
        author_karma: 7,
        star_count: 4,
        comment_count: 5,
        created_at: "2026-09-25T10:00:00.000Z",
        ...report,
      }),
    ).window.document;
  let d = card({});
  assert.equal(d.querySelectorAll(".claim-item > .meta").length, 1);
  assert.equal(
    d.querySelector(".meta")!.textContent,
    "sample 1.0.0 · Aeneas be86ab0 · 1 claim · alice · 2026-09-25",
  );
  assert.equal(
    d.querySelector(".meta span[title]")!.getAttribute("title"),
    "be86ab0f1989d04944292b345b24c435be3ad10a",
  );
  assert.equal(
    d.querySelector('.meta a[href="/reports?tool=aeneas"]')?.textContent,
    "Aeneas",
  );
  const time = d.querySelector(".meta time")!;
  assert.equal(time.getAttribute("datetime"), "2026-09-25T10:00:00.000Z");
  assert.equal(time.getAttribute("title"), "2026-09-25 10:00 UTC");
  assert.equal(d.querySelector(".badge"), null);
  d = card({
    tool: "Kani",
    tool_version: "0.68.0",
    claim_count: 2,
    dependency_count: 1,
    finding_count: 2,
    withdrawn_at: "2026-09-26T00:00:00.000Z",
  });
  assert.equal(
    d.querySelector(".meta")!.textContent,
    "sample 1.0.0 · Kani 0.68.0 · 2 claims · 1 reviewed dependency · 2 findings · alice · 2026-09-25",
  );
  assert.equal(d.querySelector(".badge-warn")!.textContent, "Withdrawn");
});

test("report APIs include finding-only APIs and combine associations without duplicates", () => {
  const views = createViews({ user: null }, {}, () => "");
  const api = {
    id: "shared",
    display_path: "demo::read",
    kind: "function",
    signature: "fn read()",
  };
  const finding = {
    id: "f",
    title: "Signed <read>",
    validity: "confirmed",
    apis: [api, { id: "only", display_path: "demo::checked" }, api],
  };
  const dom = new JSDOM(
    views.reportAPIs({
      crate: "demo",
      claims: [
        {
          ...api,
          id: "c",
          api_item_id: "shared",
          claim_number: 1,
          report_revision: 2,
        },
      ],
      findings: [finding],
    }),
  );
  const d = dom.window.document;
  assert.equal(d.querySelector("h2")?.textContent, "APIs (2)");
  assert.equal(d.querySelectorAll('a[href="/finding/f"]').length, 2);
  assert.equal(d.querySelectorAll('[data-api-path="demo::checked"]').length, 1);
  const shared = d.querySelector('[data-api-path="demo::read"]')!;
  assert.match(shared.textContent!, /No spec.*Finding: Signed <read>/s);
  assert.equal(shared.querySelector("read"), null);
  dom.window.close();
});
