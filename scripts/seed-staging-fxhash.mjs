// Copy an immutable public report and its recorded SARIF to staging only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const origin = "https://proofs-rs-staging.proofs-rs.workers.dev";
const config = JSON.parse(await readFile("wrangler.staging.json", "utf8"));
const manifest = JSON.parse(
  await readFile("fixtures/production-snapshots/fxhash-0.2.1.json", "utf8"),
);
const sarifPath = "fixtures/production-snapshots/fxhash-0.2.1.sarif.json";
const sarifBytes = await readFile(sarifPath);
const sql = await readFile(
  "fixtures/production-snapshots/fxhash-0.2.1.sql",
  "utf8",
);
const statements = sql.trim().split("\n");
if (
  config.name !== "proofs-rs-staging" ||
  config.vars.ENVIRONMENT !== "staging" ||
  config.d1_databases[0].database_name !== "proofs-rs-staging-reports-v1" ||
  config.r2_buckets[0].bucket_name !== "proofs-rs-staging-reports-v1" ||
  manifest.original_report !== "https://proofs.rs/report/37?v=1" ||
  sarifBytes.length !== manifest.size ||
  createHash("sha256").update(sarifBytes).digest("hex") !== manifest.sha256 ||
  statements.some((line) => !line.startsWith("INSERT OR IGNORE INTO "))
)
  throw Error("Staging snapshot identity check failed");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw Error("Cloudflare credentials missing");
const health = await fetch(`${origin}/api/v1/health`).then((r) => r.json());
if (!health.ok || health.environment !== "staging")
  throw Error("Staging health check failed");
const db = config.d1_databases[0].database_id;
async function query(sql, params = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const result = await response.json();
  if (
    !response.ok ||
    !result.success ||
    result.result.some((item) => !item.success)
  )
    throw Error(`Staging D1 query failed: ${JSON.stringify(result.errors)}`);
  return result.result;
}
const existing = await query(
  "SELECT sha256, size FROM verification_runs WHERE id=?",
  [manifest.run_id],
);
if (existing[0].results.length) {
  const run = existing[0].results[0];
  if (run.sha256 !== manifest.sha256 || run.size !== manifest.size)
    throw Error("Existing staging run differs from the public snapshot");
} else {
  execFileSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${config.r2_buckets[0].bucket_name}/${manifest.r2_key}`,
      "--file",
      sarifPath,
      "--remote",
      "--config",
      "wrangler.staging.json",
      "--content-type",
      "application/sarif+json",
    ],
    { stdio: "inherit" },
  );
}
for (let i = 0; i < statements.length; i += 30)
  await query(statements.slice(i, i + 30).join("\n"));
const rows = await query(
  "SELECT id, author_id FROM reports WHERE create_key=?",
  [manifest.report_key],
);
const report = rows[0].results[0];
if (!report || report.author_id !== manifest.author_id)
  throw Error("Snapshot report identity mismatch");
const counts = await query(
  "SELECT COUNT(*) n FROM claims c JOIN claim_evidence e ON e.claim_id=c.id AND e.report_revision=1 WHERE c.report_id=? AND e.run_id=?",
  [report.id, manifest.run_id],
);
if (counts[0].results[0].n !== manifest.claim_count)
  throw Error("Snapshot evidence count mismatch");
const detail = await fetch(`${origin}/api/v1/reports/${report.id}`).then((r) =>
  r.json(),
);
if (
  detail.claims?.length !== manifest.claim_count ||
  detail.claims.some((c) => c.evidence_ref?.run_id !== manifest.run_id)
)
  throw Error("Public staging report snapshot mismatch");
const page = await fetch(`${origin}/report/${report.id}`);
const html = await page.text();
if (!page.ok || !html.includes("Proposition") || !html.includes("FxHasher"))
  throw Error(`Staging report page failed: ${page.status}`);
console.log(`Staging public report snapshot: ${origin}/report/${report.id}`);
