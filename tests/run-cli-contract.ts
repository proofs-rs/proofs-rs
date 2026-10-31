/** Run the actual producer with the production ingestion handlers as its peer. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { app } from "../src/worker";
import { hash } from "../src/core";
import { fixture } from "./support/service-fixture";
const { db, env } = await fixture(false);
const token = "f".repeat(64);
db.prepare(
  "INSERT INTO api_tokens VALUES('contract','alice',?,'publish',?,NULL,?,NULL)",
).run(
  await hash(token),
  new Date().toISOString(),
  new Date(Date.now() + 3600000).toISOString(),
);
const objects = new Map<string, Buffer>();
env.ARCHIVE = {
  put: async (key: string, value: ArrayBuffer) =>
    objects.set(key, Buffer.from(value)),
  get: async (key: string) => {
    const value = objects.get(key);
    return value
      ? {
          json: async () => JSON.parse(value.toString()),
          text: async () => value.toString(),
          body: new Response(new Uint8Array(value).buffer).body,
        }
      : null;
  },
  delete: async (key: string) => objects.delete(key),
} as any;
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const driver = JSON.parse(raw.toString()).runs?.[0]?.tool?.driver;
    // Curated synthetic tool versions, without changing any producer bytes.
    if (
      ["kani", "creusot", "aeneas"].includes(driver?.name?.toLowerCase()) &&
      typeof driver.version === "string"
    ) {
      const tool = driver.name.toLowerCase();
      db.prepare(
        "INSERT INTO tools(id,name,description,official_url,active) VALUES(?,?,?,'https://example.test',1) ON CONFLICT DO NOTHING",
      ).run(tool, driver.name, "Synthetic contract verifier");
      db.prepare(
        "INSERT INTO tool_versions(id,tool_id,version,selectable) VALUES(?,?,?,1) ON CONFLICT DO NOTHING",
      ).run(`contract-${tool}-${driver.version}`, tool, driver.version);
    }
    const response = await app.request(
      env.APP_ORIGIN + req.url,
      { method: req.method, headers: req.headers as any, body: raw },
      env,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
env.APP_ORIGIN = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
const output = resolve(
  process.env.PROOFS_CONTRACT_OUTPUT ??
    `cli/target/recording-contract-${Date.now()}`,
);
const binary = resolve(
  process.env.PROOFS_TEST_CLI ?? "cli/target/debug/cargo-proofs",
);
const childEnv = {
  ...process.env,
  PROOFS_CONTRACT_OUTPUT: output,
  PROOFS_CLI_CONTRACT: resolve(output, "manifest.json"),
  PROOFS_CONTRACT_INGESTION_URL: env.APP_ORIGIN,
  PYTHONDONTWRITEBYTECODE: "1",
};
async function run(command: string, args: string[]) {
  const child = spawn(command, args, { env: childEnv, stdio: "inherit" });
  const code = await new Promise<number | null>((done, reject) => {
    child.on("error", reject);
    child.on("exit", done);
  });
  assert.equal(code, 0, `${command} ${args.join(" ")} failed`);
}
try {
  await run("python3", ["cli/tests/e2e.py", binary]);
  await run(process.execPath, [
    "--import",
    "tsx",
    "--test",
    "--test-name-pattern=CLI recording contract",
    "tests/cli-contract.ts",
  ]);
  await run(process.execPath, ["scripts/check-recording-contract-guards.mjs"]);
  console.log(`CLI export/ingestion contract verified: ${output}`);
} finally {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}
