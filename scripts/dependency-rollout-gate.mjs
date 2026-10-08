// Normal deployments only check completion. No historical conversion runs here.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export const MARKER = "dependency_snapshot_v2_rollout";
export async function gate(config, fetcher = fetch, env = process.env) {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN)
    throw Error("Cloudflare credentials unavailable");
  const database = config.d1_databases.find((x) => x.binding === "DB");
  const result = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${database.database_id}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sql: "SELECT value,EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='dependency_rollout_control') maintenance FROM settings WHERE key=?",
        params: [MARKER],
      }),
    },
  );
  if (!result.ok) throw Error("Dependency rollout gate could not read D1");
  const body = await result.json(),
    row = body.result?.[0]?.results?.[0];
  if (!body.success || row?.value !== "complete" || row?.maintenance !== 0)
    throw Error(
      "Dependency snapshot v2 rollout is incomplete. Run the dedicated migration workflow before deployment.",
    );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await gate(JSON.parse(await readFile(process.argv[2], "utf8")));
