import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { extractAPIs } from "../src/imports";
import { renderAPICatalog, CatalogAPI } from "../web/api-catalog";
const api = (overrides: Partial<CatalogAPI>): CatalogAPI => ({
  id: "a",
  display_path: "sample::f",
  kind: "function",
  signature: "pub fn f()",
  is_unsafe: 0,
  panic_count: 0,
  no_ub_count: 0,
  ...overrides,
});
test("catalogue groups methods, links single implementations and aggregates family claims", () => {
  const items = [
    api({ id: "f" }),
    api({
      id: "new",
      category: "associated",
      self_type: "sample::Thing",
      method_name: "new",
    }),
    api({
      id: "len",
      category: "method",
      self_type: "sample::Thing",
      method_name: "len",
    }),
    api({
      id: "clone",
      category: "trait",
      trait_path: "core::clone::Clone",
      self_type: "sample::Thing",
      method_name: "clone",
    }),
    ...["u8", "u16"].map((self, i) =>
      api({
        id: "t" + i,
        category: "trait",
        trait_path: "sample::Read",
        self_type: self,
        method_name: "read",
        panic_count: 1,
        no_ub_count: 2,
        is_unsafe: 1,
      }),
    ),
    api({
      id: "blanket",
      category: "trait",
      trait_path: "core::any::Any",
      self_type: "sample::Thing",
      method_name: "type_id",
      is_blanket: 1,
    }),
  ];
  const d = new JSDOM(renderAPICatalog(items, "sample")).window.document;
  assert.deepEqual(
    [...d.querySelectorAll("h3")].map((n) => n.textContent),
    [
      "Functions",
      "Associated functions",
      "Methods",
      "Trait implementations",
      "Blanket implementations",
    ],
  );
  assert.equal(d.querySelector(".catalog-columns")!.textContent, "APIClaims");
  assert.equal(d.querySelector(".api-claim-count")!.textContent, "—");
  assert.equal(d.querySelectorAll("details").length, 1);
  assert.equal(d.querySelectorAll("details[open]").length, 0);
  assert.match(
    d.querySelector("summary")!.textContent!,
    /2 implementations.*Panic contract \(2\) \/ No undefined behavior \(4\)/,
  );
  assert(d.querySelector("summary .unsafe"));
  assert.equal(d.querySelectorAll("details a").length, 2);
  assert.equal(d.querySelector('a[href="/api/clone"]')!.textContent, "clone");
  assert.match(d.body.textContent!, /impl core::clone::Clone for Thing/);
  assert.equal(d.querySelectorAll("aside, button").length, 0);
  assert.equal(
    renderAPICatalog(items, "sample"),
    renderAPICatalog([...items].reverse(), "sample"),
  );
});
test("hex metadata keeps identities and renders 160 FromHex impls plus direct ToHex links", () => {
  const doc = JSON.parse(
    readFileSync(
      new URL("../fixtures/hex-0.4.3-trait-impls.json", import.meta.url),
      "utf8",
    ),
  );
  const metadata = new Map<string, any>();
  const extracted = extractAPIs(doc, "hex", "0.4.3", metadata);
  assert.deepEqual(extracted, extractAPIs(doc, "hex", "0.4.3"));
  const items = extracted.map((a, i) => ({
    ...a,
    ...metadata.get(a.canonical_key),
    id: String(i),
    panic_count: 0,
    no_ub_count: 0,
  }));
  const d = new JSDOM(renderAPICatalog(items, "hex")).window.document;
  assert.equal(d.querySelectorAll("details").length, 1);
  assert.equal(d.querySelectorAll("details a").length, 160);
  assert.match(
    d.querySelector("summary")!.textContent!,
    /from_hex.*160 implementations/,
  );
  assert.equal(d.querySelectorAll("a").length, 162);
});
test("catalogue escapes names and preserves legacy links before metadata refresh", () => {
  const d = new JSDOM(
    renderAPICatalog(
      [
        api({ id: 'bad"', display_path: "sample::<script>alert(1)</script>" }),
        api({
          id: "legacy",
          kind: "method",
          display_path: "<sample::Thing as other::Trait>::m",
        }),
      ],
      "sample",
    ),
  ).window.document;
  assert.equal(d.querySelector("script"), null);
  assert(d.querySelector('a[href="/api/bad%22"]'));
  assert.equal(d.querySelector('a[href="/api/legacy"]')!.textContent, "m");
});

test("rustdoc metadata distinguishes receivers and qualifies external traits without changing keys", () => {
  const fn = (inputs: any[]) => ({
    header: { is_unsafe: false, abi: "Rust" },
    sig: { inputs, output: null },
    generics: {},
  });
  const doc = {
    format_version: 61,
    root: 0,
    index: {
      0: { name: "sample", inner: { module: { items: [1] } } },
      1: {
        name: "Thing",
        visibility: "public",
        inner: { struct: { impls: [2, 5] } },
      },
      2: {
        inner: {
          impl: {
            for: { resolved_path: { path: "Thing", id: 1 } },
            items: [3, 4],
            generics: {},
          },
        },
      },
      3: { name: "new", visibility: "public", inner: { function: fn([]) } },
      4: {
        name: "len",
        visibility: "public",
        inner: {
          function: fn([
            [
              "self",
              {
                borrowed_ref: { type: { generic: "Self" }, is_mutable: false },
              },
            ],
          ]),
        },
      },
      5: {
        inner: {
          impl: {
            for: { resolved_path: { path: "Thing", id: 1 } },
            trait: { path: "Any", id: 99 },
            items: [6],
            generics: {},
            blanket_impl: { generic: "T" },
          },
        },
      },
      6: {
        name: "type_id",
        inner: {
          function: fn([
            [
              "self",
              {
                borrowed_ref: { type: { generic: "Self" }, is_mutable: false },
              },
            ],
          ]),
        },
      },
    },
    paths: { 99: { path: ["core", "any", "Any"] } },
  };
  const metadata = new Map<string, any>();
  const items = extractAPIs(doc, "sample", "1.0.0", metadata);
  assert.deepEqual(items, extractAPIs(doc, "sample", "1.0.0"));
  assert.equal(metadata.get("sample::Thing::new").category, "associated");
  assert.equal(metadata.get("sample::Thing::len").category, "method");
  assert.equal(
    metadata.get("<sample::Thing as Any>::type_id").trait_path,
    "core::any::Any",
  );
  assert.equal(
    metadata.get("<sample::Thing as Any>::type_id").self_type,
    "sample::Thing",
  );
  assert.equal(metadata.get("<sample::Thing as Any>::type_id").is_blanket, 1);
});
