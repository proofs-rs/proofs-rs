import { operation } from "./openapi";
import * as S from "./schemas";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  App,
  Ctx,
  Fault,
  hash,
  random,
  now,
  uid,
  one,
  stmt,
  batch,
  quota,
  requireUser,
  isAdmin,
  jsonBody,
} from "./core";
const expiry = (ms: number) => new Date(Date.now() + ms).toISOString();
const secure = (c: Ctx) => new URL(c.req.url).protocol === "https:";
const cookieName = (c: Ctx) =>
  secure(c) ? "__Host-proofsr_session" : "proofsr_session";
export async function authenticate(c: Ctx) {
  c.set("user", null);
  c.set("csrf", "");
  c.set("sessionHash", "");
  c.set("tokenId", "");
  const authorization = c.req.header("authorization");
  if (authorization !== undefined) {
    if (!/^Bearer [a-f0-9]{64}$/i.test(authorization))
      throw new Fault(401, "invalid_token");
    const row = await one(
      c.env.DB,
      "SELECT u.*,t.id token_id FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?",
      await hash(authorization.slice(7)),
      now(),
    );
    if (!row) throw new Fault(401, "invalid_token");
    c.set("user", row);
    requireUser(c);
    c.set("tokenId", row.token_id);
    await stmt(
      c.env.DB,
      "UPDATE api_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)",
      now(),
      row.token_id,
      new Date(Date.now() - 3600000).toISOString(),
    ).run();
    return;
  }
  const tok = getCookie(c, cookieName(c));
  if (!tok) return;
  const h = await hash(tok);
  const row = await one(
    c.env.DB,
    "SELECT u.*,s.csrf FROM sessions s JOIN users u ON s.user_id=u.id WHERE token_hash=? AND expires_at>?",
    h,
    now(),
  );
  if (row) {
    c.set("user", row);
    c.set("csrf", row.csrf);
    c.set("sessionHash", h);
  }
}
const signupCookie = (c: Ctx) =>
  secure(c) ? "__Host-proofsr_signup" : "proofsr_signup";
