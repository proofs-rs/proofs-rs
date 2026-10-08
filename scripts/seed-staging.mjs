import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
const origin = "https://proofs-rs-staging.proofs-rs.workers.dev";
const config = JSON.parse(await readFile("wrangler.json", "utf8"));
const name = "proofs-rs-staging-reports-v1";
if (
  config.name !== "proofs-rs-staging" ||
  config.vars.ENVIRONMENT !== "staging" ||
  config.d1_databases[0].database_name !== name
)
  throw Error("Staging configuration required");
const health = await fetch(`${origin}/api/v1/health`).then((r) => r.json());
if (health.environment !== "staging" || !health.ok)
  throw Error("Staging health check failed");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw Error("Cloudflare credentials missing");
async function api(path, body) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const d = await r.json();
  if (!r.ok || !d.success) throw Error(JSON.stringify(d.errors));
  return d.result;
}
let db;
for (let page = 1; page <= 100; page++) {
  const databases = await api(`/d1/database?page=${page}&per_page=100`);
  db = databases.find((d) => d.name === name);
  if (db || databases.length < 100) break;
}
if (!db)
  throw Error(
    "Existing staging database not found; refusing to create or use another database",
  );
const detail = await api(`/d1/database/${db.uuid}`);
if (detail.name !== name) throw Error("Database identity mismatch");
const sql = await readFile("fixtures/staging-demo.sql", "utf8");
if (
  sql
    .split("\n")
    .some((s) => s.trim() && !s.startsWith("INSERT OR IGNORE INTO "))
)
  throw Error("Seed must be additive");
// Upload only the reserved synthetic fixture objects to the staging bucket.
for (let n = 0; n < 2; n++) {
  const filename = `fixtures/layout-run-${n}.sarif.json`;
  const manifest = JSON.parse(
    await readFile("fixtures/layout-runs.json", "utf8"),
  );
  execFileSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${config.r2_buckets[0].bucket_name}/${manifest[n]}`,
      "--file",
      filename,
      "--remote",
      "--config",
      "wrangler.json",
      "--content-type",
      "application/sarif+json",
    ],
    { stdio: "inherit" },
  );
}
const statements = sql.split("\n").filter(Boolean);
for (let i = 0; i < statements.length; i += 100) {
  const results = await api(`/d1/database/${db.uuid}/query`, {
    sql: statements.slice(i, i + 100).join("\n"),
  });
  if (results.some((r) => !r.success)) throw Error("Seed query failed");
}
const stats = await api(`/d1/database/${db.uuid}/query`, {
  sql: "SELECT COUNT(*) AS demo_claims FROM claims WHERE report_id IN (SELECT id FROM reports WHERE create_key LIKE 'staging-demo-reports-v1-%'); SELECT COUNT(*) AS demo_users FROM users WHERE github_id BETWEEN -91004 AND -91001; PRAGMA foreign_key_check;",
});
if (
  stats[0].results[0].demo_claims !== 16 ||
  stats[1].results[0].demo_users !== 4 ||
  stats[2].results.length
)
  throw Error("Seed verification failed");
console.log(
  "Report layout cases added (report-layout-demo). Staging demo ready: 7 crates, 9 reports, 16 claims, nested comments and independent stars.",
);

async function readPage(path) {
  const response = await fetch(new URL(path, origin));
  if (!response.ok)
    throw Error(`Pagination page failed: ${path} (${response.status})`);
  return response.text();
}
const reportsBefore = await readPage("/reports");
console.log(
  `Existing report pagination: ${reportsBefore.includes('rel="next"')}`,
);
if (!reportsBefore.includes('rel="next"')) {
  const paginationSQL = await readFile(
    "fixtures/staging-pagination.sql",
    "utf8",
  );
  const lines = paginationSQL.split("\n").filter(Boolean);
  if (lines.some((line) => !line.startsWith("INSERT OR IGNORE INTO ")))
    throw Error("Pagination seed must be additive");
  for (let i = 0; i < lines.length; i += 100) {
    const result = await api(`/d1/database/${db.uuid}/query`, {
      sql: lines.slice(i, i + 100).join("\n"),
    });
    if (result.some((r) => !r.success)) throw Error("Pagination seed failed");
  }
  const check = await api(`/d1/database/${db.uuid}/query`, {
    sql: "SELECT COUNT(*) AS n FROM reports WHERE create_key LIKE 'staging-pagination-v1-%'; PRAGMA foreign_key_check;",
  });
  if (check[0].results[0].n !== 36 || check[1].results.length)
    throw Error("Pagination fixture verification failed");
  console.log("Added 36 synthetic pagination reports and claims.");
}
for (const path of [
  "/reports",
  "/crate/pagination-demo?version=1.0.0-demo.1",
]) {
  if (path.includes("pagination-demo") && reportsBefore.includes('rel="next"'))
    continue;
  const first = await readPage(path);
  const next = first.match(/<a rel="next" href="([^"]+)"/);
  if (!next) throw Error(`Pagination missing: ${path}`);
  const nextPath = next[1].replaceAll("&amp;", "&");
  const second = await readPage(nextPath);
  if (!second.includes('class="claim-item"'))
    throw Error(`Empty next page: ${nextPath}`);
  console.log(`Pagination verified: ${origin}${path} -> ${origin}${nextPath}`);
}
