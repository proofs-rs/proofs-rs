import { isSitePage, sitePage, siteAction, bookPage } from "./site";
import { generateSpecs } from "hono-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { documentation } from "./openapi";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { App, Env, Fault, uid, requireUser } from "./core";
import { authenticate, authRoutes } from "./auth";
import api from "./api";
import { importRoutes } from "./imports";
import { cleanupRunUploads } from "./runs";
import { queue, dispatch, backup } from "./jobs";
import { admin } from "./admin";
import { deviceRoutes, tokenRoutes, publicDevicePaths } from "./device";
const app = new Hono<App>();
// Only public routes participate in OpenAPI generation.
const publicRoutes = new Hono<App>();
app.use("*", async (c, next) => {
  c.set("requestId", uid());
  await next();
  c.header("X-Request-ID", c.get("requestId"));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    c.req.path === "/api/docs"
      ? `default-src 'self'; script-src 'self' 'nonce-${c.get("requestId")}' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
      : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  if (c.env.ENVIRONMENT !== "production")
    c.header("X-Robots-Tag", "noindex, nofollow");
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/auth/"))
    c.header("Cache-Control", "no-store");
});
app.use("*", async (c, next) =>
  bodyLimit({
    maxSize: /^\/api\/v1\/runs\/[^/]+\/sarif$/.test(c.req.path)
      ? 8 * 1024 * 1024
      : 131072,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  })(c, next),
);
// Documentation is public and independent of cookies, tokens and database access.
app.get("/openapi.json", async (c) =>
  c.json(
    await generateSpecs(
      publicRoutes,
      {
        documentation,
        includeEmptyPaths: false,
      },
      c,
    ),
  ),
);
app.get(
  "/api/docs",
  Scalar<App>((c) => ({
    url: "/openapi.json",
    pageTitle: "proofs.rs API",
    operationTitleSource: "path",
    cdn: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1/dist/browser/standalone.js",
    nonce: c.get("requestId"),
    theme: "default",
    withDefaultFonts: false,
    persistAuth: false,
  })),
);
app.get("/api/docs/", (c) => c.redirect("/api/docs", 308));
for (const path of ["/docs/api", "/docs/api/", "/docs/api/index.html"])
  app.get(path, (c) => c.redirect("/api/docs", 308));
app.get("/index.html", (c) => c.redirect("/", 308));
// HTML routes are separate from the documented JSON API. Internal calls keep all
// API authentication, validation, origin, CSRF and visibility checks in one place.
app.use("*", async (c, next) => {
  const siteFetch = async (request: Request) => {
    let ctx: typeof c.executionCtx | undefined;
    try {
      ctx = c.executionCtx;
    } catch {
      /* app.request tests have no execution context. */
    }
    return app.fetch(request, c.env, ctx);
  };
  if (c.req.method === "POST" && c.req.path.startsWith("/_actions/"))
    return siteAction(c, siteFetch);
  if (["GET", "HEAD"].includes(c.req.method) && c.req.path.startsWith("/book/"))
    return bookPage(c, await c.env.ASSETS.fetch(c.req.raw), siteFetch);
  if (["GET", "HEAD"].includes(c.req.method) && isSitePage(c.req.path))
    return sitePage(c, siteFetch);
  await next();
});
app.use("/api/*", async (c, next) => {
  await authenticate(c);
  await next();
});
app.use("/auth/*", async (c, next) => {
  await authenticate(c);
  await next();
});
app.use("*", async (c, next) => {
  const path = c.req.path,
    bearer = !!c.get("tokenId"),
    write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  if (bearer) {
    const readable =
      c.req.method === "GET" &&
      (path === "/api/v1/me" ||
        path === "/api/v1/me/reports" ||
        /^\/api\/v1\/(runs|crates|apis|claims|reports|tools|resolve-api|imports|health|config|terms)(\/|$)/.test(
          path,
        ));
    const writable =
      c.req.method === "POST" &&
      ([
        "/api/v1/publish/prepare",
        "/api/v1/reports",
        "/api/v1/reports/validate",
        "/api/v1/tokens/revoke",
      ].includes(path) ||
        /^\/api\/v1\/reports\/[^/]+\/revisions$/.test(path) ||
        /^\/api\/v1\/runs\/[^/]+(\/sarif)?$/.test(path));
    // The admin router checks the owner's current ADMIN_GITHUB_IDS membership.
    const administrative =
      path.startsWith("/api/v1/admin/") &&
      ["GET", "POST"].includes(c.req.method);
    if (!readable && !writable && !administrative)
      throw new Fault(403, "insufficient_scope");
  }
  if (write && !publicDevicePaths.has(path)) {
    if (!bearer && c.req.header("origin") !== c.env.APP_ORIGIN)
      throw new Fault(403, "invalid_origin");
    if (
      path !== "/api/v1/notifications/unsubscribe" &&
      path !== "/auth/signup"
    ) {
      requireUser(c);
      if (!bearer && c.req.header("X-CSRF-Token") !== c.get("csrf"))
        throw new Fault(403, "invalid_csrf");
      const exempt =
        [
          "/auth/logout",
          "/api/v1/me/terms-acceptance",
          "/api/v1/me/notification-preferences",
          "/api/v1/tokens/revoke",
        ].includes(path) ||
        (c.req.method === "DELETE" && path.startsWith("/api/v1/me/tokens/"));
      if (
        !exempt &&
        c.get("user")!.accepted_terms_version !== c.env.TERMS_VERSION
      )
        throw new Fault(428, "terms_required");
    }
  }
  await next();
});
app.use("/api/*", async (c, next) => {
  await next();
  if (
    c.env.JOBS &&
    c.req.method === "POST" &&
    c.res.ok &&
    (c.req.path.endsWith("/publish/prepare") ||
      c.req.path.endsWith("/comments"))
  )
    c.executionCtx.waitUntil(dispatch(c.env));
});
publicRoutes.route("/auth", authRoutes());
publicRoutes.route("/auth", deviceRoutes);
publicRoutes.route("/api/v1", tokenRoutes);
publicRoutes.route("/api/v1", api);
publicRoutes.route("/api/v1", importRoutes);
app.route("/", publicRoutes);
app.route("/api/v1/admin", admin);
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((e, c) => {
  if (e instanceof Fault)
    return c.json(
      { error: e.code, message: e.message, request_id: c.get("requestId") },
      e.status as any,
    );
  console.error(
    JSON.stringify({ request_id: c.get("requestId"), error: "internal_error" }),
  );
  return c.json(
    { error: "internal_error", request_id: c.get("requestId") },
    500,
  );
});
export default {
  fetch: app.fetch,
  queue,
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(dispatch(env));
    ctx.waitUntil(
      env.DB.prepare("DELETE FROM device_authorizations WHERE expires_at<?")
        .bind(new Date(Date.now() - 86400000).toISOString())
        .run(),
    );
    if (controller.cron === "17 2 * * *") {
      ctx.waitUntil(backup(env));
      ctx.waitUntil(cleanupRunUploads(env));
    }
  },
};
export { app };