const safeReturn = (value: string | undefined) => {
  const v = value?.startsWith("/#/") ? value.slice(2) : value;
  if (
    !v ||
    v.length > 2000 ||
    !v.startsWith("/") ||
    v.startsWith("//") ||
    /[\\\r\n]/.test(v)
  )
    return "/account";
  const url = new URL(v, "https://local");
  return url.origin === "https://local"
    ? url.pathname + url.search
    : "/account";
};
async function finishLogin(
  c: Ctx,
  user: any,
  email: any,
  emailsOK: boolean,
  existing: any,
  consume?: D1PreparedStatement,
) {
  const db = c.env.DB;
  const id = existing?.id || uid();
  const role = isAdmin(c.env, user.id) ? "admin" : "user";
  const ss = consume ? [consume] : [];
  ss.push(
    stmt(
      db,
      "UPDATE users SET username=? WHERE username=? AND github_id<>?",
      `former-${uid()}`,
      user.login,
      user.id,
    ),
  );
  if (existing)
    ss.push(
      stmt(
        db,
        "UPDATE users SET username=?,role=? WHERE id=?",
        user.login,
        role,
        id,
      ),
    );
  else
    ss.push(
      stmt(
        db,
        "INSERT INTO users(id,github_id,username,role,accepted_terms_version,terms_accepted_at,created_at) VALUES(?,?,?,?,?,?,?)",
        id,
        user.id,
        user.login,
        role,
        c.env.TERMS_VERSION,
        now(),
        now(),
      ),
    );
  ss.push(
    stmt(
      db,
      "INSERT INTO notification_preferences(user_id) VALUES(?) ON CONFLICT DO NOTHING",
      id,
    ),
  );
  if (emailsOK)
    ss.push(
      stmt(
        db,
        `INSERT INTO email_contacts VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET address=excluded.address,verified_at=excluded.verified_at,delivery_status=excluded.delivery_status`,
        id,
        email?.email || null,
        email ? now() : null,
        email ? "active" : "unavailable",
      ),
    );
  if (!emailsOK && !existing)
    ss.push(
      stmt(
        db,
        "INSERT INTO email_contacts(user_id,delivery_status) VALUES(?,?)",
        id,
        "unavailable",
      ),
    );
  const session = random(),
    csrf = random();
  ss.push(
    stmt(
      db,
      "INSERT INTO sessions VALUES(?,?,?,?)",
      await hash(session),
      id,
      csrf,
      expiry(30 * 86400000),
    ),
  );
  if (consume)
    ss.push(
      stmt(
        db,
        "DELETE FROM pending_signups WHERE token_hash=?",
        await hash(getCookie(c, signupCookie(c))!),
      ),
    );
  await batch(db, ss);
  setCookie(c, cookieName(c), session, {
    secure: secure(c),
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 86400,
  });
}
export function authRoutes() {
  const app = new Hono<App>();
  app.get(
    "/github",
    ...operation("Start GitHub sign-in", S.string, {
      tags: ["Authentication"],
      query: S.z.object({
        return_to: S.string.optional(),
        switch_account: S.string.optional(),
      }),
      status: 302,
      redirect: true,
      errors: [429, 503],
    }),
    async (c) => {
      if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET)
        throw new Fault(
          503,
          "oauth_not_configured",
          "GitHub sign-in is not configured for this environment yet.",
        );
      const old = getCookie(c, signupCookie(c));
      if (old)
        await stmt(
          c.env.DB,
          "DELETE FROM pending_signups WHERE token_hash=?",
          await hash(old),
        ).run();
      deleteCookie(c, signupCookie(c), { path: "/", secure: secure(c) });
      const returnTo = safeReturn(c.req.query("return_to"));
      if (returnTo)
        setCookie(c, "oauth_return", returnTo, {
          secure: secure(c),
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          maxAge: 600,
        });
      else deleteCookie(c, "oauth_return", { path: "/" });
      const state = random(),
        verifier = random();
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier),
      );
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      await batch(c.env.DB, [
        quota(
          c.env.DB,
          await hash(c.req.header("cf-connecting-ip") || "unknown"),
          "oauth",
          100,
        ),
        stmt(
          c.env.DB,
          "INSERT INTO oauth_flows VALUES(?,?,?,?)",
          await hash(state),
          verifier,
          c.env.TERMS_VERSION,
          expiry(600000),
        ),
      ]);
      setCookie(c, "oauth_state", state, {
        secure: secure(c),
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 600,
      });
      const u = new URL("https://github.com/login/oauth/authorize");
      u.search = new URLSearchParams({
        client_id: c.env.GITHUB_CLIENT_ID,
        redirect_uri: c.env.APP_ORIGIN + "/auth/github/callback",
        scope: "read:user user:email",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      if (c.req.query("switch_account") === "1")
        u.searchParams.set("prompt", "select_account");
      return c.redirect(u.href);
    },
  );
  app.get(
    "/github/callback",
    ...operation("Complete GitHub sign-in", S.string, {
      tags: ["Authentication"],
      query: S.z.object({ state: S.string, code: S.string }),
      status: 302,
      redirect: true,
      errors: [400, 403, 502],
      description: "OAuth callback; requires the matching oauth_state cookie.",
    }),
    async (c) => {
      const state = c.req.query("state"),
        code = c.req.query("code");
      if (!state || state !== getCookie(c, "oauth_state") || !code)
        throw new Fault(400, "oauth_state");
      deleteCookie(c, "oauth_state", { path: "/" });
      const flow = await stmt(
        c.env.DB,
        "DELETE FROM oauth_flows WHERE state_hash=? AND expires_at>? RETURNING *",
        await hash(state),
        now(),
      ).first<any>();
      if (!flow) throw new Fault(400, "oauth_expired");
      const response = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: c.env.GITHUB_CLIENT_ID,
            client_secret: c.env.GITHUB_CLIENT_SECRET,
            code,
            code_verifier: flow.verifier,
            redirect_uri: c.env.APP_ORIGIN + "/auth/github/callback",
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      const token: any = await response.json();
      if (!token.access_token) throw new Fault(502, "oauth_failed");
      const headers = {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "proofs.rs",
      };
      const [ur, er] = await Promise.all([
        fetch("https://api.github.com/user", { headers }),
        fetch("https://api.github.com/user/emails", { headers }),
      ]);
      if (!ur.ok) throw new Fault(502, "github_unavailable");
      const user: any = await ur.json();
      if (!Number.isSafeInteger(user.id) || typeof user.login !== "string")
        throw new Fault(502, "github_response");
      const emails: any = er.ok ? await er.json() : null;
      const email = Array.isArray(emails)
        ? emails.find((x) => x.primary && x.verified)
        : undefined;
      const db = c.env.DB;
      const existing = await one(
        db,
        "SELECT * FROM users WHERE github_id=?",
        user.id,
      );
      if (existing?.status === "suspended")
        throw new Fault(403, "account_suspended");
      const back = safeReturn(getCookie(c, "oauth_return"));
      deleteCookie(c, "oauth_return", { path: "/" });
      if (!existing) {
        const pending = random();
        await stmt(
          db,
          "INSERT INTO pending_signups VALUES(?,?,?,?,?,?)",
          await hash(pending),
          JSON.stringify({
            user: { id: user.id, login: user.login },
            email,
            emailsOK: Array.isArray(emails),
          }),
          random(),
          back,
          now(),
          expiry(600000),
        ).run();
        setCookie(c, signupCookie(c), pending, {
          secure: secure(c),
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          maxAge: 600,
        });
        return c.redirect("/signup");
      }
      await finishLogin(c, user, email, Array.isArray(emails), existing);
      return c.redirect(
        back === "/account" && !er.ok ? "/settings?email=retry" : back,
      );
    },
  );
  async function pendingSignup(c: Ctx) {
    const token = getCookie(c, signupCookie(c));
    const p =
      token &&
      (await one(
        c.env.DB,
        "SELECT * FROM pending_signups WHERE token_hash=? AND expires_at>?",
        await hash(token),
        now(),
      ));
    if (!p)
      throw new Fault(
        401,
        "signup_expired",
        "Sign-up expired. Please sign in again.",
      );
    return p;
  }
  app.get(
    "/signup",
    ...operation(
      "Read pending signup details",
      S.z.object({
        username: S.string,
        csrf: S.string,
        terms_version: S.string,
        return_to: S.string,
      }),
      {
        tags: ["Authentication"],
        errors: [401],
        description: "Requires the pending signup cookie from GitHub sign-in.",
      },
    ),
    async (c) => {
      const p = await pendingSignup(c);
      return c.json({
        username: JSON.parse(p.profile_json).user.login,
        csrf: p.csrf,
        terms_version: c.env.TERMS_VERSION,
        return_to: p.return_to,
      });
    },
  );
  app.post(
    "/signup",
    ...operation(
      "Complete account signup",
      S.z.object({ return_to: S.string }),
      {
        tags: ["Authentication"],
        body: S.z.object({ terms_version: S.string }),
        auth: "signup",
        write: true,
        errors: [401, 403, 409],
      },
    ),
    async (c) => {
      const p = await pendingSignup(c);
      if (c.req.header("X-CSRF-Token") !== p.csrf)
        throw new Fault(403, "invalid_csrf");
      const b = await jsonBody(c);
      if (b.terms_version !== c.env.TERMS_VERSION)
        throw new Fault(
          409,
          "terms_changed",
          "Terms changed. Reload before signing up.",
        );
      const { user, email, emailsOK } = JSON.parse(p.profile_json);
      const existing = await one(
        c.env.DB,
        "SELECT * FROM users WHERE github_id=?",
        user.id,
      );
      if (existing?.status === "suspended")
        throw new Fault(403, "account_suspended");
      // A failed consume aborts the entire batch, including account/session creation.
      const consume = stmt(
        c.env.DB,
        "INSERT INTO transaction_checks(ok) SELECT CASE WHEN EXISTS(SELECT 1 FROM pending_signups WHERE token_hash=? AND expires_at>?) THEN 1 ELSE 0 END",
        p.token_hash,
        now(),
      );
      await finishLogin(c, user, email, emailsOK, existing, consume);
      deleteCookie(c, signupCookie(c), { path: "/", secure: secure(c) });
      return c.json({ return_to: p.return_to });
    },
  );
  app.post(
    "/logout",
    ...operation("End the browser session", S.ok, {
      tags: ["Authentication"],
      auth: "session",
      write: true,
    }),
    async (c) => {
      if (c.get("sessionHash"))
        await stmt(
          c.env.DB,
          "DELETE FROM sessions WHERE token_hash=?",
          c.get("sessionHash"),
        ).run();
      deleteCookie(c, cookieName(c), { path: "/", secure: secure(c) });
      return c.json({ ok: true });
    },
  );
  return app;
}
