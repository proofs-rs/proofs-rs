import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderRecordedRun } from "../web/recorded-run";

test("recorded runs render complete HTML, link claims and safely escape output", async () => {
  const dom = new JSDOM('<main id="app"></main>', {
    url: "https://proofs.rs",
    runScripts: "outside-only",
  });
  const w = dom.window;
  const calls: string[] = [];
  const run = {
    command: ["cargo", "kani", "--harness", "check_'f"],
    working_directory: "crate",
    execution_successful: true,
    started_at: "2026-09-23T00:00:00Z",
    finished_at: "2026-09-23T00:00:01Z",
    duration_ms: 1000,
    exit_code: 0,
    environment: { RUSTFLAGS: "--cfg demo" },
    source: {
      repository: "https://github.com/test/source",
      commit: "a".repeat(40),
    },
    contracts: [
      {
        harness: "demo::check_f",
        api_paths: ["demo::f"],
        properties: ["no_ub"],
      },
    ],
  };
  (w as any).fetch = async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      json: async () =>
        url.endsWith("/sarif")
          ? {
              runs: [
                {
                  invocations: [
                    {
                      stdout: { index: 0 },
                      executableLocation: { uri: run.command[0] },
                      arguments: run.command.slice(1),
                      workingDirectory: { uri: run.working_directory + "/" },
                      executionSuccessful: true,
                      exitCode: 0,
                      startTimeUtc: run.started_at,
                      endTimeUtc: run.finished_at,
                      environmentVariables: run.environment,
                    },
                  ],
                  versionControlProvenance: [
                    {
                      repositoryUri: run.source.repository,
                      revisionId: run.source.commit,
                    },
                  ],
                  properties: { proofs: { contracts: run.contracts } },
                  artifacts: [
                    { contents: { text: "<img src=x onerror=bad()>" } },
                  ],
                  results: [
                    {
                      kind: "pass",
                      message: { text: "<script>bad</script>" },
                      properties: { harness: "demo::check_f" },
                    },
                  ],
                },
              ],
            }
          : run,
      text: async () => "<img src=x onerror=bad()>",
    };
  };
  const sarif = await (
    await (w as any).fetch("/api/v1/runs/run-1/sarif")
  ).json();
  const report = {
    id: 42,
    revision_no: 2,
    run_ids: ["run-1"],
    claims: [{ id: 17, display_path: "demo::f", property: "no_ub" }],
  };
  w.document.querySelector("#app")!.innerHTML =
    "<details><summary>Reproduce</summary>" +
    renderRecordedRun(sarif, "run-1", 0, report, true) +
    "</details>";
  const section = w.document.querySelector("details")!;
  assert.equal(section.open, false);
  assert.equal(calls.length, 1);
  assert.equal(w.document.querySelector("button"), null);
  section.open = true;
  section.dispatchEvent(new w.Event("toggle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1);
  assert.equal(w.document.querySelector("script"), null);
  assert.ok(
    w.document
      .querySelector("td")!
      .textContent!.includes("<script>bad</script>"),
  );
  assert.equal(
    w.document.querySelector("td a")!.getAttribute("href"),
    "/claim/17?report_revision=2",
  );
  assert.ok(
    w.document
      .querySelector("pre")!
      .textContent!.includes("cd report-42-source-1/crate"),
  );
  assert.ok(
    w.document
      .querySelector("pre")!
      .textContent!.includes("env 'RUSTFLAGS=--cfg demo' cargo kani"),
  );
  const logs = w.document.querySelector<HTMLDetailsElement>(".run-logs")!;
  logs.open = true;
  logs.dispatchEvent(new w.Event("toggle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.document.querySelector("img"), null);
  assert.equal(
    logs.querySelector("pre")!.textContent,
    "=== stdout ===\n<img src=x onerror=bad()>",
  );
  section.open = false;
  section.open = true;
  section.dispatchEvent(new w.Event("toggle"));
  assert.equal(calls.length, 1);
  w.close();
});
