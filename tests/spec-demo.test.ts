import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createViews } from "../src/site-views";
import { uiDemo } from "../src/ui-demo";

test("API contracts, type invariants and predicate definitions use collapsible cards", () => {
  const views = createViews({ user: null }, {}, () => "");
  const dom = new JSDOM(uiDemo(views.reportAPIs));
  const d = dom.window.document;
  const api = d.querySelector('[data-api-path="demo::get"]')!;
  assert.match(
    api.querySelector(".api-doc-heading")!.textContent!,
    /pub fn get<T>/,
  );
  assert.match(
    api.querySelector(".inline-spec")!.textContent!,
    /Requires[\s\S]*valid_index[\s\S]*Ensures/,
  );
  assert(
    api
      .querySelector(".inline-spec")!
      .compareDocumentPosition(api.querySelector(".api-doc-comment")!) &
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.equal(
    api.querySelector('a[href="#demo-source"]')!.textContent,
    "[src]",
  );
  assert.equal(
    api.querySelector('a[href="#demo-check"]')!.textContent,
    "[proof]",
  );
  assert.match(
    d.querySelector("#types .api-doc")!.textContent!,
    /BoundedVec[\s\S]*Invariant[\s\S]*self.items.len\(\) <= self.capacity/,
  );
  const type = d.querySelector("#types .api-doc-wrap")!;
  assert.equal(
    type.querySelector('a[href="#demo-type-source"]')!.className,
    "api-source",
  );
  assert.equal(type.querySelector('a[href="#demo-check"]'), null);
  const source = api.querySelector('a[href="#demo-source"]')!;
  assert.equal(source.parentElement!.className, "api-source");
  assert.equal(
    source.parentElement,
    api.querySelector('a[href="#demo-check"]')!.parentElement,
  );
  assert.equal(source.closest("details"), null);
  assert.equal(d.querySelector("#types h2")!.textContent, "Types (1)");
  assert.equal(
    d.querySelector("#predicates h2")!.textContent,
    "Predicates (2)",
  );
  assert.equal(d.querySelectorAll("#predicates details.api-doc").length, 2);
  assert.match(
    d.querySelector("#predicate-valid-index")!.textContent!,
    /Definition[\s\S]*index < length/,
  );
  assert.equal(
    d.querySelectorAll("[data-predicate-demo], #predicates form").length,
    0,
  );
  assert.equal(
    d.querySelectorAll('.inline-spec a[href^="#predicate-"]').length,
    2,
  );
  dom.window.close();
});

test("public clock-dbm snapshot displays the recorded preconditions without invented contracts", async () => {
  const { clockDbmDemo } = await import("../src/clock-dbm-demo");
  const views = createViews({ user: null }, {}, () => "");
  const d = new JSDOM(views.reportAPIs(clockDbmDemo)).window.document;
  assert.equal(d.querySelectorAll(".inline-spec").length, 70);
  assert.equal(d.querySelectorAll(".contract-clause").length, 70);
  assert.equal(d.querySelectorAll(".api-source a").length, 70);
  assert.match(d.body.textContent!, /Recorded precondition\s*true/);
  assert.doesNotMatch(d.body.textContent!, /Ensures/);
});
