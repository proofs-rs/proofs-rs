// Temporary one-time rollout Worker. Deploy with exactly the production name,
// routes, bindings and consumers. Existing secrets are retained by Wrangler.
import type { Env } from "../src/core";
const hash = async (data: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export default {
  async fetch(
    request: Request,
    env: Env & { DEPENDENCY_MIGRATION_TOKEN_HASH: string },
  ) {
    const url = new URL(request.url);
    const token =
      request.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
    if (
      !url.pathname.startsWith("/__dependency_migration/") ||
      !token ||
      (await hash(new TextEncoder().encode(token).buffer)) !==
        env.DEPENDENCY_MIGRATION_TOKEN_HASH
    )
      return new Response("Maintenance in progress. Please retry later.", {
        status: 503,
        headers: { "Retry-After": "300", "Cache-Control": "no-store" },
      });
    try {
      if (
        url.pathname === "/__dependency_migration/lock" &&
        request.method === "POST"
      ) {
        // Fence in-flight old invocations too; deploy alone cannot cancel them.
        const tables = await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT GLOB '_*' AND name<>'dependency_rollout_control'",
        ).all<{ name: string }>();
        const statements = [
          env.DB.prepare(
            "CREATE TABLE IF NOT EXISTS dependency_rollout_control(id INTEGER PRIMARY KEY CHECK(id=1))",
          ),
        ];
        for (const table of tables.results) {
          if (!/^[A-Za-z0-9_]+$/.test(table.name))
            throw Error("Unsupported table identifier");
          for (const operation of ["INSERT", "UPDATE", "DELETE"])
            statements.push(
              env.DB.prepare(
                `CREATE TRIGGER IF NOT EXISTS dependency_rollout_${table.name}_${operation} BEFORE ${operation} ON "${table.name}" WHEN NOT EXISTS(SELECT 1 FROM dependency_rollout_control WHERE id=1) BEGIN SELECT RAISE(ABORT,'dependency_rollout_maintenance'); END;`,
              ),
            );
        }
        await env.DB.batch(statements);
        return Response.json({ ok: true });
      }
      if (
        url.pathname === "/__dependency_migration/unlock" &&
        request.method === "POST"
      ) {
        const marker = await env.DB.prepare(
          "SELECT value FROM settings WHERE key='dependency_snapshot_v2_rollout'",
        ).first<{ value: string }>();
        if (marker?.value !== "complete") throw Error("Migration incomplete");
        const triggers = await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'dependency_rollout_%'",
        ).all<{ name: string }>();
        const statements = triggers.results.map((x) => {
          if (!/^[A-Za-z0-9_]+$/.test(x.name))
            throw Error("Unsupported trigger identifier");
          return env.DB.prepare(`DROP TRIGGER "${x.name}"`);
        });
        statements.push(
          env.DB.prepare("DROP TABLE dependency_rollout_control"),
        );
        await env.DB.batch(statements);
        return Response.json({ ok: true });
      }
      if (
        url.pathname === "/__dependency_migration/index" &&
        request.method === "GET"
      ) {
        const result = await env.DB.prepare(
          "SELECT id,r2_key,sha256,size FROM verification_runs ORDER BY id",
        ).all();
        return Response.json(result.results, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (
        url.pathname === "/__dependency_migration/snapshots" &&
        request.method === "GET"
      ) {
        const result = await env.DB.prepare(
          "SELECT run_id,crate,version,source FROM run_dependencies ORDER BY run_id,crate,version,source",
        ).all();
        if (
          (await env.DB.prepare("PRAGMA foreign_key_check").all()).results
            .length
        )
          throw Error("Foreign key check failed");
        return Response.json(result.results, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (
        url.pathname === "/__dependency_migration/archive-page" &&
        request.method === "GET"
      ) {
        const page = await env.ARCHIVE.list({
          cursor: url.searchParams.get("cursor") || undefined,
          limit: 1000,
        });
        return Response.json(
          {
            keys: page.objects
              .map((x) => x.key)
              .filter((key) => !key.startsWith("backups/")),
            cursor: page.truncated ? page.cursor : null,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (
        url.pathname === "/__dependency_migration/copy" &&
        request.method === "POST"
      ) {
        const { source, key } = (await request.json()) as {
          source: string;
          key: string;
        };
        if (
          typeof source !== "string" ||
          typeof key !== "string" ||
          !key.startsWith("backups/dependency-review-migration/") ||
          key.length > 1024
        )
          throw Error("Invalid backup key");
        const object = await env.ARCHIVE.get(source);
        if (!object) throw Error("Missing source object");
        const bytes = await object.arrayBuffer();
        await env.ARCHIVE.put(key, bytes, {
          httpMetadata: object.httpMetadata,
        });
        const copy = await env.ARCHIVE.get(key);
        if (
          !copy ||
          (await hash(await copy.arrayBuffer())) !== (await hash(bytes))
        )
          throw Error("Backup copy verification failed");
        return Response.json({ ok: true });
      }
      if (url.pathname === "/__dependency_migration/object") {
        const key = url.searchParams.get("key");
        if (!key || key.length > 1024)
          return new Response("Invalid key", { status: 400 });
        if (request.method === "GET") {
          const object = await env.ARCHIVE.get(key);
          return object
            ? new Response(object.body, {
                headers: { "Cache-Control": "no-store" },
              })
            : new Response("Not found", { status: 404 });
        }
        if (request.method === "PUT") {
          // Only new migration objects and private backups may be written.
          if (
            !key.startsWith("backups/dependency-review-migration/") &&
            !/\.dependencies-v2\.[a-f0-9]{64}\.sarif\.json$/.test(key)
          )
            return new Response("Invalid migration object", { status: 400 });
          const bytes = await request.arrayBuffer();
          await env.ARCHIVE.put(key, bytes, {
            httpMetadata: {
              contentType: key.endsWith(".sql")
                ? "application/sql"
                : "application/sarif+json",
            },
          });
          const stored = await env.ARCHIVE.get(key);
          if (
            !stored ||
            (await hash(await stored.arrayBuffer())) !== (await hash(bytes))
          )
            throw Error("Archive verification failed");
          return Response.json({
            sha256: await hash(bytes),
            size: bytes.byteLength,
          });
        }
      }
      if (
        url.pathname === "/__dependency_migration/apply" &&
        request.method === "POST"
      ) {
        const body = (await request.json()) as { statements: string[] };
        if (
          !Array.isArray(body.statements) ||
          body.statements.some((x) => typeof x !== "string")
        )
          return new Response("Invalid batch", { status: 400 });
        // D1 batch is atomic: any CHECK/constraint failure rolls back all statements.
        await env.DB.batch([
          env.DB.prepare("INSERT INTO dependency_rollout_control VALUES(1)"),
          ...body.statements.map((sql) => env.DB.prepare(sql)),
          env.DB.prepare("DELETE FROM dependency_rollout_control"),
        ]);
        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    } catch {
      // Never expose private SQL, evidence, archive keys or underlying error bodies.
      return new Response("Migration operation failed", { status: 500 });
    }
  },
  async scheduled() {},
  async queue(batch: MessageBatch) {
    batch.retryAll({ delaySeconds: 3600 });
  },
};
