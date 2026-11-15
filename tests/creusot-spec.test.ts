import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readRecord } from "../src/runs";
import { createViews } from "../src/site-views";
import { resolveContract } from "../web/formal-evidence";
import { recordedSarif } from "./support/service-fixture";

test("Creusot spec shape and cross-field validation preserve legacy recordings", () => {
  const recording = recordedSarif("11111111-1111-4111-8111-111111111111", [
    "cargo",
    "creusot",
  ]);
  recording.runs[0].tool.driver = { name: "creusot", version: "0.13.0" };
  const contract = recording.runs[0].properties.proofs.contracts[0];
  const spec = {
    kind: "creusot",
    version: 1,
    source: {
      file: contract.file,
      first_line: contract.first_line,
      last_line: contract.last_line,
    },
    signature: "pub fn safe()",
    requires: [] as string[],
    ensures: ["result == ()"],
  };
  const current = structuredClone(recording) as any;
  current.runs[0].properties.proofs.contracts[0].formal = spec;
  assert.deepEqual(readRecord(current).contracts[0].formal, spec);
  assert.equal(readRecord(recording).contracts[0].formal, undefined);
  const invalid = [
    {
      mutate: (r: any) => {
        r.runs[0].properties.proofs.contracts[0].formal.source.file =
          "other.rs";
      },
      error: /invalid_creusot_spec/,
    },
    {
      mutate: (r: any) => {
        r.runs[0].properties.proofs.contracts[0].formal.source.first_line += 1;
      },
      error: /invalid_creusot_spec/,
    },
    {
      mutate: (r: any) => {
        r.runs[0].tool.driver.name = "kani";
      },
      error: /invalid_creusot_spec/,
    },
    {
      mutate: (r: any) => {
        r.runs[0].properties.proofs.contracts[0].precondition = "changed";
      },
      error: /invalid_creusot_spec/,
    },
    {
      mutate: (r: any) => {
        r.runs[0].properties.proofs.contracts[0].formal.signature = " ";
      },
      error: /invalid_creusot_spec/,
    },
    {
      mutate: (r: any) => {
        r.runs[0].properties.proofs.contracts[0].formal.ensures = [" "];
      },
      error: /invalid_creusot_spec/,
    },
    {
      mutate: (r: any) => {
        r.runs[0].properties.proofs.contracts[0].formal.version = 2;
      },
      error: /invalid_sarif/,
    },
    {
      mutate: (r: any) => {
        r.runs[0].properties.proofs.contracts[0].formal.requires = "true";
      },
      error: /invalid_sarif/,
    },
    {
      mutate: (r: any) => {
        r.runs[0].properties.proofs.contracts.push(
          r.runs[0].properties.proofs.contracts[0],
        );
      },
      error: /duplicate_formal_harness/,
    },
    {
      mutate: (r: any) => {
        r.runs[0].results[0].kind = "open";
      },
      error: /unverified_contract/,
    },
  ];
  for (const { mutate, error } of invalid) {
    const copy = structuredClone(current);
    mutate(copy);
    assert.throws(() => readRecord(copy), error);
  }
  const claim = {
    display_path: contract.api_paths[0],
    evidence_ref: {
      run_id: current.runs[0].automationDetails.guid,
      harness: contract.harness,
    },
  };
  assert.equal(
    resolveContract(current, claim.evidence_ref.run_id, claim).formal.signature,
    spec.signature,
  );
  assert.equal(resolveContract(current, "wrong-run", claim), null);
  assert.equal(
    resolveContract(current, claim.evidence_ref.run_id, {
      ...claim,
      display_path: "other::api",
    }),
    null,
  );
});

test("Creusot specification HTML preserves expression text and escapes markup", () => {
  const spec = {
    kind: "creusot",
    signature: "pub fn compare<T>(x: T) -> bool",
    requires: ['x@ < 10 && "<script>" == "<script>"'],
    ensures: ["(^x)@ == (*x)@ + 1"],
    source_url: "https://github.com/test/source/blob/abc/src/lib.rs#L1-L8",
    check_url: "/runs/run#check-f",
  };
  const { claimContent } = createViews(
    { user: null },
    { show_star_karma: false },
    () => "",
  );
  const document = new JSDOM(
    claimContent({
      id: "c",
      title: "Spec",
      precondition: "true",
      formal_evidence: spec,
    }),
  ).window.document;
  const text = document.querySelector(".creusot-spec code")!.textContent!;
  for (const expected of [spec.signature, ...spec.requires, ...spec.ensures])
    assert(text.includes(expected));
  assert.equal(document.querySelector("script"), null);
  assert(document.querySelector(`a[href="${spec.source_url}"]`));
  assert(document.querySelector(`a[href="${spec.check_url}"]`));
});
