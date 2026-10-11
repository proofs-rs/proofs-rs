// Read-only operational verification. No token values or raw API errors are logged.
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
const target = process.argv[2];
if (!["production", "staging"].includes(target))
  throw Error("Unknown environment");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw Error("Missing environment credentials");
const report = { environment: target };
const api = async (path, optional = false) => {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    if (optional) return null;
    throw Error(`Cloudflare verification failed: HTTP ${response.status}`);
  }
  return body.result;
};
const worker = target === "production" ? "proofs-rs" : "proofs-rs-staging";
const flags = await api(
  `/accounts/${encodeURIComponent(account)}/workers/scripts/${worker}/subdomain`,
);
report.workers_dev = flags.enabled;
report.preview_urls = flags.previews_enabled;
if (
  target === "production" &&
  (flags.enabled !== false || flags.previews_enabled !== false)
)
  throw Error("Production workers.dev or preview URLs are not disabled");
if (target === "staging" && flags.enabled !== true)
  throw Error("Staging workers.dev is not enabled");
const domain = await api(
  `/accounts/${encodeURIComponent(account)}/workers/subdomain`,
);
const alternateOrigin = `https://${worker}.${domain.subdomain}.workers.dev`;
const origin = target === "production" ? "https://proofs.rs" : alternateOrigin;
for (const path of ["/", "/api/v1/health", "/api/v1/config"]) {
  const response = await fetch(origin + path, {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw Error(`Public check ${path}: HTTP ${response.status}`);
  if (path === "/api/v1/config") {
    const config = await response.json();
    if (config.environment !== target) throw Error("Wrong public environment");
    report.oauth_configured = config.oauth_configured;
    report.email_configured = config.email_configured;
  }
}
if (target === "production") {
  const response = await fetch(alternateOrigin + "/api/v1/health", {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  report.alternate_url_status = response.status;
  if (response.ok)
    throw Error("Production alternate hostname still serves requests");
}
// Token IDs are identifiers, not credentials. Compare their fingerprints between
// environments; never print or export a deployment token or a hash of its value.
const userToken = await api("/user/tokens/verify", true);
const accountToken = userToken
  ? null
  : await api(`/accounts/${encodeURIComponent(account)}/tokens/verify`, true);
const identity = userToken || accountToken;
if (identity?.id) {
  report.token_id_fingerprint = createHash("sha256")
    .update(identity.id)
    .digest("hex");
  const tokenPath = userToken
    ? "/user/tokens/"
    : `/accounts/${encodeURIComponent(account)}/tokens/`;
  const details = await api(tokenPath + encodeURIComponent(identity.id), true);
  report.token_policy_readable = Boolean(details?.policies);
  if (details?.policies)
    report.token_policies = details.policies.map((policy) => ({
      effect: policy.effect,
      permissions: (policy.permission_groups || []).map((p) => p.name),
      resource_scope_types: [
        ...new Set(
          Object.keys(policy.resources || {}).map((key) => {
            if (key.includes("account.*")) return "all accounts";
            if (key.includes("zone.*")) return "all zones";
            if (key.includes("account.")) return "selected account";
            if (key.includes("zone.")) return "selected zone";
            return "other resource";
          }),
        ),
      ],
    }));
} else {
  report.token_policy_readable = false;
  report.token_identity_readable = false;
}
console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `\n### ${target} security verification\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
  );
