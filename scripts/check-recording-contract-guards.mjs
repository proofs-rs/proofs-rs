// Prove the mandatory gate fails closed on stale/missing/corrupted exports.
// Negative inputs are mutations of fresh machine-produced bytes, not SARIF mirrors.
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const source = process.env.PROOFS_CLI_CONTRACT;
assert(source, "PROOFS_CLI_CONTRACT is required for gate self-checks");
const root = await mkdtemp(join(tmpdir(), "recording-contract-guards-"));
const command = [
  "--import",
  "tsx",
  "--test",
  "--test-name-pattern=CLI recording contract",
  "tests/cli-contract.ts",
];
try {
  const checks = [
    [
      "missing manifest",
      async (_, env) => {
        delete env.PROOFS_CLI_CONTRACT;
      },
    ],
    [
      "missing required case",
      async (dir) => {
        const p = join(dir, "manifest.json");
        const m = JSON.parse(await readFile(p, "utf8"));
        m.cases = m.cases.filter((c) => c.id !== "aeneas-concrete");
        await writeFile(p, JSON.stringify(m));
      },
    ],
    [
      "stale checkout",
      async (dir) => {
        const p = join(dir, "manifest.json");
        const m = JSON.parse(await readFile(p, "utf8"));
        m.producer.gitRevision = "0".repeat(40);
        await writeFile(p, JSON.stringify(m));
      },
    ],
    [
      "changed export bytes",
      async (dir) => {
        const m = JSON.parse(
          await readFile(join(dir, "manifest.json"), "utf8"),
        );
        const p = join(dir, m.cases[0].file);
        await writeFile(p, (await readFile(p, "utf8")) + "\n");
      },
    ],
    [
      "semantic import mismatch with updated hash",
      async (dir) => {
        const p = join(dir, "manifest.json");
        const m = JSON.parse(await readFile(p, "utf8"));
        const c = m.cases.find((c) => c.id === "aeneas-manifest");
        assert(c);
        const f = join(dir, c.file);
        const data = JSON.parse(await readFile(f, "utf8"));
        data.runs[0].properties.proofs.contracts[0].formal.manifest.entry.rust_name =
          "fixture::not_the_recorded_api";
        const raw = JSON.stringify(data);
        await writeFile(f, raw);
        c.sha256 = createHash("sha256").update(raw).digest("hex");
        await writeFile(p, JSON.stringify(m));
      },
    ],
  ];
  for (const [index, [name, mutate]] of checks.entries()) {
    const dir = join(root, String(index));
    await cp(dirname(source), dir, { recursive: true });
    const env = {
      ...process.env,
      PROOFS_CLI_CONTRACT: join(dir, "manifest.json"),
    };
    await mutate(dir, env);
    const result = spawnSync(process.execPath, command, {
      env,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, `${name}: process error`);
    assert.equal(result.signal, null, `${name}: consumer crashed`);
    assert.notEqual(
      result.status,
      0,
      `${name}: contract gate incorrectly succeeded\n${result.stdout}\n${result.stderr}`,
    );
    if (name.startsWith("semantic"))
      assert.match(
        result.stdout + result.stderr,
        /invalid_formal_evidence/,
        "Gate must reach the production semantic validator",
      );
    console.log(`Contract gate correctly rejects: ${name}`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
