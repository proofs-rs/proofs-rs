import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createViews } from "../src/site-views";

test("claim layout preserves scoped content, escaping, and revision context", () => {
  const c = {
    id: "one",
    claim_number: 1,
    title: "Claim",
    api_item_id: "api",
    display_path: "demo::f",
    property: "panic_contract",
    signature: "unsafe fn f()",
    is_unsafe: 1,
    tool: "Demo",
    tool_version: "1",
    tool_version_id: "tool",
    report_id: 8,
    report_revision: 2,
    precondition: "Valid pointer",
    explanation: "Claim <script>text</script>",
    shared_explanation: "Report context text",
    shared_evidence_url: "https://example.com/report",
    evidence_url: "https://example.com/claim",
    shared_trusted_assumptions: "Report trust",
    trusted_assumptions: "Claim trust",
    shared_limitations: "Report limit",
    limitations: "Claim limit",
    tool_limitations: "Tool limit",
    environment: "Environment text",
  };
  const { claimContent, reportContent, reportBody, reportAPIs } = createViews(
    { user: null },
    { show_star_karma: false },
    () => "",
  );
  const dom = new JSDOM("<main>" + claimContent(c) + "</main>");
  const d: any = dom.window.document;
  for (const value of [
    "Valid pointer",
    "Claim <script>text</script>",
    "Report trust",
    "Claim trust",
    "Report limit",
    "Claim limit",
    "Tool limit",
  ])
    assert.ok(d.body.textContent.includes(value), value);
  assert.equal(d.querySelector("script"), null);
  assert.equal(d.querySelectorAll('a[target="_blank"]').length, 1);
  assert.equal(d.querySelector('a[href="/report/8?v=2"]'), null);
  assert.equal(d.querySelector('a[href="https://example.com/report"]'), null);
  assert(!d.body.textContent.includes("Report context text"));
  assert(!d.body.textContent.includes("Environment text"));
  assert.equal(d.querySelectorAll("h2").length, 4);
  assert.equal(d.querySelector("dl"), null);
  const trust = [...d.querySelectorAll("section")].find(
    (s: any) => s.querySelector("h2")?.textContent === "What is trusted",
  )!;
  assert.equal(trust.children[1].textContent, "Claim trust");
  assert.equal(trust.children[2].tagName, "DETAILS");
  assert.equal(
    trust.children[2].querySelector("summary").textContent,
    "From the report",
  );
  assert.equal(
    d.querySelector(".tool-limitations summary").textContent,
    "Tool limitations",
  );
  assert(!d.body.textContent.includes("For this claim"));
  assert.equal(d.querySelector(".claim-report-context").open, false);
  dom.window.close();
});
