import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createViews } from "../src/site-views";
import { uiDemo } from "../src/ui-demo";

test("spec demo shows inline examples and evaluates only the sample predicates", () => {
  const views = createViews({ user: null }, {}, () => "");
  const dom = new JSDOM(uiDemo(views.reportAPIs), {
    runScripts: "outside-only",
    url: "https://example.test/spec-demo",
  });
  const d = dom.window.document;
  assert.equal(d.querySelectorAll(".api-contract").length, 3);
  assert.equal(
    d.querySelectorAll('.inline-spec a[href^="#predicate-"]').length,
    2,
  );
  assert.equal(d.querySelectorAll('a[href^="/claim/"]').length, 0);
  const row = d.querySelector('[data-api-path="demo::get"]')!;
  assert.match(
    row.querySelector(".api-doc-heading")!.textContent!,
    /pub fn get<T>\(items: &\[T\], index: usize\) -> Option<&T>/,
  );
  assert.match(
    row.querySelector(".api-contract")!.textContent!,
    /Requires[\s\S]*valid_index\(index, items.len\(\)\)[\s\S]*Ensures[\s\S]*result.is_some/,
  );
  assert.match(
    row.querySelector(".contract-evidence")!.textContent!,
    /Synthetic example/,
  );
  assert.equal(d.querySelector(".lean-role"), null);
  assert.equal(d.querySelector(".formal-statement"), null);
  assert.match(d.body.textContent!, /Synthetic data/);
  dom.window.eval(readFileSync("public/site.js", "utf8"));
  const form = d.querySelector<HTMLFormElement>(
    '[data-predicate-demo="valid-index"]',
  )!;
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  assert.equal(form.querySelector("output")!.textContent, "true");
  form.querySelector<HTMLInputElement>('[name="first"]')!.value = "4";
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  assert.equal(form.querySelector("output")!.textContent, "false");
  dom.window.close();
});
