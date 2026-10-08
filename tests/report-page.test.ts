import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createViews } from "../src/site-views";

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
      property: n <= 2 ? "panic_contract" : "no_ub",
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
  assert.equal(
    d.querySelector(".report-explanation").textContent,
    "Body <script>unsafe</script>",
  );
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
  assert.equal(
    d
      .querySelector(".report-explanation")
      .nextElementSibling.querySelector("h2").textContent,
    "Evidence",
  );
  assert.equal(d.querySelector(".api-claim-count"), null);
  assert.equal(d.querySelector(".catalog-columns"), null);
  assert(!d.body.textContent.includes("Preconditions"));
  assert.match(
    d.querySelector(".report-limitations").textContent,
    /Report limit.*Tool limit/s,
  );
  assert.equal(
    d.querySelector(".report-apis h2").textContent,
    "Verified APIs (1)",
  );
  assert.equal(d.querySelectorAll('a[href="/api/api-1"]').length, 1);
  assert.equal(d.querySelectorAll(".report-api-claim").length, 2);
  assert.equal(
    d.querySelectorAll(".catalog-row > .report-api-claims").length,
    1,
  );
  assert.equal(d.querySelector(".report-api-claim a").textContent, "Claim #1");
  assert(!d.querySelector(".report-api-claims").textContent.includes("stars"));
  assert(
    !d.querySelector(".report-api-claims").textContent.includes("Claim 1"),
  );
  assert.equal(d.querySelectorAll('a[href$="?report_revision=3"]').length, 3);
  assert.equal(
    d.querySelector(".report-api-claim").textContent,
    "Panic contractClaim #1, Claim #2",
  );
  assert(
    ![...d.querySelectorAll("h2")].some((n: any) =>
      n.textContent.startsWith("Claims"),
    ),
  );
  assert(!d.body.textContent.includes("Shared"));
  dom.window.close();
});

test("reviewed dependencies keep pinned evidence links, current withdrawal, and author attribution", () => {
  const { reportBody, reportSummary } = createViews(
    { user: null },
    { show_star_karma: false },
    () => "",
  );
  const dom = new JSDOM("<main></main>");
  const w = dom.window as any;
  w.render = (c: any) => {
    w.document.querySelector("main").innerHTML = reportBody(c);
  };
  for (const c of [{}, { dependencies: [] }]) {
    w.render(c);
    assert.equal(
      w.document.querySelector("h2").textContent,
      "Reviewed dependencies (0)",
    );
    assert.match(
      w.document.body.textContent,
      /No reviewed dependencies declared/,
    );
  }
  w.render({
    dependencies: [
      {
        crate: "dependency<script>",
        version: "1.2.3",
        report: 10,
        revision: 2,
        withdrawn: false,
      },
      {
        crate: "withdrawn",
        version: "2.0.0",
        report: 11,
        revision: 1,
        withdrawn: true,
      },
      {
        crate: "private",
        version: "3.0.0",
        report: null,
        revision: null,
        withdrawn: true,
      },
    ],
  });
  assert.equal(
    w.document.querySelector("h2").textContent,
    "Reviewed dependencies (3)",
  );
  assert.equal(w.document.querySelectorAll("li").length, 3);
  assert.equal(
    w.document.querySelector("a").getAttribute("href"),
    "/report/10?v=2",
  );
  assert.equal(w.document.querySelector("script"), null);
  assert.match(w.document.body.textContent, /dependency<script> 1\.2\.3/);
  assert.match(
    w.document.body.textContent,
    /Evidence report currently withdrawn/,
  );
  assert.match(w.document.body.textContent, /Evidence unavailable/);
  assert.match(w.document.body.textContent, /report author declares/);
  assert.match(
    w.document.body.textContent,
    /not independent certification by proofs.rs/,
  );
  dom.window.close();
});

test("crate report summaries show the author-declared reviewed count without a denominator", () => {
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
    /3 reviewed dependencies declared by the author/,
  );
  assert.doesNotMatch(dom.window.document.body.textContent!, /3\s*\//);
  dom.window.close();
});
