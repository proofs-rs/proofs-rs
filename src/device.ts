import { operation } from "./openapi";
import * as S from "./schemas";
import { Hono } from "hono";
import {
  App,
  Ctx,
  Fault,
  hash,
  random,
  uid,
  now,
  one,
  rows,
  stmt,
  batch,
  quota,
  requireUser,
  jsonBody,
  text,
  guard,
} from "./core";
export const deviceRoutes = new Hono<App>();
const expiry = (seconds: number) =>
  new Date(Date.now() + seconds * 1000).toISOString();
export const publicDevicePaths = new Set([
  "/auth/device/code",
  "/auth/device/token",
]);
const codeHash = async (value: unknown) => {
  const code = text(value, "user_code", 20, true)
    .toUpperCase()
    .replaceAll("-", "")
    .replaceAll(" ", "");
  if (!/^[A-Z2-9]{8}$/.test(code)) throw new Fault(400, "invalid_user_code");
  return hash(code);
};
async function limit(c: Ctx, kind: string, n: number) {
  await batch(c.env.DB, [
    quota(
      c.env.DB,
      await hash(c.req.header("cf-connecting-ip") || "unknown"),
      kind,
      n,
    ),
  ]);
}
async function input(c: Ctx) {
  if (
    c.req.header("content-type")?.includes("application/x-www-form-urlencoded")
  )
    return Object.fromEntries(new URLSearchParams(await c.req.text()));
  return jsonBody(c);
}
function client(b: Record<string, any>) {
  if (b.client_id !== "proofs-cli") throw new Fault(400, "invalid_client");
}
deviceRoutes.post(
  "/device/code",
  ...operation(
    "Start device authorization",
    S.z.object({
      device_code: S.string,
      user_code: S.string,
      verification_uri: S.string,
      verification_uri_complete: S.string,
      expires_in: S.integer,
      interval: S.integer,
    }),
    {
      tags: ["Authentication"],
      body: S.deviceCodeInput,
      form: true,
      errors: [400, 429],
    },
  ),
  async (c) => {
    const b = await input(c);
    client(b);
    if (b.scope !== undefined && b.scope !== "publish")
      throw new Fault(400, "invalid_scope");
    await limit(c, "device_start", 30);
    const secret = random(),
      alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = Array.from(
      crypto.getRandomValues(new Uint8Array(8)),
      (v) => alphabet[v % 32],
    ).join("");
    await stmt(
      c.env.DB,
      "INSERT INTO device_authorizations(device_hash,user_code_hash,created_at,expires_at,next_poll_at) VALUES(?,?,?,?,?)",
      await hash(secret),
      await hash(code),
      now(),
      expiry(600),
      now(),
    ).run();
    const user_code = code.slice(0, 4) + "-" + code.slice(4);
    return c.json({
      device_code: secret,
      user_code,
      verification_uri: c.env.APP_ORIGIN + "/device",
      verification_uri_complete:
        c.env.APP_ORIGIN + "/device?code=" + user_code,
      expires_in: 600,
      interval: 5,
    });
  },
);
deviceRoutes.post(
  "/device/token",
  ...operation(
    "Poll for a device access token",
    S.z.object({
      access_token: S.string,
      token_type: S.z.literal("Bearer"),
      scope: S.z.literal("publish"),
      expires_in: S.integer,
      token_id: S.string,
    }),
    {
      tags: ["Authentication"],
      body: S.deviceTokenInput,
      form: true,
      errors: [400, 428, 429],
      description:
        "Poll at the returned interval. authorization_pending and slow_down are 400 responses; increase the interval after slow_down.",
    },
  ),
  async (c) => {
    const b = await input(c);
    client(b);
    if (b.grant_type !== "urn:ietf:params:oauth:grant-type:device_code")
      throw new Fault(400, "unsupported_grant_type");
    const dh = await hash(text(b.device_code, "device_code", 200, true));
    await limit(c, "device_poll", 10000);
    const d = await one(
      c.env.DB,
      "SELECT * FROM device_authorizations WHERE device_hash=?",
      dh,
    );
    if (!d) throw new Fault(400, "invalid_grant");
    if (d.expires_at <= now()) throw new Fault(400, "expired_token");
    if (d.state === "denied") throw new Fault(400, "access_denied");
    if (d.state === "consumed") throw new Fault(400, "invalid_grant");
    if (d.next_poll_at > now()) {
      await stmt(
        c.env.DB,
        "UPDATE device_authorizations SET poll_interval=MIN(poll_interval+5,60),next_poll_at=? WHERE device_hash=?",
        expiry(Math.min(d.poll_interval + 5, 60)),
        dh,
      ).run();
      throw new Fault(400, "slow_down");
    }
    const allowed = await stmt(
      c.env.DB,
      "UPDATE device_authorizations SET next_poll_at=? WHERE device_hash=? AND next_poll_at<=? RETURNING device_hash",
      expiry(d.poll_interval),
      dh,
      now(),
    ).first();
    if (!allowed) throw new Fault(400, "slow_down");
    if (d.state === "pending") throw new Fault(400, "authorization_pending");
    const u = await one(c.env.DB, "SELECT * FROM users WHERE id=?", d.user_id);
    if (!u || u.status !== "active") throw new Fault(400, "access_denied");
    if (u.accepted_terms_version !== c.env.TERMS_VERSION)
      throw new Fault(428, "terms_required");
    const token = random(),
      id = uid(),
      expires = expiry(90 * 86400);
    await batch(c.env.DB, [
      guard(
        c.env.DB,
        "EXISTS(SELECT 1 FROM device_authorizations WHERE device_hash=? AND state='approved' AND expires_at>?)",
        dh,
        now(),
      ),
      guard(
        c.env.DB,
        "EXISTS(SELECT 1 FROM users WHERE id=? AND status='active' AND accepted_terms_version=?)",
        u.id,
        c.env.TERMS_VERSION,
      ),
      stmt(
        c.env.DB,
        "INSERT INTO api_tokens(id,user_id,token_hash,scope,created_at,expires_at) VALUES(?,?,?,?,?,?)",
        id,
        u.id,
        await hash(token),
        "publish",
        now(),
        expires,
      ),
      stmt(
        c.env.DB,
        "UPDATE device_authorizations SET state='consumed',token_id=? WHERE device_hash=?",
        id,
        dh,
      ),
    ]);
    return c.json({
      access_token: token,
      token_type: "Bearer",
      scope: "publish",
      expires_in: 90 * 86400,
      token_id: id,
    });
  },
);
deviceRoutes.post(
  "/device/inspect",
  ...operation(
    "Inspect a device authorization",
    S.z.object({ state: S.string, expires_at: S.string }),
    {
      tags: ["Authentication"],
      body: S.userCodeInput,
      auth: "session",
      write: true,
      errors: [400, 429],
    },
  ),
  async (c) => {
    requireUser(c);
    await limit(c, "device_check", 100);
    const b = await jsonBody(c),
      h = await codeHash(b.user_code);
    const d = await one(
      c.env.DB,
      "SELECT state,expires_at FROM device_authorizations WHERE user_code_hash=?",
      h,
    );
    if (!d || d.expires_at <= now())
      throw new Fault(400, "expired_or_invalid_code");
    return c.json(d);
  },
);
deviceRoutes.post(
  "/device/approve",
  ...operation("Approve a device authorization", S.ok, {
    tags: ["Authentication"],
    body: S.userCodeInput,
    auth: "session",
    write: true,
    errors: [409, 429],
  }),
  async (c) => {
    const u = requireUser(c);
    await limit(c, "device_check", 100);
    const b = await jsonBody(c),
      h = await codeHash(b.user_code);
    const d = await stmt(
      c.env.DB,
      "UPDATE device_authorizations SET state='approved',user_id=? WHERE user_code_hash=? AND state='pending' AND expires_at>? RETURNING device_hash",
      u.id,
      h,
      now(),
    ).first();
    if (!d) throw new Fault(409, "expired_or_used_code");
    return c.json({ ok: true });
  },
);
export const tokenRoutes = new Hono<App>();
tokenRoutes.get(
  "/me/tokens",
  ...operation(
    "List my active API tokens",
    S.z.object({ items: S.z.array(S.token) }),
    { tags: ["Account"], auth: "session" },
  ),
  async (c) =>
    c.json({
      items: await rows(
        c.env.DB,
        "SELECT id,created_at,last_used_at,expires_at FROM api_tokens WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC",
        requireUser(c).id,
        now(),
      ),
    }),
);
tokenRoutes.delete(
  "/me/tokens/:id",
  ...operation("Revoke an API token", S.ok, {
    tags: ["Account"],
    auth: "session",
    write: true,
  }),
  async (c) => {
    const u = requireUser(c);
    await stmt(
      c.env.DB,
      "UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?",
      now(),
      c.req.param("id"),
      u.id,
    ).run();
    return c.json({ ok: true });
  },
);
tokenRoutes.post(
  "/tokens/revoke",
  ...operation("Revoke the current bearer token", S.ok, {
    tags: ["Account"],
    auth: "bearer",
    write: true,
  }),
  async (c) => {
    requireUser(c);
    if (!c.get("tokenId")) throw new Fault(403, "bearer_required");
    await stmt(
      c.env.DB,
      "UPDATE api_tokens SET revoked_at=? WHERE id=?",
      now(),
      c.get("tokenId"),
    ).run();
    return c.json({ ok: true });
  },
);
