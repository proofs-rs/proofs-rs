import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import SwaggerParser from "@apidevtools/swagger-parser";
import { app } from "../src/worker";
import { publicSpec } from "./api-contract";
import type { Env } from "../src/core";

const env = {
  ENVIRONMENT: "staging",
  DB: {
    prepare() {
      throw new Error("Docs must not use the database");
    },
  },
  ASSETS: {
    fetch() {
      throw new Error("Docs must not use static assets");
    },
  },
} as unknown as Env;

test("generated OpenAPI is valid and describes request media, statuses and parameters", async () => {
  const spec = await publicSpec();
  await SwaggerParser.validate(structuredClone(spec));
  const publish = spec.paths["/api/v1/reports"].post;
  assert.ok(publish.responses[201]);
  assert.ok(
    publish.parameters.some(
      (p: any) =>
        p.in === "header" && p.name === "Idempotency-Key" && p.required,
    ),
  );
  assert.ok(publish.requestBody.required);
  assert.deepEqual(publish.security, [
    { session: [], csrf: [] },
    { bearer: [] },
  ]);
  const revision = spec.paths["/api/v1/reports/{id}/revisions/{n}"].get;
  assert.deepEqual(
    revision.parameters
      .filter((p: any) => p.in === "path")
      .map((p: any) => p.name)
      .sort(),
    ["id", "n"],
  );
  assert.ok(
    spec.paths["/api/v1/crates"].get.parameters.some(
      (p: any) => p.name === "cursor" && p.schema.type === "string",
    ),
  );
  for (const path of ["/auth/device/code", "/auth/device/token"]) {
    const content = spec.paths[path].post.requestBody.content;
    assert.ok(content["application/json"]);
    assert.ok(content["application/x-www-form-urlencoded"]);
  }
  const upload = spec.paths["/api/v1/runs/{run}/sarif"].post;
  assert.ok(upload.requestBody.content["application/sarif+json"]);
  assert.ok(upload.responses[200]);
  assert.ok(upload.responses[201]);
  assert.ok(spec.paths["/api/v1/publish/prepare"].post.responses[202]);
  const ids = new Set();
  for (const methods of Object.values(spec.paths) as any[]) {
    for (const operation of Object.values(methods) as any[]) {
      assert.ok(operation.summary);
      assert.ok(operation.operationId);
      assert.ok(!ids.has(operation.operationId));
      ids.add(operation.operationId);
    }
  }
});

test("runtime docs are public, use Scalar with matching CSP, and redirect legacy links", async () => {
  for (const path of ["/openapi.json", "/api/docs"]) {
    const r = await app.request(
      "https://example.test" + path,
      {
        headers: {
          Authorization: "Bearer invalid",
          Cookie: "__Host-proofsr_session=expired",
        },
      },
      env,
    );
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
    if (path === "/api/docs") {
      assert.match(r.headers.get("content-type")!, /text\/html/);
      const html = await r.text();
      assert.match(html, /Scalar/);
      assert.match(html, /\/openapi.json/);
      assert.doesNotMatch(html, /api-docs\.js|style\.css/);
      const nonce = html.match(/nonce="([^"]+)"/)?.[1];
      assert.ok(nonce);
      const csp = r.headers.get("content-security-policy")!;
      assert.ok(csp.includes(`'nonce-${nonce}'`));
      assert.match(csp, /https:\/\/cdn\.jsdelivr\.net/);
      assert.doesNotMatch(
        csp.split("script-src")[1].split(";")[0],
        /unsafe-inline|unsafe-eval/,
      );
      const second = await app.request(
        "https://example.test/api/docs",
        {},
        env,
      );
      assert.ok(!(await second.text()).includes(`nonce="${nonce}"`));
    } else {
      assert.match(r.headers.get("content-type")!, /application\/json/);
      const spec: any = await r.json();
      assert.equal(spec.openapi, "3.1.0");
      assert.ok(!Object.keys(spec.paths).some((p) => p.includes("/admin")));
    }
  }
  for (const path of [
    "/api/docs/",
    "/docs/api",
    "/docs/api/",
    "/docs/api/index.html",
  ]) {
    const r = await app.request("https://example.test" + path, {}, env);
    assert.equal(r.status, 308);
    assert.equal(r.headers.get("location"), "/api/docs");
  }
  const health = await app.request(
    "https://example.test/api/v1/health",
    {},
    env,
  );
  assert.doesNotMatch(
    health.headers.get("content-security-policy")!,
    /jsdelivr|unsafe-inline/,
  );
  for (const path of [
    "public/openapi.json",
    "public/api-docs.js",
    "public/docs/api/index.html",
    "scripts/openapi.py",
  ]) {
    assert.equal(existsSync(new URL("../" + path, import.meta.url)), false);
  }
});

test("dependency wire schemas distinguish evidence inputs, reviews and snapshots", async () => {
  const spec = await publicSpec();
  const resolve = (value: any): any =>
    value.$ref
      ? resolve(spec.components.schemas[value.$ref.split("/").at(-1)])
      : value;
  const input = resolve(
    spec.paths["/api/v1/reports"].post.requestBody.content["application/json"]
      .schema,
  );
  const reviewInput = resolve(input.properties.dependencies.items);
  assert.deepEqual(Object.keys(reviewInput.properties).sort(), [
    "crate",
    "report",
    "revision",
  ]);
  assert.equal(reviewInput.additionalProperties, false);
  assert.deepEqual(reviewInput.required.sort(), [
    "crate",
    "report",
    "revision",
  ]);
  assert.ok(!input.required.includes("dependencies"));
  const detail = resolve(
    spec.paths["/api/v1/reports/{id}"].get.responses[200].content[
      "application/json"
    ].schema,
  );
  const review = resolve(detail.properties.dependencies.items);
  assert.deepEqual(Object.keys(review.properties).sort(), [
    "crate",
    "report",
    "revision",
    "version",
    "withdrawn",
  ]);
  assert.ok(detail.required.includes("dependencies"));
  const run = resolve(
    spec.paths["/api/v1/runs/{run}"].get.responses[200].content[
      "application/json"
    ].schema,
  );
  assert.deepEqual(
    Object.keys(resolve(run.properties.dependencies.items).properties).sort(),
    ["crate", "source", "version"],
  );
  const sarif = resolve(
    spec.paths["/api/v1/runs/{run}/sarif"].post.requestBody.content[
      "application/sarif+json"
    ].schema,
  );
  const proofs = resolve(
    resolve(sarif.properties.runs.items).properties.properties,
  ).properties.proofs;
  assert.equal(resolve(proofs).properties.schemaVersion.const, 2);
  assert.ok(resolve(proofs).required.includes("dependencies"));
});
