import { assertResponseContract } from "./api-contract";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { app } from "../src/worker";
import { hash, Env } from "../src/core";
import { extractAPIs, importJob, refreshCatalog } from "../src/imports";
import { cleanupRunUploads } from "../src/runs";
function recordedSarif(id: string, command = ["cargo", "kani"]) {
  return {
    version: "2.1.0",
    runs: [
      {
        automationDetails: { guid: id },
        tool: { driver: { name: "Kani", version: "0.68.0" } },
        versionControlProvenance: [
          {
            repositoryUri: "https://github.com/test/source",
            revisionId: "a".repeat(40),
          },
        ],
        invocations: [
          {
            executableLocation: { uri: command[0] },
            arguments: command.slice(1),
            workingDirectory: { uri: "./" },
            startTimeUtc: "2026-09-23T00:00:00Z",
            endTimeUtc: "2026-09-23T00:00:01Z",
            executionSuccessful: true,
            exitCode: 0,
            stdout: { index: 0 },
            stderr: { index: 1 },
          },
        ],
        artifacts: [
          { contents: { text: "SUCCESS" } },
          { contents: { text: "" } },
        ],
        results: [
          {
            kind: "pass",
            message: { text: "bounds" },
            properties: { harness: "sample::check_safe" },
          },
        ],
        properties: {
          proofs: {
            schemaVersion: 1,
            crate: "sample",
            version: "1.0.0",
            contracts: [
              {
                harness: "sample::check_safe",
                api_paths: ["sample::safe"],
                properties: ["no_ub"],
                precondition: "",
                file: "src/lib.rs",
                first_line: 1,
                last_line: 2,
              },
            ],
          },
        },
      },
    ],
  };
}
function database() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(
      readFileSync(new URL("../migrations/" + f, import.meta.url), "utf8"),
    );
  const prepare = (sql: string) => {
    let values: any[] = [];
    const q = {
      bind(...v: any[]) {
        values = v;
        return q;
      },
      async first() {
        return db.prepare(sql).get(...values) || null;
      },
      async all() {
        return { results: db.prepare(sql).all(...values) };
      },
      async run() {
        const statement = db.prepare(sql);
        if (statement.columns().length)
          return { results: statement.all(...values), meta: {} };
        return { results: [], meta: statement.run(...values) };
      },
    };
    return q;
  };
  return {
    db,
    binding: {
      prepare,
      async batch(statements: any[]) {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const s of statements) results.push(await s.run());
          db.exec("COMMIT");
          return results;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    } as unknown as D1Database,
  };
}
export async function fixture(seedTools = true) {
  const { db, binding } = database();
  if (seedTools)
    db.exec(
      "INSERT INTO tools VALUES('kani','Kani','Test verifier','https://example.test',1); INSERT INTO tool_versions(id,tool_id,version,selectable) VALUES('kani-0.68.0','kani','0.68.0',1);",
    );
  const time = new Date().toISOString();
  for (const [id, n] of [
    ["alice", 1],
    ["bob", 2],
    ["admin", 3],
  ] as const) {
    db.prepare(
      "INSERT INTO users(id,github_id,username,role,accepted_terms_version,terms_accepted_at,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(id, n, id, id === "admin" ? "admin" : "user", "test", time, time);
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
      await hash(id),
      id,
      "csrf",
      new Date(Date.now() + 86400000).toISOString(),
    );
    db.prepare("INSERT INTO notification_preferences(user_id) VALUES(?)").run(
      id,
    );
  }
  db.exec(
    `INSERT INTO crates(id,name) VALUES(1,'sample');INSERT INTO releases VALUES(1,1,'1.0.0','checksum',0,'${time}');INSERT INTO doc_snapshots VALUES(1,'test','{}',61,NULL,'https://docs.rs','hash','key','${time}');INSERT INTO api_items VALUES('safe',1,'sample::safe','sample::safe','function',0,'pub fn safe()','https://docs.rs');INSERT INTO api_items VALUES('unsafe',1,'sample::unsafe','sample::unsafe','function',1,'pub unsafe fn unsafe()','https://docs.rs');`,
  );
  if (seedTools) {
    db.prepare("INSERT INTO verification_runs VALUES(?,?,?,?,?,?,?,?,?)").run(
      "11111111-1111-4111-8111-111111111111",
      "alice",
      "sample",
      "1.0.0",
      "kani-0.68.0",
      "seed-hash",
      100,
      "seed-key",
      time,
    );
  }
  const env = {
    DB: binding,
    ENVIRONMENT: "staging",
    APP_ORIGIN: "https://example.test",
    ADMIN_GITHUB_IDS: "3",
    TERMS_VERSION: "test",
    SHOW_STAR_KARMA: "true",
    SHOW_HOME_DISCUSSION: "true",
    EMAIL_ALLOWLIST: "",
    ARCHIVE: {
      put: async () => {},
      get: async () => ({
        json: async () => recordedSarif("11111111-1111-4111-8111-111111111111"),
        body: new Response(
          JSON.stringify(recordedSarif("11111111-1111-4111-8111-111111111111")),
        ).body,
      }),
    },
    ASSETS: { fetch: async () => new Response("assets") },
  } as unknown as Env;
  async function request(
    path: string,
    method = "GET",
    body?: any,
    user = "alice",
    headers: Record<string, string> = {},
  ) {
    const response = await app.request(
      "https://example.test/api/v1" + path,
      {
        method,
        headers: {
          Origin: env.APP_ORIGIN,
          Cookie: "__Host-proofsr_session=" + user,
          "X-CSRF-Token": "csrf",
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
    const result = {
      status: response.status,
      body: (await response.json()) as any,
    };
    await assertResponseContract(
      "/api/v1" + path,
      method,
      result.status,
      result.body,
    );
    return result;
  }
  return { db, env, request };
}
export const reportInput = {
  run_ids: ["11111111-1111-4111-8111-111111111111"],
  crate: "sample",
  version: "1.0.0",
  title: "A verification report",
  tool_version_id: "kani-0.68.0",
  explanation: "",
  trusted_assumptions: "",
  environment: "test",
  evidence_url: "https://example.test/proof",
  claims: [
    {
      api_item_id: "safe",
      property: "no_ub",
      title: "",
      precondition: "",
      explanation: "",
      trusted_assumptions: "",
      evidence_url: "",
    },
  ],
};

for (const command of [
  ["cargo", "kani"],
  ["python3", "verify-core.py"],
  ["./verify-core"],
]) {
  test(`recorded runs (${command.join(" ")}): immutable artifacts, ownership, publication gating and visibility`, async () => {
    const { db, env, request } = await fixture();
    const objects = new Map<string, Uint8Array>();
    env.ARCHIVE = {
      put: async (k: string, b: ArrayBuffer) => {
        objects.set(k, new Uint8Array(b));
      },
      get: async (k: string) => {
        const b = objects.get(k);
        return b
          ? {
              json: async () => JSON.parse(new TextDecoder().decode(b)),
              body: new Response(new Uint8Array(b)).body,
            }
          : null;
      },
    } as any;
    const rid = "22222222-2222-4222-8222-222222222222";
    const sarif = recordedSarif(rid, command);
    const upload = async (kind: string, bytes: Uint8Array, user = "alice") => {
      const r = await app.request(
        `https://example.test/api/v1/runs/${rid}/${kind}`,
        {
          method: "POST",
          headers: {
            Origin: env.APP_ORIGIN,
            Cookie: "__Host-proofsr_session=" + user,
            "X-CSRF-Token": "csrf",
            "Content-Type": "application/octet-stream",
          },
          body: new Uint8Array(bytes),
        },
        env,
      );
      return { status: r.status, body: (await r.json()) as any };
    };
    const encode = (s: any) => new TextEncoder().encode(JSON.stringify(s));
    for (const mutate of [
      (s: any) => {
        s.runs[0].invocations[0].workingDirectory.uri = "../escape/";
      },
      (s: any) => {
        s.runs[0].properties.proofs.contracts[0].harness = "unexecuted";
      },
      (s: any) => {
        s.runs[0].invocations[0].executionSuccessful = false;
      },
      (s: any) => {
        s.runs[0].invocations[0].executableLocation.uri = "";
      },
      (s: any) => {
        s.runs[0].artifacts.push({ contents: { text: "source" } });
      },
      (s: any) => {
        s.runs[0].versionControlProvenance[0].revisionId = "main";
      },
    ]) {
      const changed = structuredClone(sarif);
      mutate(changed);
      assert.equal((await upload("sarif", encode(changed))).status, 400);
      assert.equal(objects.size, 0, "invalid requests must not store objects");
    }
    const uploaded = await upload("sarif", encode(sarif));
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded));
    assert.equal((await upload("sarif", encode(sarif))).status, 200);
    assert.equal(objects.size, 1);
    assert.equal(
      (await upload("sarif", new TextEncoder().encode("changed"))).status,
      409,
    );
    assert.equal((await upload("sarif", encode(sarif), "bob")).status, 409);
    assert.equal((await request(`/runs/${rid}`, "POST", {})).status, 404);
    for (const removed of [
      "source",
      "logs",
      "artifacts/source",
      "artifacts/logs",
      "artifacts/sarif",
    ]) {
      assert.equal(
        (await upload(removed, new TextEncoder().encode("unused"))).status,
        404,
      );
      assert.equal(
        (await request(`/runs/${rid}/${removed}`, "GET")).status,
        404,
      );
    }
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name='run_sarif'").get(),
      undefined,
    );
    assert.equal(
      (await request("/runs/" + rid, "GET", undefined, "bob")).status,
      404,
    );
    assert.equal(
      (await request("/reports", "POST", { ...reportInput, run_ids: [] }))
        .status,
      400,
    );
    assert.equal(
      (
        await request(
          "/reports",
          "POST",
          { ...reportInput, run_ids: [rid] },
          "bob",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/reports", "POST", {
          ...reportInput,
          run_ids: [rid],
          claims: [{ ...reportInput.claims[0], precondition: "unrecorded" }],
        })
      ).status,
      400,
    );
    const made = await request("/reports", "POST", {
      ...reportInput,
      run_ids: [rid],
    });
    assert.equal(made.status, 201, JSON.stringify(made));
    assert.deepEqual((await request("/reports/" + made.body.id)).body.run_ids, [
      rid,
    ]);
    assert.equal(
      (await request("/runs/" + rid, "GET", undefined, "")).status,
      200,
    );
    const downloaded = await app.request(
      "https://example.test/api/v1/runs/" + rid + "/sarif",
      {},
      env,
    );
    assert.equal(downloaded.status, 200);
    assert.equal(
      ((await downloaded.json()) as any).runs[0].artifacts[0].contents.text,
      "SUCCESS",
    );
    assert.match(downloaded.headers.get("Content-Disposition")!, /attachment/);
    db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(
      made.body.id,
    );
    assert.equal(
      (await request("/runs/" + rid, "GET", undefined, "bob")).status,
      404,
    );
  });
}
test("atomic reports, stable claims, immutable targets, revision conflicts and permanent stars", async () => {
  const { request, db } = await fixture();
  let v = await request("/reports/validate", "POST", reportInput);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(
    v.body.claims[0].title,
    "No undefined behavior for sample::safe (with Kani 0.68.0)",
  );
  const key = { "Idempotency-Key": "report-create-key-123" };
  const made = await request("/reports", "POST", reportInput, "alice", key);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id;
  assert.equal(
    (await request("/reports", "POST", reportInput, "alice", key)).body.id,
    id,
  );
  assert.equal(
    (
      await request(
        "/reports",
        "POST",
        { ...reportInput, title: "changed" },
        "alice",
        key,
      )
    ).status,
    409,
  );
  let r = (await request("/reports/" + id)).body;
  const claimID = r.claims[0].id;
  assert.equal(
    (await request(`/reports/${id}/star`, "PUT", {}, "alice")).status,
    200,
  );
  assert.equal((await request("/users/alice")).body.karma, 0);
  await request(`/reports/${id}/star`, "PUT", {}, "bob");
  await request(`/claims/${claimID}/star`, "PUT", {}, "bob");
  assert.equal((await request("/users/alice")).body.karma, 1);
  const rev = {
    ...reportInput,
    title: "Revised",
    expected_revision: 1,
    claims: [
      { ...reportInput.claims[0], id: claimID, explanation: "New content" },
      { ...reportInput.claims[0], title: "Another scope" },
    ],
  };
  assert.equal(
    (await request(`/reports/${id}/revisions`, "POST", rev, "bob")).status,
    403,
  );
  v = await request(`/reports/${id}/revisions`, "POST", rev);
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal(
    (await request(`/reports/${id}/revisions`, "POST", rev)).status,
    409,
  );
  r = (await request("/reports/" + id)).body;
  assert.equal(r.star_count, 2);
  assert.equal(r.claims[0].id, claimID);
  assert.equal(r.claims[0].star_count, 1);
  assert.equal(
    (await request(`/claims/${claimID}?report_revision=1`)).body.explanation,
    "",
  );
  assert.equal(
    (
      await request(`/reports/${id}/revisions`, "POST", {
        ...rev,
        expected_revision: 2,
        claims: [
          {
            ...rev.claims[0],
            property: "panic_contract",
            precondition: "true",
          },
        ],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/reports/${id}/revisions`, "POST", {
        ...rev,
        expected_revision: 2,
        claims: [r.claims[1]],
      })
    ).status,
    201,
  );
  let removed = (await request("/claims/" + claimID)).body;
  assert.equal(removed.in_current_report, 0);
  assert.equal(removed.star_count, 1);
  assert.equal((await request("/apis/safe/claims")).body.items.length, 1);
  assert.equal(
    (await request("/me/starred-claims", "GET", undefined, "bob")).body.items[0]
      .id,
    claimID,
  );
  assert.equal(
    (await request("/me/starred-reports", "GET", undefined, "bob")).body
      .items[0].id,
    id,
  );
  assert.throws(
    () => db.prepare("UPDATE report_revisions SET title=?").run("bad"),
    /immutable/,
  );
  assert.equal(
    (await request(`/reports/${id}/withdrawal`, "PUT", {})).status,
    200,
  );
  assert.equal((await request("/apis/safe/claims")).body.items.length, 0);
  assert.equal((await request("/users/alice")).body.karma, 0);
});
test("whole-report validation, membership, required evidence, no partial writes and removed endpoints", async () => {
  const { request, db } = await fixture();
  for (const input of [
    { ...reportInput, title: "" },
    { ...reportInput, claims: [] },
    { ...reportInput, evidence_url: "" },
    {
      ...reportInput,
      claims: [
        ...reportInput.claims,
        { api_item_id: "unsafe", property: "no_ub", precondition: "" },
      ],
    },
    { ...reportInput, claims: [{ ...reportInput.claims[0], id: "fake" }] },
  ]) {
    assert.equal((await request("/reports", "POST", input)).status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get()?.n, 0);
  }
  const a = await request("/reports", "POST", reportInput);
  const c = (await request("/reports/" + a.body.id)).body.claims[0];
  const b = await request("/reports", "POST", {
    ...reportInput,
    evidence_url: "",
    claims: [
      {
        ...reportInput.claims[0],
        evidence_url: "https://example.test/individual",
      },
    ],
  });
  assert.equal(b.status, 201);
  assert.equal(
    (
      await request(`/reports/${b.body.id}/revisions`, "POST", {
        ...reportInput,
        expected_revision: 1,
        claims: [c],
      })
    ).status,
    400,
  );
  for (const [method, path] of [
    ["POST", "/claims"],
    ["POST", "/claims/validate"],
    ["POST", "/claims/1/revisions"],
    ["GET", "/claims/1/revisions/1"],
    ["PUT", "/claims/1/withdrawal"],
    ["GET", "/claims/1/comments"],
    ["POST", "/claims/1/comments"],
    ["PUT", "/claims/1/revisions/1/accept"],
    ["GET", "/claims/1/revisions/1/accepts"],
    ["GET", "/me/accepts"],
    ["GET", "/me/claims"],
    ["GET", "/users/alice/claims"],
  ])
    assert.equal(
      (await request(path, method, method === "GET" ? undefined : {})).status,
      404,
      method + " " + path,
    );
});
test("report-only nested comments, history, tombstones, activity and moderation", async () => {
  const { request, db } = await fixture();
  const id = (await request("/reports", "POST", reportInput)).body.id;
  let r = await request(
    `/reports/${id}/comments`,
    "POST",
    { body: "First", revision_no: 1 },
    "bob",
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const root = r.body.id;
  const child = (
    await request(`/reports/${id}/comments`, "POST", {
      body: "Reply",
      revision_no: 1,
      reply_to_id: root,
    })
  ).body.id;
  await request(
    `/reports/${id}/comments`,
    "POST",
    { body: "Third level", revision_no: 1, reply_to_id: child },
    "bob",
  );
  assert.equal((await request("/comments/" + child)).body.ancestors.length, 2);
  await request(
    "/comments/" + root,
    "PATCH",
    { body: "Edited", edit_version: 1 },
    "bob",
  );
  await request("/comments/" + root, "DELETE", { edit_version: 2 }, "bob");
  assert.equal(
    (await request(`/reports/${id}/comments`)).body.items[0].body,
    null,
  );
  assert.equal((await request("/users/bob/comments")).body.items.length, 1);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM report_comment_history WHERE comment_id=?",
      )
      .get(root)?.n,
    3,
  );
  assert.equal((await request("/reports/" + id)).body.comment_count, 2);
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        {
          action: "report_visibility",
          target: String(id),
          value: "hidden",
          reason: "test",
        },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal((await request("/comments/" + child)).status, 404);
  assert.equal((await request("/reports/" + id)).status, 404);
});
test("CSRF, terms and publication scope remain enforced", async () => {
  const { request, db } = await fixture();
  assert.equal(
    (
      await request("/reports", "POST", reportInput, "alice", {
        "X-CSRF-Token": "wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/reports", "POST", reportInput, "alice", {
        Origin: "https://other.test",
      })
    ).status,
    403,
  );
  db.prepare(
    "UPDATE users SET accepted_terms_version='old' WHERE id='alice'",
  ).run();
  assert.equal((await request("/reports", "POST", reportInput)).status, 428);
  assert.equal(
    (await request("/me/terms-acceptance", "POST", { version: "test" })).status,
    200,
  );
  assert.equal((await request("/reports", "POST", reportInput)).status, 201);
});
test("rustdoc fixture: public functions and concrete methods, reexports; unknown formats fail", () => {
  const fn = {
    header: { is_unsafe: false, abi: "Rust" },
    generics: { params: [], where_predicates: [] },
    sig: { inputs: [], output: null },
  };
  const doc: any = {
    format_version: 61,
    root: 0,
    crate_version: "1.0.0",
    index: {
      0: { name: "sample", inner: { module: { items: [1, 2, 3, 6] } } },
      1: { name: "safe", visibility: "public", inner: { function: fn } },
      2: { name: "private", visibility: "default", inner: { function: fn } },
      3: {
        name: "Thing",
        visibility: "public",
        inner: { struct: { impls: [4, 7] } },
      },
      4: {
        inner: {
          impl: {
            for: { resolved_path: { path: "Thing" } },
            items: [5],
            generics: {},
          },
        },
      },
      5: {
        name: "run",
        visibility: "public",
        inner: {
          function: { ...fn, header: { is_unsafe: true, abi: "Rust" } },
        },
      },
      6: {
        name: "renamed",
        visibility: "public",
        inner: { use: { id: 1, name: "renamed", is_glob: false } },
      },
      7: {
        inner: {
          impl: {
            for: { resolved_path: { path: "sample::Thing" } },
            trait: { path: "sample::Debug" },
            generics: {},
            items: [8],
          },
        },
      },
      8: { name: "fmt", visibility: "default", inner: { function: fn } },
    },
  };
  const apis = extractAPIs(doc, "sample", "1.0.0");
  assert.deepEqual(
    apis.map((a) => a.display_path),
    [
      "sample::safe",
      "sample::Thing::run",
      "sample::renamed",
      "<sample::Thing as sample::Debug>::fmt",
    ],
  );
  assert.equal(apis[1].is_unsafe, 1);
  assert.equal(apis[3].kind, "method");
  assert.match(apis[3].signature, /^impl sample::Debug for sample::Thing\n/);
  assert.throws(() =>
    extractAPIs({ ...doc, format_version: 999 }, "sample", "1.0.0"),
  );
});

test("docs.rs hex 0.4.3 format 60 imports codec APIs and associated types", () => {
  const doc = JSON.parse(
    readFileSync(
      new URL("../fixtures/hex-0.4.3-rustdoc-60.json", import.meta.url),
      "utf8",
    ),
  );
  const apis = extractAPIs(doc, "hex", "0.4.3");
  assert.deepEqual(
    apis,
    JSON.parse(
      readFileSync(
        new URL("../fixtures/hex-0.4.3-legacy-apis.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const encode = apis.find((a) => a.canonical_key === "hex::encode_to_slice")!;
  const decode = apis.find((a) => a.canonical_key === "hex::decode_to_slice")!;
  assert.equal(
    encode.signature,
    "pub fn encode_to_slice<T: AsRef<[u8]>>(input: T, output: &mut [u8]) -> Result<(), FromHexError>",
  );
  assert.equal(
    decode.signature,
    "pub fn decode_to_slice<T: AsRef<[u8]>>(data: T, out: &mut [u8]) -> Result<(), FromHexError>",
  );
  assert.equal(encode.is_unsafe, 0);
  assert.equal(decode.is_unsafe, 0);
  assert.equal(
    encode.upstream_url,
    "https://docs.rs/hex/0.4.3/hex/fn.encode_to_slice.html",
  );
  assert.match(
    apis.find((a) => a.canonical_key === "hex::serialize")!.signature,
    /<S as serde_core::ser::Serializer>::Ok/,
  );
  assert.throws(
    () => extractAPIs({ ...doc, paths: {} }, "hex", "0.4.3"),
    /unresolved_rustdoc_path/,
  );
  assert.throws(
    () => extractAPIs({ ...doc, format_version: 999 }, "hex", "0.4.3"),
    /unsupported_rustdoc_format/,
  );
});

test("catalog refresh adds concrete trait methods without changing existing API IDs", async () => {
  const { db, env } = await fixture();
  const fn = {
    header: { is_unsafe: false, abi: "Rust" },
    generics: { params: [], where_predicates: [] },
    sig: { inputs: [], output: null },
  };
  const doc = {
    format_version: 61,
    crate_version: "1.0.0",
    root: 0,
    index: {
      0: { name: "sample", inner: { module: { items: [1, 2] } } },
      1: { name: "safe", visibility: "public", inner: { function: fn } },
      2: {
        name: "Thing",
        visibility: "public",
        inner: { struct: { impls: [3] } },
      },
      3: {
        inner: {
          impl: {
            for: { resolved_path: { path: "sample::Thing" } },
            trait: { path: "sample::Trait" },
            generics: {},
            items: [4],
          },
        },
      },
      4: { name: "method", visibility: "default", inner: { function: fn } },
    },
  };
  (env as any).ARCHIVE.get = async () => ({
    text: async () => JSON.stringify(doc),
  });
  assert.deepEqual(await refreshCatalog(env, 1), { indexed: 2, added: 1 });
  assert.deepEqual(await refreshCatalog(env, 1), { indexed: 2, added: 0 });
  assert.equal(
    db
      .prepare("SELECT id FROM api_items WHERE canonical_key='sample::safe'")
      .get()?.id,
    "safe",
  );
  assert.equal(
    db
      .prepare(
        "SELECT kind FROM api_items WHERE canonical_key='<sample::Thing as sample::Trait>::method'",
      )
      .get()?.kind,
    "method",
  );
});

test("catalog uses public trait and type aliases without exposing private paths", () => {
  const fn = {
    header: { is_unsafe: false, abi: "Rust" },
    generics: { params: [], where_predicates: [] },
    sig: { inputs: [], output: null },
  };
  const doc = {
    format_version: 61,
    crate_version: "1.0.0",
    root: 0,
    index: {
      0: { name: "sample", inner: { module: { items: [1, 2, 3] } } },
      1: {
        name: "hidden",
        visibility: "default",
        inner: { module: { items: [4, 5] } },
      },
      2: {
        name: "Alias",
        visibility: "public",
        inner: { use: { id: 4, name: "Alias", is_glob: false } },
      },
      3: {
        name: "PublicTrait",
        visibility: "public",
        inner: { use: { id: 5, name: "PublicTrait", is_glob: false } },
      },
      4: { name: "S", visibility: "public", inner: { struct: { impls: [6] } } },
      5: { name: "T", visibility: "public", inner: { trait: { items: [7] } } },
      6: {
        inner: {
          impl: {
            for: { resolved_path: { path: "sample::hidden::S" } },
            trait: { path: "sample::hidden::T", id: 5 },
            generics: {},
            items: [8],
          },
        },
      },
      7: { name: "m", visibility: "public", inner: { function: fn } },
      8: { name: "m", visibility: "default", inner: { function: fn } },
    },
  };
  assert.deepEqual(
    extractAPIs(doc, "sample", "1.0.0").map((a) => a.canonical_key),
    ["<sample::Alias as sample::PublicTrait>::m"],
  );
});

test("empty catalogue can be managed through the authenticated admin API", async () => {
  const { request } = await fixture(false);
  const empty = await request("/tools");
  assert.deepEqual(empty.body.items, []);
  assert.deepEqual(empty.body.versions, []);
  const tool = {
    action: "tool",
    target: "test-verifier",
    name: "Test verifier",
    description: "A configurable tool",
    url: "https://example.test/verifier",
    reason: "Register tool",
  };
  assert.equal((await request("/admin/action", "POST", tool)).status, 403);
  assert.equal(
    (await request("/admin/action", "POST", tool, "admin")).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        {
          action: "tool_version",
          target: "test-verifier-1",
          tool_id: tool.target,
          version: "1.0",
          reason: "Register version",
        },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { ...tool, name: "Updated verifier" },
        "admin",
      )
    ).status,
    200,
  );
  const catalogue = await request("/tools");
  assert.equal(catalogue.body.items.length, 1);
  assert.equal(catalogue.body.items[0].name, "Updated verifier");
  assert.equal(catalogue.body.versions[0].version, "1.0");
});

test("device expiry, token expiry, suspension, quotas, and user erasure", async () => {
  const { env, db, request } = await fixture();
  const token = "a".repeat(64),
    h = await hash(token),
    future = new Date(Date.now() + 86400000).toISOString();
  db.prepare(
    "INSERT INTO api_tokens(id,user_id,token_hash,scope,created_at,expires_at) VALUES('token','alice',?,'publish',?,?)",
  ).run(h, new Date().toISOString(), future);
  const headers = { Authorization: "Bearer " + token };
  db.exec("UPDATE api_tokens SET expires_at='2000-01-01'");
  assert.equal(
    (await request("/me", "GET", undefined, "", headers)).status,
    401,
  );
  db.prepare("UPDATE api_tokens SET expires_at=?").run(future);
  await request(
    "/admin/action",
    "POST",
    { action: "suspend", target: "alice", reason: "Test" },
    "admin",
  );
  await request(
    "/admin/action",
    "POST",
    { action: "restore_user", target: "alice", reason: "Test" },
    "admin",
  );
  assert.equal(
    (await request("/me", "GET", undefined, "", headers)).status,
    401,
  );
  const r = await app.request(
    "https://example.test/auth/device/code",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "client_id=proofs-cli",
    },
    env,
  );
  const start = (await r.json()) as any;
  assert.equal(r.status, 200);
  db.exec("UPDATE device_authorizations SET expires_at='2000-01-01'");
  const poll = await app.request(
    "https://example.test/auth/device/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: "proofs-cli",
        device_code: start.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    },
    env,
  );
  assert.equal(((await poll.json()) as any).error, "expired_token");
  db.exec("UPDATE rate_limits SET used=lim WHERE kind='device_start'");
  const limited = await app.request(
    "https://example.test/auth/device/code",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "proofs-cli" }),
    },
    env,
  );
  assert.equal(limited.status, 429);
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { action: "delete_user", target: "alice", reason: "Test" },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM api_tokens").get()!.n, 0);
});

test("OpenAPI covers non-admin routes and excludes administrative schemas", async () => {
  const { env } = await fixture();
  const response = await app.request(
    "https://example.test/openapi.json",
    {},
    env,
  );
  assert.equal(response.status, 200);
  const spec: any = await response.json();
  const actual = new Set(
    app.routes
      .filter(
        (r) =>
          r.method !== "ALL" &&
          !r.path.includes("*") &&
          !r.path.startsWith("/api/v1/admin/") &&
          !r.path.startsWith("/api/docs") &&
          (r.path.startsWith("/api/") || r.path.startsWith("/auth/")),
      )
      .map(
        (r) =>
          r.method.toLowerCase() +
          " " +
          r.path.replace(/:([a-zA-Z]+)/g, "{$1}"),
      ),
  );
  const documented = new Set(
    Object.entries(spec.paths).flatMap(([p, methods]) =>
      Object.keys(methods as any).map((m) => m + " " + p),
    ),
  );
  assert.deepEqual(documented, actual);
  assert.doesNotMatch(
    JSON.stringify(spec),
    /Administration|\/admin\/|comment_history|audit_events/,
  );
  function walk(v: any) {
    if (!v || typeof v !== "object") return;
    if (v.$ref) {
      assert.ok(v.$ref.startsWith("#/components/"));
      assert.ok(spec.components[v.$ref.split("/")[2]][v.$ref.split("/").pop()]);
    }
    Object.values(v).forEach(walk);
  }
  walk(spec);
});

test("device login, one-time exchange, scope isolation, ownership and revocation", async () => {
  const { env, db, request } = await fixture();
  async function auth(
    path: string,
    body: any,
    browser = false,
    headers: Record<string, string> = {},
  ) {
    const r = await app.request(
      "https://example.test/auth/device/" + path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(browser
            ? {
                Origin: env.APP_ORIGIN,
                Cookie: "__Host-proofsr_session=alice",
                "X-CSRF-Token": "csrf",
              }
            : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      },
      env,
    );
    return { status: r.status, body: (await r.json()) as any };
  }
  const start = await auth("code", { client_id: "proofs-cli" });
  assert.equal(start.status, 200);
  const poll = {
    client_id: "proofs-cli",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: start.body.device_code,
  };
  assert.equal((await auth("token", poll)).body.error, "authorization_pending");
  assert.equal((await auth("token", poll)).body.error, "slow_down");
  assert.equal(
    (await auth("approve", { user_code: start.body.user_code })).status,
    403,
  );
  assert.equal(
    (
      await auth("approve", { user_code: start.body.user_code }, true, {
        "X-CSRF-Token": "wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (await auth("inspect", { user_code: start.body.user_code }, true)).body
      .state,
    "pending",
  );
  assert.equal(
    (await auth("approve", { user_code: start.body.user_code }, true)).status,
    200,
  );
  assert.equal(
    (await auth("approve", { user_code: start.body.user_code }, true)).status,
    409,
  );
  db.exec("UPDATE device_authorizations SET next_poll_at='2000-01-01'");
  const issued = await auth("token", poll);
  assert.equal(issued.status, 200);
  assert.ok(issued.body.access_token);
  assert.equal((await auth("token", poll)).body.error, "invalid_grant");
  const stored = db.prepare("SELECT * FROM api_tokens").get() as any;
  assert.equal(stored.token_hash, await hash(issued.body.access_token));
  assert.equal(stored.name, undefined);
  const headers = {
    Authorization: "Bearer " + issued.body.access_token,
    Origin: "",
    "X-CSRF-Token": "",
    Cookie: "",
  };
  assert.equal(
    (await request("/reports", "POST", reportInput, "", headers)).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/reports/1/revisions",
        "POST",
        { ...reportInput, expected_revision: 1, title: "Updated" },
        "",
        headers,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/publish/prepare",
        "POST",
        { crate: "sample", version: "1.0.0" },
        "",
        headers,
      )
    ).body.status,
    "ready",
  );
  assert.equal(
    (await request("/admin/audit", "GET", undefined, "", headers)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/reports/1/comments",
        "POST",
        { body: "hello", revision_no: 1 },
        "",
        headers,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/me/tokens", "GET", undefined, "", headers)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/me/terms-acceptance",
        "POST",
        { version: "test" },
        "",
        headers,
      )
    ).status,
    403,
  );
  const listed = (await request("/me/tokens")).body.items;
  assert.equal(listed[0].id, issued.body.token_id);
  assert.ok(!("token_hash" in listed[0]));
  await request(
    "/me/tokens/" + issued.body.token_id,
    "DELETE",
    undefined,
    "bob",
  );
  assert.equal(
    (await request("/me", "GET", undefined, "", headers)).status,
    200,
  );
  db.exec("UPDATE users SET accepted_terms_version='old' WHERE id='alice'");
  assert.equal(
    (await request("/reports", "POST", reportInput, "", headers)).status,
    428,
  );
  assert.equal(
    (await request("/tokens/revoke", "POST", {}, "", headers)).status,
    200,
  );
  assert.equal(
    (await request("/me", "GET", undefined, "", headers)).status,
    401,
  );
  // Invalid Bearer must not fall back to the valid browser session.
  assert.equal(
    (
      await request("/me", "GET", undefined, "alice", {
        Authorization: "Bearer bad",
      })
    ).status,
    401,
  );
});

test("moderation redacts shared and individual revision text and user erasure removes stars", async () => {
  const { request, db } = await fixture();
  const made = await request("/reports", "POST", reportInput);
  const id = made.body.id;
  const claimID = (await request("/reports/" + id)).body.claims[0].id;
  await request(`/reports/${id}/star`, "PUT", {}, "bob");
  await request(`/claims/${claimID}/star`, "PUT", {}, "bob");
  const redacted = await request(
    "/admin/action",
    "POST",
    {
      action: "redact_revision",
      target: id,
      revision_no: 1,
      reason: "Remove private text",
    },
    "admin",
  );
  assert.equal(redacted.status, 200, JSON.stringify(redacted.body));
  const r = (await request("/reports/" + id)).body;
  assert.equal(r.title, "[Redacted]");
  assert.equal(r.claims[0].title, "[Redacted]");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM maintenance").get()!.n, 0);
  assert.throws(
    () => db.exec("UPDATE report_revisions SET title='illegal'"),
    /immutable_revision/,
  );
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { action: "delete_user", target: "bob", reason: "User request" },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal((await request("/reports/" + id)).body.star_count, 0);
  assert.equal((await request("/claims/" + claimID)).body.star_count, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("staging fixture is repeatable and exposes report catalogue without imported snapshots", async () => {
  const { request, db } = await fixture();
  const sql = readFileSync(
    new URL("../fixtures/staging-demo.sql", import.meta.url),
    "utf8",
  );
  db.exec(sql);
  db.exec(sql);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get()!.n, 13);
  const layout = db
    .prepare("SELECT id FROM reports WHERE create_key='staging-layout-v1-full'")
    .get()!;
  const layoutReport = (await request("/reports/" + layout.id)).body;
  assert.equal(layoutReport.revision_no, 55);
  assert.equal(layoutReport.claims.length, 15);
  assert.equal(layoutReport.run_ids.length, 2);
  assert.equal(layoutReport.comment_count, 55);
  assert.deepEqual(
    [...new Set(layoutReport.claims.map((c: any) => c.category))].sort(),
    ["associated", "function", "method", "trait"],
  );
  const envOnly = db
    .prepare(
      "SELECT id FROM reports WHERE create_key='staging-layout-v1-environment-only'",
    )
    .get()!;
  const envReport = (await request("/reports/" + envOnly.id)).body;
  assert.equal(envReport.run_ids.length, 0);
  assert.ok(envReport.environment);

  const home = await request("/home");
  assert.equal(home.status, 200, JSON.stringify(home.body));
  assert.equal(home.body.reports.length, 11);
  assert.equal("crates" in home.body, false);
  const allCrates = await request("/crates");
  assert.equal(allCrates.status, 200, JSON.stringify(allCrates.body));
  assert.equal(allCrates.body.total_count, 8);
  assert.equal(allCrates.body.matching_count, 8);
  const found = await request("/crates?q=array");
  assert.equal(found.body.total_count, 8);
  assert.equal(found.body.matching_count, 1);
  assert.equal(found.body.items[0].api_count, 6);
  assert.equal(found.body.items[0].report_count, 2);
  assert.equal(found.body.items[0].claim_count, 7);
  assert.equal((await request("/crates?q=%25")).body.matching_count, 0);

  const list = await request("/crates/arrayvec/0.7.6-demo.1/apis");
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.items.length, 6);
  const first = home.body.reports.find(
    (x: any) => x.crate === "arrayvec" && x.tool === "Kani (demo)",
  );
  const detail = await request("/reports/" + first.id);
  assert.equal(detail.body.claims.length, 5);
  const reports = await request("/crates/arrayvec/0.7.6-demo.1/reports");
  assert.equal(reports.status, 200, JSON.stringify(reports.body));
  assert.equal(reports.body.items.length, 2);
  assert.ok(
    reports.body.items.every(
      (r: any) => r.crate === "arrayvec" && r.version === "0.7.6-demo.1",
    ),
  );
  assert.equal(
    (await request("/crates/arrayvec/0.7.5/reports")).body.items.length,
    0,
  );

  const traitReport = home.body.reports.find(
    (r: any) => r.crate === "trait-demo",
  );
  const traitDetail = await request("/reports/" + traitReport.id);
  assert.equal(traitDetail.body.claims.length, 3);
  const traitAPIs = await request("/crates/trait-demo/0.1.0-demo.1/apis");
  assert.deepEqual(
    traitAPIs.body.items.map((a: any) => a.display_path).sort(),
    [
      "<trait_demo::Buffer as trait_demo::Inspect>::read",
      "<trait_demo::Buffer as trait_demo::Read>::read",
      "trait_demo::Buffer::read",
    ],
  );
  assert.ok(traitAPIs.body.items.every((a: any) => a.kind === "method"));

  const comments = await request("/reports/" + first.id + "/comments");
  assert.equal(comments.status, 200);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("import stores normalized crate description using the existing metadata request", async (t) => {
  const { db, env } = await fixture();
  db.exec(
    "DELETE FROM doc_snapshots; INSERT INTO import_jobs(id,release_id,status,created_at) VALUES('description-import',1,'pending','2026-09-21T00:00:00.000Z')",
  );
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("https://crates.io/"))
      return Response.json({
        version: {
          num: "1.0.0",
          checksum: "checksum",
          yanked: false,
          description: "A crate.\n  Short description.",
        },
      });
    if (url.startsWith("https://docs.rs/"))
      return Response.json({
        format_version: 61,
        root: 0,
        crate_version: "1.0.0",
        index: {
          0: { name: "sample", inner: { module: { items: [1] } } },
          1: {
            name: "safe",
            visibility: "public",
            inner: {
              function: {
                header: { is_unsafe: false, abi: "Rust" },
                generics: { params: [], where_predicates: [] },
                sig: { inputs: [], output: null },
              },
            },
          },
        },
      });
    throw Error("Unexpected request: " + url);
  });
  assert.equal(await importJob(env, "description-import"), true);
  assert.equal(
    db
      .prepare(
        "SELECT status,error_code FROM import_jobs WHERE id='description-import'",
      )
      .get()!.status,
    "ready",
  );
  assert.equal(
    db.prepare("SELECT description FROM crates WHERE name='sample'").get()!
      .description,
    "A crate. Short description.",
  );
  assert.equal(urls.length, 2);
});

test("public stargazers paginate without duplicates and respect target visibility", async () => {
  const { request, db } = await fixture();
  const id = (await request("/reports", "POST", reportInput)).body.id;
  const claim = (await request(`/reports/${id}`)).body.claims[0].id;
  for (let n = 0; n < 35; n++) {
    const uid = `star-user-${String(n).padStart(2, "0")}`;
    db.prepare(
      "INSERT INTO users(id,github_id,username,created_at,accepted_terms_version,terms_accepted_at) VALUES(?,?,?,?,'test','2026-01-01')",
    ).run(uid, 100 + n, uid, "2026-01-01");
    db.prepare("INSERT INTO report_stars VALUES(?,?,?)").run(
      id,
      uid,
      "2026-01-01",
    );
    db.prepare("INSERT INTO claim_stars VALUES(?,?,?)").run(
      claim,
      uid,
      "2026-01-01",
    );
  }
  for (const path of [`/reports/${id}/stars`, `/claims/${claim}/stars`]) {
    const first = await request(path, "GET", undefined, "");
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 30);
    assert.deepEqual(Object.keys(first.body.items[0]).sort(), [
      "created_at",
      "id",
      "username",
    ]);
    const second = await request(
      path + "?cursor=" + encodeURIComponent(first.body.next_cursor),
      "GET",
      undefined,
      "",
    );
    assert.equal(second.body.items.length, 5);
    assert.equal(second.body.next_cursor, null);
    assert.equal(
      new Set([...first.body.items, ...second.body.items].map((x: any) => x.id))
        .size,
      35,
    );
  }
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(id);
  assert.equal(
    (await request(`/reports/${id}/stars`, "GET", undefined, "")).status,
    404,
  );
  assert.equal(
    (await request(`/claims/${claim}/stars`, "GET", undefined, "")).status,
    404,
  );
});

test("first GitHub login requires explicit signup; existing login bypasses it", async (t) => {
  const { env, db } = await fixture();
  env.GITHUB_CLIENT_ID = "test";
  env.GITHUB_CLIENT_SECRET = "test";
  env.ADMIN_GITHUB_IDS = "540144";
  let githubID = 999;
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const path = String(input);
    if (path.includes("access_token"))
      return Response.json({ access_token: "test" });
    if (path.endsWith("/user/emails"))
      return Response.json([
        { email: "test@example.test", primary: true, verified: true },
      ]);
    return Response.json({
      id: githubID,
      login: githubID === 999 ? "new-user" : "alice",
    });
  });
  const call = (
    path: string,
    cookie: string,
    method = "GET",
    body?: any,
    csrf = "",
    origin = env.APP_ORIGIN,
  ) =>
    app.request(
      env.APP_ORIGIN + path,
      {
        method,
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      env,
    );
  const cookies = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
  async function oauth() {
    const start = await call(
      "/auth/github?return_to=" + encodeURIComponent("/device?code=ABCD-EFGH"),
      "",
    );
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    );
    return call(
      "/auth/github/callback?code=test&state=" + state,
      cookies(start),
    );
  }
  const callback = await oauth();
  assert.equal(callback.headers.get("location"), "/signup");
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM users WHERE github_id=999").get()!.n,
    0,
  );
  const cookie = cookies(callback);
  const pending = (await (await call("/auth/signup", cookie)).json()) as any;
  assert.equal(pending.username, "new-user");
  const b = { terms_version: "test" };
  assert.equal(
    (await call("/auth/signup", cookie, "POST", b, "wrong")).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/auth/signup",
        cookie,
        "POST",
        b,
        pending.csrf,
        "https://evil.test",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/auth/signup",
        cookie,
        "POST",
        { terms_version: "old" },
        pending.csrf,
      )
    ).status,
    409,
  );
  const signed = await call("/auth/signup", cookie, "POST", b, pending.csrf);
  assert.equal(signed.status, 200, await signed.clone().text());
  assert.equal(
    ((await signed.json()) as any).return_to,
    "/device?code=ABCD-EFGH",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM users WHERE github_id=999").get()!.n,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM pending_signups").get()!.n,
    0,
  );
  assert.match(cookies(signed), /__Host-proofsr_session=/);
  assert.equal(
    (await call("/auth/signup", cookie, "POST", b, pending.csrf)).status,
    401,
  );
  githubID = 1;
  const existing = await oauth();
  assert.equal(existing.headers.get("location"), "/device?code=ABCD-EFGH");
  assert.match(cookies(existing), /__Host-proofsr_session=/);
  // Abandoned registrations expire and cannot be confirmed.
  githubID = 1000;
  const abandoned = await oauth();
  const abandonedCookie = cookies(abandoned);
  db.exec("UPDATE pending_signups SET expires_at='2000-01-01'");
  assert.equal((await call("/auth/signup", abandonedCookie)).status, 401);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM users WHERE github_id=1000").get()!.n,
    0,
  );
  const switchAccount = await call(
    "/auth/github?switch_account=1&return_to=https://evil.test",
    abandonedCookie,
  );
  assert.equal(
    new URL(switchAccount.headers.get("location")!).searchParams.get("prompt"),
    "select_account",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM pending_signups").get()!.n,
    0,
  );
});

test("tool version limitations are operator-maintained, live on old reports, and version-scoped", async () => {
  const { request, db } = await fixture();
  const version = "/tool-versions/kani-0.68.0";
  const made = await request("/reports", "POST", reportInput);
  const id = made.body.id;
  const before = (await request(`/reports/${id}`)).body;
  assert.equal(before.tool_limitations, "");
  assert.equal(before.tool_limitations_updated_at, null);
  const action = {
    action: "tool_version_limitations",
    target: "kani-0.68.0",
    limitations: "Bounded harnesses only.\n<script>example</script>",
    reason: "Document known limitations",
  };
  assert.equal((await request("/admin/action", "POST", action)).status, 403);
  assert.equal(
    (await request("/admin/action", "POST", action, "admin")).status,
    200,
  );
  const v = (await request(version, "GET", undefined, "")).body;
  assert.equal(v.limitations, action.limitations);
  assert.ok(v.limitations_updated_at);
  const report = (await request(`/reports/${id}?v=1`)).body;
  const claim = (
    await request(`/claims/${before.claims[0].id}?report_revision=1`)
  ).body;
  for (const item of [report, claim]) {
    assert.equal(item.tool_limitations, action.limitations);
    assert.equal(item.tool_limitations_updated_at, v.limitations_updated_at);
  }
  assert.equal(report.revision_no, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM report_revisions").get()!.n,
    1,
  );
  assert.equal((await request(version + "/reports")).body.items[0].id, id);
  db.exec(
    "INSERT INTO tool_versions(id,tool_id,version) VALUES('other-version','kani','other')",
  );
  assert.equal(
    (await request("/tool-versions/other-version/reports")).body.items.length,
    0,
  );
  db.exec(`UPDATE reports SET visibility='hidden' WHERE id=${id}`);
  assert.equal((await request(version + "/reports")).body.items.length, 0);
  assert.equal((await request("/tool-versions/missing")).status, 404);
  assert.equal((await request("/tool-versions/missing/reports")).status, 404);
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { ...action, target: "missing" },
        "admin",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { ...action, limitations: "x".repeat(10001) },
        "admin",
      )
    ).status,
    400,
  );
  await request(
    "/admin/action",
    "POST",
    {
      action: "tool_version",
      target: action.target,
      tool_id: "kani",
      version: "0.68.0",
      selectable: false,
      reason: "Retire",
    },
    "admin",
  );
  assert.equal((await request(version)).body.limitations, action.limitations);
  await request(
    "/admin/action",
    "POST",
    { ...action, limitations: "" },
    "admin",
  );
  assert.equal((await request(version)).body.limitations, "");
});

test("existing bearer tokens use current admin IDs with audit and authentication guards", async () => {
  const { env, db } = await fixture(false);
  const token = "c".repeat(64);
  db.prepare(
    "INSERT INTO api_tokens(id,user_id,token_hash,scope,created_at,expires_at) VALUES('admin-token','admin',?,'publish',?,?)",
  ).run(
    await hash(token),
    new Date().toISOString(),
    new Date(Date.now() + 86400000).toISOString(),
  );
  const action = {
    action: "tool",
    target: "kani",
    name: "kani",
    description: "Verifier",
    url: "https://model-checking.github.io/kani/",
    active: true,
    reason: "Register verifier",
  };
  // Deliberately omit cookies, Origin and CSRF, exactly as a curl client would.
  const call = async (path: string, body?: unknown, credential = token) => {
    const res = await app.request(
      "https://example.test/api/v1" + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + credential,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  // A stale stored role does not prevent access for a currently configured admin.
  db.exec("UPDATE users SET role='user' WHERE id='admin'");
  env.ADMIN_GITHUB_IDS = "99, 3 ";
  assert.equal((await call("/admin/action", action)).status, 200);
  assert.equal(
    (
      await call("/admin/action", {
        action: "tool_version",
        target: "kani-0.68.0",
        tool_id: "kani",
        version: "0.68.0",
        selectable: true,
        reason: "Register release",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/admin/action", {
        action: "tool_version_limitations",
        target: "kani-0.68.0",
        limitations: "Test limitations",
        reason: "Document limitations",
      })
    ).status,
    200,
  );
  assert.equal(
    db.prepare("SELECT limitations FROM tool_versions").get()!.limitations,
    "Test limitations",
  );
  const audit = await call("/admin/audit");
  assert.equal(audit.status, 200);
  assert.equal(audit.body.items.length, 3);
  assert.ok(audit.body.items.every((item: any) => item.actor_id === "admin"));
  assert.equal((await call("/admin/deliveries")).status, 200);
  assert.equal((await call("/admin/comments/missing/history")).status, 200);
  // The exception is limited to admin routes, not other browser-only endpoints.
  assert.equal((await call("/me/tokens")).body.error, "insufficient_scope");
  assert.equal(
    (await call("/admin/action", { ...action, reason: "" })).status,
    400,
  );

  db.exec("UPDATE users SET role='admin' WHERE id='admin'");
  for (const ids of ["", "33", "1,2"]) {
    env.ADMIN_GITHUB_IDS = ids;
    assert.equal((await call("/admin/audit")).body.error, "admin_required");
    assert.equal(
      (await call("/admin/action", action)).body.error,
      "admin_required",
    );
  }
  env.ADMIN_GITHUB_IDS = "3";
  db.exec("UPDATE api_tokens SET user_id='alice'");
  assert.equal((await call("/admin/audit")).body.error, "admin_required");
  assert.equal(
    (await call("/admin/action", action)).body.error,
    "admin_required",
  );
  db.exec("UPDATE api_tokens SET user_id='admin'");
  db.exec("UPDATE users SET accepted_terms_version='old' WHERE id='admin'");
  assert.equal((await call("/admin/action", action)).status, 428);
  db.exec(
    "UPDATE users SET accepted_terms_version='test',status='suspended' WHERE id='admin'",
  );
  assert.equal((await call("/admin/audit")).body.error, "account_suspended");
  db.exec("UPDATE users SET status='active' WHERE id='admin'");
  db.exec("UPDATE api_tokens SET revoked_at='2026-01-01'");
  assert.equal(
    (await call("/admin/action", action)).body.error,
    "invalid_token",
  );
  db.exec("UPDATE api_tokens SET revoked_at=NULL,expires_at='2000-01-01'");
  assert.equal((await call("/admin/audit")).body.error, "invalid_token");
  assert.equal(
    (await call("/admin/audit", undefined, "bad")).body.error,
    "invalid_token",
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events").get()!.n, 4);
});

test("browser admin requests retain CSRF and origin checks and follow current admin IDs", async () => {
  const { env, request } = await fixture();
  const action = {
    action: "pause",
    target: "imports_paused",
    value: true,
    reason: "Test",
  };
  assert.equal(
    (
      await request("/admin/action", "POST", action, "admin", {
        "X-CSRF-Token": "wrong",
      })
    ).body.error,
    "invalid_csrf",
  );
  assert.equal(
    (
      await request("/admin/action", "POST", action, "admin", {
        Origin: "https://other.test",
      })
    ).body.error,
    "invalid_origin",
  );
  env.ADMIN_GITHUB_IDS = "";
  assert.equal(
    (await request("/admin/audit", "GET", undefined, "admin")).body.error,
    "admin_required",
  );
});

test("single-request run registration compensates failures and reclaims only crash leftovers", async () => {
  const { env, db } = await fixture();
  const objects = new Map<string, { bytes: Uint8Array; uploaded: Date }>();
  env.ARCHIVE = {
    put: async (key: string, bytes: ArrayBuffer) => {
      objects.set(key, { bytes: new Uint8Array(bytes), uploaded: new Date() });
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
    list: async () => ({
      objects: [...objects].map(([key, o]) => ({ key, uploaded: o.uploaded })),
      truncated: false,
    }),
  } as any;
  const rid = "33333333-3333-4333-8333-333333333333";
  const upload = () =>
    app.request(
      `https://example.test/api/v1/runs/${rid}/sarif`,
      {
        method: "POST",
        headers: {
          Origin: env.APP_ORIGIN,
          Cookie: "__Host-proofsr_session=alice",
          "X-CSRF-Token": "csrf",
        },
        body: JSON.stringify(recordedSarif(rid)),
      },
      env,
    );
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = async () => {
    throw Error("simulated DB failure");
  };
  assert.equal((await upload()).status, 500);
  assert.equal(
    objects.size,
    0,
    "failed DB registration must remove its upload",
  );
  assert.equal(
    db.prepare("SELECT id FROM verification_runs WHERE id=?").get(rid),
    undefined,
  );
  env.DB.batch = async (statements: any) => {
    await batch(statements);
    throw Error("lost committed response");
  };
  assert.equal((await upload()).status, 200);
  assert.equal(
    objects.size,
    1,
    "lost response must not delete committed evidence",
  );
  env.DB.batch = batch;
  const old = new Date(Date.now() - 2 * 86400000);
  for (const o of objects.values()) o.uploaded = old;
  objects.set("runs/orphan/old", { bytes: new Uint8Array(), uploaded: old });
  objects.set("runs/orphan/recent", {
    bytes: new Uint8Array(),
    uploaded: new Date(),
  });
  await cleanupRunUploads(env);
  assert.equal(objects.has("runs/orphan/old"), false);
  assert.equal(objects.has("runs/orphan/recent"), true);
  assert.equal(objects.size, 2, "keep committed evidence regardless of age");
});

test("new trait-driven structural paths match cargo-proofs fixtures", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL(
        "../cli/tests/fixtures/canonical-trait-paths.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const c of cases) {
    const doc = traitImplFixture(c.type);
    doc.paths = c.paths || {};
    const apis = extractAPIs(doc, "sample", "1.0.0");
    assert.deepEqual(
      apis.map((a) => a.canonical_key),
      [`<${c.key} as sample::T>::m`],
      c.source,
    );
    assert.equal(
      apis[0].upstream_url,
      "https://docs.rs/sample/1.0.0/sample/trait.T.html#tymethod.m",
    );
  }
});

function traitImplFixture(selfType: any): any {
  const fn = {
    header: { is_unsafe: false, abi: "Rust" },
    generics: {},
    sig: { inputs: [], output: null },
    has_body: false,
  };
  return {
    format_version: 61,
    crate_version: "1.0.0",
    root: 0,
    index: {
      0: { crate_id: 0, name: "sample", inner: { module: { items: [1] } } },
      1: {
        crate_id: 0,
        name: "T",
        visibility: "public",
        inner: { trait: { items: [2], implementations: [3] } },
      },
      2: { name: "m", inner: { function: fn } },
      3: {
        crate_id: 0,
        inner: {
          impl: {
            for: selfType,
            trait: { path: "T", id: 1 },
            generics: {},
            items: [4],
          },
        },
      },
      4: {
        name: "m",
        visibility: "default",
        inner: { function: { ...fn, has_body: true } },
      },
    },
  };
}

test("trait traversal preserves legacy entries and all public aliases without duplicates", () => {
  const doc = traitImplFixture({ resolved_path: { path: "S", id: 5 } });
  doc.index[0].inner.module.items.push(5, 6, 7);
  doc.index[5] = {
    crate_id: 0,
    name: "S",
    visibility: "public",
    inner: { struct: { impls: [3] } },
  };
  doc.index[6] = {
    visibility: "public",
    inner: { use: { id: 1, name: "Alias", is_glob: false } },
  };
  doc.index[7] = {
    visibility: "public",
    inner: { use: { id: 5, name: "Other", is_glob: false } },
  };
  doc.index[1].inner.trait.implementations = [];
  const legacy = extractAPIs(doc, "sample", "1.0.0");
  doc.index[1].inner.trait.implementations = [3, 3];
  assert.deepEqual(extractAPIs(doc, "sample", "1.0.0"), legacy);
  assert.equal(legacy.length, 4);
  doc.index[3].inner.impl.for = { primitive: "u8" };
  doc.index[5].inner.struct.impls = [];
  assert.deepEqual(
    extractAPIs(doc, "sample", "1.0.0").map((a) => a.canonical_key),
    ["<u8 as sample::T>::m", "<u8 as sample::Alias>::m"],
  );
  doc.index[1].visibility = "default";
  doc.index[0].inner.module.items = [1];
  assert.deepEqual(extractAPIs(doc, "sample", "1.0.0"), []);
});

test("trait traversal excludes synthetic, negative, external and private nominal impls", () => {
  for (const change of [
    (d: any) => {
      d.index[3].inner.impl.is_synthetic = true;
    },
    (d: any) => {
      d.index[3].inner.impl.is_negative = true;
    },
    (d: any) => {
      d.index[3].crate_id = 1;
    },
    (d: any) => {
      d.index[1].crate_id = 1;
    },
    (d: any) => {
      d.index[3].inner.impl.for = { resolved_path: { path: "Private", id: 5 } };
      d.index[5] = { crate_id: 0, inner: { struct: { impls: [3] } } };
    },
  ]) {
    const doc = traitImplFixture({ primitive: "u8" });
    change(doc);
    assert.deepEqual(extractAPIs(doc, "sample", "1.0.0"), []);
  }
  const doc = traitImplFixture({ primitive: "u8" });
  delete doc.index[3];
  assert.throws(
    () => extractAPIs(doc, "sample", "1.0.0"),
    /invalid_rustdoc_impl/,
  );
});

test("hex trait fixture includes every macro array impl, Vec and generic ToHex", () => {
  const doc = JSON.parse(
    readFileSync(
      new URL("../fixtures/hex-0.4.3-trait-impls.json", import.meta.url),
      "utf8",
    ),
  );
  const apis = extractAPIs(doc, "hex", "0.4.3");
  assert.equal(apis.length, 162);
  const keys = new Set(apis.map((a) => a.canonical_key));
  assert(keys.has("<alloc::vec::Vec<u8> as hex::FromHex>::from_hex"));
  assert(keys.has("<T as hex::ToHex>::encode_hex"));
  assert(keys.has("<T as hex::ToHex>::encode_hex_upper"));
  const arrays = doc.index[85].inner.trait.implementations
    .map((id: number) => doc.index[id].inner.impl.for.array)
    .filter(Boolean);
  assert.equal(arrays.length, 159);
  for (const a of arrays)
    assert(keys.has(`<\u005bu8; ${a.len}] as hex::FromHex>::from_hex`));
  assert(
    apis.every((a) =>
      /trait\.(FromHex|ToHex)\.html#tymethod\./.test(a.upstream_url),
    ),
  );
});

test("structural trait arguments distinguish impls and refresh preserves reports and IDs", async () => {
  const { db, env, request } = await fixture();
  const report = await request("/reports", "POST", reportInput);
  assert.equal(report.status, 201);
  const before = db.prepare("SELECT * FROM api_items ORDER BY id").all();
  const reports = db.prepare("SELECT * FROM reports ORDER BY id").all();
  const claims = db.prepare("SELECT * FROM claims ORDER BY id").all();
  const doc = traitImplFixture({ primitive: "u8" });
  const first = doc.index[3].inner.impl;
  first.trait.args = {
    angle_bracketed: { args: [{ type: { primitive: "u16" } }] },
  };
  doc.index[5] = structuredClone(doc.index[3]);
  doc.index[5].inner.impl.trait.args.angle_bracketed.args[0].type.primitive =
    "u32";
  doc.index[1].inner.trait.implementations.push(5);
  (env as any).ARCHIVE.get = async () => ({
    text: async () => JSON.stringify(doc),
  });
  assert.deepEqual(await refreshCatalog(env, 1), { indexed: 2, added: 2 });
  assert.deepEqual(await refreshCatalog(env, 1), { indexed: 2, added: 0 });
  assert.deepEqual(
    db
      .prepare(
        "SELECT * FROM api_items WHERE id IN ('safe','unsafe') ORDER BY id",
      )
      .all(),
    before,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM reports ORDER BY id").all(),
    reports,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM claims ORDER BY id").all(),
    claims,
  );
  for (const arg of ["u16", "u32"]) {
    const path = `<u8 as sample::T<${arg}>>::m`;
    const resolved = await request(
      `/resolve-api?crate=sample&version=1.0.0&path=${encodeURIComponent(path)}`,
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.id, await hash("1:" + path));
  }
});

test("nested local type references use public aliases in structural keys", () => {
  const doc = traitImplFixture({
    resolved_path: {
      path: "Vec",
      id: 20,
      args: {
        angle_bracketed: {
          args: [{ type: { resolved_path: { path: "hidden::S", id: 5 } } }],
        },
      },
    },
  });
  doc.paths = { 20: { path: ["alloc", "vec", "Vec"] } };
  doc.index[5] = {
    crate_id: 0,
    name: "S",
    visibility: "public",
    inner: { struct: { impls: [] } },
  };
  doc.index[6] = {
    visibility: "public",
    inner: { use: { id: 5, name: "Alias", is_glob: false } },
  };
  doc.index[0].inner.module.items.push(6);
  assert.equal(
    extractAPIs(doc, "sample", "1.0.0")[0].canonical_key,
    "<alloc::vec::Vec<sample::Alias> as sample::T>::m",
  );
});

test("report reads use one D1 batch, preserve revision/star semantics and reject hidden reports", async () => {
  const { env, db, request } = await fixture();
  const created = await request("/reports", "POST", reportInput);
  assert.equal(created.status, 201);
  const id = created.body.id;
  const first = (await request(`/reports/${id}`)).body;
  const claim = first.claims[0].id;
  await request(`/reports/${id}/star`, "PUT", {}, "bob");
  await request(`/claims/${claim}/star`, "PUT", {}, "bob");
  const revised = await request(`/reports/${id}/revisions`, "POST", {
    ...reportInput,
    expected_revision: 1,
    title: "Revision two",
    claims: [{ ...reportInput.claims[0], id: claim }],
  });
  assert.equal(revised.status, 201);
  const original = env.DB;
  let calls = 0;
  env.DB = {
    prepare(sql: string) {
      const q = original.prepare(sql);
      const wrap = (s: any): any => ({
        bind: (...values: any[]) => wrap(s.bind(...values)),
        first: (...args: any[]) => {
          calls++;
          return s.first(...args);
        },
        all: (...args: any[]) => {
          calls++;
          return s.all(...args);
        },
        run: (...args: any[]) => {
          calls++;
          return s.run(...args);
        },
      });
      return wrap(q);
    },
    async batch(statements: any[]) {
      // The fixture executes each statement via run(); count only the outer call.
      const before = calls;
      const result = await original.batch(statements);
      calls = before + 1;
      return result;
    },
  } as any;
  for (const user of ["", "bob"]) {
    for (const suffix of ["", "/revisions/1"]) {
      calls = 0;
      const r = await request(
        `/reports/${id}${suffix}`,
        "GET",
        undefined,
        user,
      );
      assert.equal(r.status, 200);
      assert.equal(calls, user ? 2 : 1); // session authentication + one read batch
      assert.equal(r.body.revision_no, suffix ? 1 : 2);
      assert.equal(r.body.latest_revision_no, 2);
      assert.equal(r.body.my_star, !!user);
      assert.equal(r.body.claims[0].my_star, !!user);
      assert.deepEqual(r.body.run_ids, reportInput.run_ids);
    }
  }
  assert.equal(
    (await request(`/reports/${id}/revisions/99`)).body.error,
    "revision_not_found",
  );
  db.prepare("UPDATE reports SET withdrawn_at=? WHERE id=?").run(
    new Date().toISOString(),
    id,
  );
  assert.equal((await request(`/reports/${id}`)).status, 200);
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(id);
  for (const suffix of ["", "/revisions/1", "/revisions/99"]) {
    const r = await request(`/reports/${id}${suffix}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "report_not_found");
    assert.equal(r.body.claims, undefined);
  }
});

test("claim numbers follow each report revision while UUID identity and old numbers survive", async () => {
  const { request } = await fixture();
  const input = {
    ...reportInput,
    claims: [1, 2, 3].map((n) => ({
      ...reportInput.claims[0],
      title: `Scope ${n}`,
      claim_number: 99,
    })),
  };
  const made = await request("/reports", "POST", input);
  assert.equal(made.status, 201);
  const id = made.body.id;
  const original = (await request(`/reports/${id}`)).body.claims;
  assert.deepEqual(
    original.map((c: any) => c.claim_number),
    [1, 2, 3],
  );
  const revision = {
    ...reportInput,
    expected_revision: 1,
    claims: [
      original[2],
      original[0],
      { ...reportInput.claims[0], title: "Added" },
    ],
  };
  assert.equal(
    (await request(`/reports/${id}/revisions`, "POST", revision)).status,
    201,
  );
  const current = (await request(`/reports/${id}`)).body.claims;
  assert.deepEqual(
    current.map((c: any) => c.claim_number),
    [1, 2, 3],
  );
  assert.equal(current[0].id, original[2].id);
  assert.equal(current[1].id, original[0].id);
  assert.deepEqual(
    (await request(`/reports/${id}/revisions/1`)).body.claims.map(
      (c: any) => c.claim_number,
    ),
    [1, 2, 3],
  );
  assert.equal(
    (await request(`/claims/${original[2].id}?report_revision=1`)).body
      .claim_number,
    3,
  );
  assert.equal(
    (await request(`/claims/${original[2].id}`)).body.claim_number,
    1,
  );
  const removed = (await request(`/claims/${original[1].id}`)).body;
  assert.equal(removed.claim_number, 2);
  assert.equal(removed.report_revision, 1);
  assert.equal(removed.in_current_report, 0);
  assert.equal(
    (
      await request(`/reports/${id}/revisions`, "POST", {
        ...reportInput,
        expected_revision: 2,
        claims: [original[1]],
      })
    ).status,
    201,
  );
  assert.equal(
    (await request(`/claims/${original[1].id}`)).body.claim_number,
    1,
  );
  const another = (await request("/reports", "POST", reportInput)).body.id;
  assert.equal(
    (await request(`/reports/${another}`)).body.claims[0].claim_number,
    1,
  );
});

test("catalogue, crate and comment reads batch database round trips without changing API semantics", async () => {
  const { env, db, request } = await fixture();
  const made = await request("/reports", "POST", reportInput);
  assert.equal(made.status, 201);
  const id = made.body.id;
  for (let n = 1; n <= 35; n++) {
    db.prepare(
      "INSERT INTO report_comments(id,report_id,sequence_no,revision_no,author_id,body,created_at) VALUES(?,?,?,1,'alice',?,'2026-01-01')",
    ).run(`comment-${n}`, id, n, `Body ${n}`);
  }
  db.prepare(
    "UPDATE report_comments SET visibility='hidden' WHERE id='comment-2'",
  ).run();
  db.prepare(
    "UPDATE report_comments SET deleted_at='2026-01-02' WHERE id='comment-3'",
  ).run();
  db.prepare(
    "INSERT INTO tool_versions(id,tool_id,version,selectable) VALUES('kani-retired','kani','0.1',0)",
  ).run();
  db.prepare(
    "INSERT INTO tools VALUES('empty','Empty','No versions','https://example.test',1)",
  ).run();
  const original = env.DB;
  let calls = 0;
  env.DB = {
    prepare(sql: string) {
      const q = original.prepare(sql);
      const wrap = (s: any): any => ({
        bind: (...values: any[]) => wrap(s.bind(...values)),
        first: (...args: any[]) => {
          calls++;
          return s.first(...args);
        },
        all: (...args: any[]) => {
          calls++;
          return s.all(...args);
        },
        run: (...args: any[]) => {
          calls++;
          return s.run(...args);
        },
      });
      return wrap(q);
    },
    async batch(statements: any[]) {
      // The fixture executes each statement via run(); count only the outer call.
      const before = calls;
      const result = await original.batch(statements);
      calls = before + 1;
      return result;
    },
  } as any;

  async function read(path: string, user = "") {
    calls = 0;
    const r = await request(path, "GET", undefined, user);
    assert.equal(calls, user ? 2 : 1, path); // authentication stays separate
    return r;
  }
  for (const user of ["", "bob"]) {
    const tools = await read("/tools", user);
    assert.deepEqual(
      tools.body.items.map((x: any) => x.id),
      ["empty", "kani"],
    );
    assert.deepEqual(
      tools.body.versions.map((x: any) => x.id),
      ["kani-retired", "kani-0.68.0"],
    );
    const detail = await read("/tools/kani", user);
    assert.equal(detail.body.id, "kani");
    assert.equal(detail.body.versions.length, 2);
    assert.deepEqual((await read("/tools/empty", user)).body.versions, []);
    assert.equal(
      (await read("/tools/missing", user)).body.error,
      "tool_not_found",
    );
    const crates = await read("/crates?q=sample", user);
    assert.equal(crates.body.total_count, 1);
    assert.equal(crates.body.matching_count, 1);
    assert.deepEqual(
      crates.body.items.map((x: any) => x.name),
      ["sample"],
    );
    const empty = await read("/crates?q=%25", user);
    assert.equal(empty.body.total_count, 1);
    assert.equal(empty.body.matching_count, 0);
    assert.deepEqual(empty.body.items, []);
    const reports = await read("/tool-versions/kani-0.68.0/reports", user);
    assert.deepEqual(
      reports.body.items.map((x: any) => x.id),
      [id],
    );
    assert.deepEqual(
      (await read("/tool-versions/kani-retired/reports", user)).body.items,
      [],
    );
    const first = await read(`/reports/${id}/comments`, user);
    assert.equal(first.body.items.length, 30);
    assert.equal(first.body.items[1].body, null);
    assert.equal(first.body.items[1].username, null);
    assert.equal(first.body.items[2].body, null);
    const second = await read(
      `/reports/${id}/comments?cursor=${encodeURIComponent(first.body.next_cursor)}`,
      user,
    );
    assert.equal(second.body.items.length, 5);
    assert.equal(second.body.next_cursor, null);
    assert.deepEqual(
      [...first.body.items, ...second.body.items].map(
        (x: any) => x.sequence_no,
      ),
      Array.from({ length: 35 }, (_, i) => i + 1),
    );
    assert.deepEqual(
      (await read(`/reports/${id}/comments?parent_id=comment-1`, user)).body
        .items,
      [],
    );
  }
  for (const path of [
    "/crates",
    `/reports/${id}/comments`,
    "/tool-versions/kani-0.68.0/reports",
  ]) {
    const r = await read(path + "?cursor=!");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_cursor");
  }
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(id);
  for (const path of [
    `/reports/${id}/comments`,
    "/reports/999/comments",
    "/tool-versions/missing/reports",
  ]) {
    for (const query of ["", "?cursor=!"]) {
      const r = await read(path + query);
      assert.equal(r.status, 404);
      assert.equal(
        r.body.error,
        path.startsWith("/reports/")
          ? "report_not_found"
          : "tool_version_not_found",
      );
      assert.equal(r.body.items, undefined);
    }
  }
  assert.deepEqual(
    (await read("/tool-versions/kani-0.68.0/reports")).body.items,
    [],
  );
  assert.equal((await read("/crates")).body.total_count, 0);
});

test("public request schemas reject malformed bodies without changing transport and auth guards", async () => {
  const { env, db } = await fixture();
  const call = (
    body: string,
    contentType = "application/json",
    csrf = "csrf",
  ) =>
    app.request(
      "https://example.test/api/v1/me/notification-preferences",
      {
        method: "PATCH",
        headers: {
          Origin: env.APP_ORIGIN,
          Cookie: "__Host-proofsr_session=alice",
          "X-CSRF-Token": csrf,
          "Content-Type": contentType,
        },
        body,
      },
      env,
    );
  for (const [body, contentType, status, error] of [
    ["{", "application/json", 400, "invalid_json"],
    ["[]", "application/json", 400, "invalid_json"],
    ["{}", "text/plain", 415, "json_required"],
    [
      JSON.stringify({ replies: "yes", report_comments: false }),
      "application/json",
      400,
      "invalid_field",
    ],
    ["x".repeat(131073), "application/json", 413, "payload_too_large"],
  ] as const) {
    const r = await call(body, contentType);
    assert.equal(r.status, status);
    assert.equal(((await r.json()) as any).error, error);
  }
  const denied = await call("{}", "application/json", "wrong");
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as any).error, "invalid_csrf");
  assert.equal(
    db
      .prepare(
        "SELECT replies FROM notification_preferences WHERE user_id='alice'",
      )
      .get()!.replies,
    1,
  );
  assert.equal(
    (await call(JSON.stringify({ replies: false, report_comments: true })))
      .status,
    200,
  );
  assert.equal(
    db
      .prepare(
        "SELECT replies FROM notification_preferences WHERE user_id='alice'",
      )
      .get()!.replies,
    0,
  );
});

test("crate API catalogue returns all entries and counts active claims", async () => {
  const { db, request } = await fixture();
  for (let n = 0; n < 40; n++)
    db.prepare("INSERT INTO api_items VALUES(?,?,?,?,?,?,?,?)").run(
      `extra-${n}`,
      1,
      `sample::extra${n}`,
      `sample::extra${n}`,
      "function",
      0,
      "pub fn extra()",
      "https://docs.rs",
    );
  const published = await request("/reports", "POST", reportInput);
  assert.equal(published.status, 201);
  const read = () => request("/crates/sample/1.0.0/apis", "GET", undefined, "");
  const result = await read();
  assert.equal(result.body.items.length, 42);
  assert.equal(result.body.next_cursor, null);
  const safe = result.body.items.find((a: any) => a.id === "safe");
  assert.equal(safe.no_ub_count, 1);
  assert.equal(safe.panic_count, 0);
  db.prepare("UPDATE reports SET visibility='hidden' WHERE id=?").run(
    published.body.id,
  );
  assert.equal(
    (await read()).body.items.find((a: any) => a.id === "safe").no_ub_count,
    0,
  );
  assert.equal(
    (await request("/crates/sample/1.0.0/apis?q=extra", "GET", undefined, ""))
      .body.items.length,
    40,
  );
});

test("UI visibility configuration defaults off and exposes independent flags without changing stored reactions", async () => {
  const { env, request } = await fixture();
  for (const value of [undefined, "false", "TRUE", "1"]) {
    env.SHOW_STAR_KARMA = value;
    env.SHOW_HOME_DISCUSSION = value;
    const { body } = await request("/config");
    assert.equal(body.show_star_karma, false);
    assert.equal(body.show_home_discussion, false);
  }
  for (const star of [false, true])
    for (const discussion of [false, true]) {
      env.SHOW_STAR_KARMA = String(star);
      env.SHOW_HOME_DISCUSSION = String(discussion);
      const { body } = await request("/config");
      assert.equal(body.show_star_karma, star);
      assert.equal(body.show_home_discussion, discussion);
    }
});

test("HTML pages render public content without JavaScript and preserve visibility and revisions", async () => {
  const { JSDOM } = await import("jsdom");
  const { db, env, request } = await fixture();
  const made = await request("/reports", "POST", {
    ...reportInput,
    title: "SSR <script>report</script>",
    explanation: "Visible report explanation",
  });
  assert.equal(made.status, 201);
  const claim = db.prepare("SELECT id FROM claims WHERE report_id=1").get()!.id;
  for (const [path, expected] of [
    ["/", "Recent reports"],
    ["/crates?q=sample", "sample"],
    ["/crate/sample?version=1.0.0", "safe"],
    ["/api/safe", "sample::safe"],
    ["/reports", "SSR <script>report</script>"],
    ["/report/1", "Visible report explanation"],
    [`/claim/${claim}?report_revision=1`, "Preconditions"],
    ["/tools", "Kani"],
    ["/tool/kani", "0.68.0"],
    ["/tool-version/kani-0.68.0", "SSR <script>report</script>"],
    ["/user/alice", "SSR <script>report</script>"],
    ["/account", "SSR <script>report</script>"],
    ["/settings", "Email notifications"],
  ]) {
    const response = await app.request(
      "https://example.test" + path,
      { headers: { Cookie: "__Host-proofsr_session=alice" } },
      env,
    );
    assert.equal(
      response.status,
      200,
      path + ": " + (await response.clone().text()),
    );
    assert.match(response.headers.get("content-type")!, /text\/html/);
    assert.ok(response.headers.get("cache-control")?.includes("no-store"));
    const dom = new JSDOM(await response.text());
    assert.ok(
      dom.window.document
        .querySelector("main")!
        .textContent!.includes(expected),
      path,
    );
    assert.equal(dom.window.document.querySelector("main script"), null);
    assert.equal(
      dom.window.document.querySelector('script[src*="main"]'),
      null,
    );
    dom.window.close();
  }
  const response = await app.request("https://example.test/report/1", {}, env);
  const html = await response.text();
  assert.match(html, /Run locally/);
  assert.match(html, /Recorded run/);
  assert.match(html, /Diagnostics &amp; logs/);
  assert.doesNotMatch(html, /Loading…|Loading recorded runs/);
  for (const path of [
    "/report/999",
    "/report/1?v=999",
    "/claim/missing",
    "/api/missing",
  ]) {
    const r = await app.request("https://example.test" + path, {}, env);
    assert.equal(r.status, 404, path);
    assert.match(r.headers.get("content-type")!, /text\/html/);
  }
  const comment = await request("/reports/1/comments", "POST", {
    body: "Linked comment",
    revision_no: 1,
  });
  assert.equal(comment.status, 201);
  const linked = await app.request(
    "https://example.test/report/1?comment=" + comment.body.id,
    {},
    env,
  );
  assert.equal(linked.status, 302);
  assert.equal(
    linked.headers.get("location"),
    "/report/1#comment-" + comment.body.id,
  );
  const section = await app.request(
    "https://example.test/crate/sample?version=1.0.0&section=apis",
    {},
    env,
  );
  assert.equal(section.status, 302);
  assert.equal(
    section.headers.get("location"),
    "/crate/sample?version=1.0.0#apis",
  );
  db.exec("UPDATE reports SET visibility='hidden' WHERE id=1");
  for (const path of [
    "/report/1",
    `/claim/${claim}`,
    "/runs/11111111-1111-4111-8111-111111111111?report=1",
  ]) {
    const r = await app.request("https://example.test" + path, {}, env);
    assert.equal(r.status, 404, path);
    assert.doesNotMatch(await r.text(), /Visible report explanation/);
  }
});

test("HTML page links paginate growing lists and retain filters while bounded content is complete", async () => {
  const { JSDOM } = await import("jsdom");
  const { db, env, request } = await fixture();
  for (let i = 0; i < 35; i++) {
    db.exec("DELETE FROM rate_limits");
    assert.equal(
      (
        await request("/reports", "POST", {
          ...reportInput,
          title: "Report " + i,
        })
      ).status,
      201,
    );
  }
  for (const path of [
    "/reports",
    "/crate/sample?version=1.0.0",
    "/api/safe",
    "/tool/kani",
    "/tool-version/kani-0.68.0",
    "/user/alice?section=reports",
    "/account?section=reports",
  ]) {
    const read = async (url: string) =>
      new JSDOM(
        await (
          await app.request(
            url,
            { headers: { Cookie: "__Host-proofsr_session=alice" } },
            env,
          )
        ).text(),
      );
    const first = await read("https://example.test" + path);
    const next = first.window.document
      .querySelector('a[rel="next"]')!
      .getAttribute("href")!;
    assert.ok(next, path);
    const nextURL = new URL(next, "https://example.test");
    for (const [key, value] of new URL(path, "https://example.test")
      .searchParams)
      assert.equal(nextURL.searchParams.get(key), value);
    const second = await read(nextURL.href);
    assert.equal(
      second.window.document.querySelector('a[rel="next"]'),
      null,
      path,
    );
    const selector = path.startsWith("/api/")
      ? 'main .claim-item a[href^="/claim/"]'
      : 'main .claim-item a[href^="/report/"]';
    const links = (dom: any) =>
      Array.from(dom.window.document.querySelectorAll(selector)).map((a: any) =>
        a.getAttribute("href"),
      );
    assert.equal(links(first).length, 30, path);
    assert.equal(links(second).length, 5, path);
    assert.equal(new Set([...links(first), ...links(second)]).size, 35, path);
    first.window.close();
    second.window.close();
  }
  // More than one API page of revisions and a deep reply chain must still appear in initial HTML.
  for (let revision = 2; revision <= 36; revision++)
    db.prepare(
      "INSERT INTO report_revisions SELECT report_id,?,title,explanation,trusted_assumptions,tool_version_id,environment,evidence_url,limitations,created_at FROM report_revisions WHERE report_id=1 AND revision_no=1",
    ).run(revision);
  const time = new Date().toISOString();
  for (let n = 1; n <= 36; n++)
    db.prepare(
      "INSERT INTO report_comments(id,report_id,sequence_no,revision_no,author_id,reply_to_id,body,created_at) VALUES(?,1,?,1,'alice',?,?,?)",
    ).run(
      "ssr-comment-" + n,
      n,
      n === 1 ? null : "ssr-comment-" + (n - 1),
      "Reply body " + n,
      time,
    );
  db.exec(
    "UPDATE report_comments SET visibility='hidden' WHERE id='ssr-comment-4'; UPDATE report_comments SET deleted_at=created_at WHERE id='ssr-comment-5'",
  );
  const page = new JSDOM(
    await (
      await app.request("https://example.test/report/1?v=1", {}, env)
    ).text(),
  );
  assert.equal(
    page.window.document.querySelectorAll("#revision-history a").length,
    36,
  );
  assert.equal(page.window.document.querySelectorAll(".comment").length, 36);
  assert.match(
    page.window.document.querySelector("#discussion")!.textContent!,
    /Reply body 36/,
  );
  assert.doesNotMatch(
    page.window.document.querySelector("#discussion")!.textContent!,
    /Reply body [45](?!\d)/,
  );
  assert.equal(page.window.document.querySelector('a[rel="next"]'), null);
  page.window.close();
});

test("ordinary HTML forms preserve API CSRF, origin, ownership, idempotency and session guards", async () => {
  const { JSDOM } = await import("jsdom");
  const { db, env, request } = await fixture();
  assert.equal((await request("/reports", "POST", reportInput)).status, 201);
  const send = async (
    action: string,
    fields: Record<string, string>,
    user = "alice",
    origin = env.APP_ORIGIN,
  ) =>
    app.request(
      "https://example.test/_actions/" + action,
      {
        method: "POST",
        headers: {
          Cookie: "__Host-proofsr_session=" + user,
          Origin: origin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields),
      },
      env,
    );
  const read = await app.request(
    "https://example.test/report/1",
    { headers: { Cookie: "__Host-proofsr_session=alice" } },
    env,
  );
  const dom = new JSDOM(await read.text());
  const form =
    dom.window.document.querySelector<HTMLFormElement>("#comment-form")!;
  const fields = Object.fromEntries(
    Array.from(
      form.querySelectorAll<HTMLInputElement>('input[type="hidden"]'),
    ).map((input) => [input.name, input.value]),
  );
  fields.body = "Posted without JS <script>alert(1)</script>";
  fields.revision_no = "1";
  assert.equal(
    (await send("comment", { ...fields, _csrf: "wrong" })).status,
    403,
  );
  assert.equal(
    (await send("comment", fields, "alice", "https://evil.test")).status,
    403,
  );
  assert.equal((await send("comment", fields, "missing")).status, 401);
  const posted = await send("comment", fields);
  assert.equal(posted.status, 303, await posted.clone().text());
  assert.equal(posted.headers.get("location"), "/report/1?v=1#discussion");
  assert.equal((await send("comment", fields)).status, 303);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM report_comments").get()!.n,
    1,
  );
  const cm = db.prepare("SELECT * FROM report_comments").get()!;
  const edited = {
    _csrf: "csrf",
    _back: "/report/1",
    id: String(cm.id),
    edit_version: String(cm.edit_version),
    body: "Edited without JS",
  };
  assert.equal((await send("edit-comment", edited, "bob")).status, 403);
  assert.equal((await send("edit-comment", edited)).status, 303);
  assert.equal(
    db.prepare("SELECT body FROM report_comments").get()!.body,
    "Edited without JS",
  );
  assert.equal(
    (await send("preferences", { _csrf: "csrf", replies: "on" })).status,
    303,
  );
  assert.equal(
    db
      .prepare(
        "SELECT replies FROM notification_preferences WHERE user_id='alice'",
      )
      .get()!.replies,
    1,
  );
  const star = await send("star", {
    _csrf: "csrf",
    _back: "//evil.test",
    kind: "report",
    id: "1",
    on: "true",
  });
  assert.equal(star.status, 303);
  assert.equal(star.headers.get("location"), "/");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM report_stars").get()!.n, 1);
  const logout = await send("logout", { _csrf: "csrf" });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get("set-cookie")!, /proofsr_session=/);
  dom.window.close();
});

test("HTML includes all crate versions, API items, report claims, tool versions and tokens beyond page size", async () => {
  const { JSDOM } = await import("jsdom");
  const { db, env, request } = await fixture();
  const time = new Date().toISOString();
  for (let i = 0; i < 36; i++) {
    const id = "bounded-api-" + i;
    db.prepare(
      "INSERT INTO api_items(id,release_id,canonical_key,display_path,kind,is_unsafe,signature,upstream_url) VALUES(?,1,?,?,'function',0,'pub fn verify()','https://docs.rs')",
    ).run(id, id, "sample::verify_" + i);
    db.prepare(
      "INSERT INTO tool_versions(id,tool_id,version,selectable) VALUES(?,'kani',?,1)",
    ).run("bounded-tool-" + i, "1.0." + i);
    db.prepare(
      "INSERT INTO api_tokens(id,user_id,token_hash,scope,created_at,expires_at) VALUES(?,'alice',?,'publish',?,?)",
    ).run(
      "bounded-token-" + i,
      "token-hash-" + i,
      time,
      new Date(Date.now() + 86400000).toISOString(),
    );
  }
  assert.equal((await request("/reports", "POST", reportInput)).status, 201);
  for (let i = 0; i < 36; i++) {
    const id = "bounded-claim-" + i;
    db.prepare(
      "INSERT INTO claims(id,report_id,api_item_id,property,created_at) VALUES(?,1,?,'no_ub',?)",
    ).run(id, "bounded-api-" + i, time);
    db.prepare(
      "INSERT INTO claim_revisions SELECT ?,report_id,report_revision,?,title,precondition,explanation,trusted_assumptions,evidence_url,limitations FROM claim_revisions WHERE report_id=1 AND position=0",
    ).run(id, i + 1);
  }
  for (let i = 0; i < 36; i++) {
    const release = i + 2;
    db.prepare(
      "INSERT INTO releases(id,crate_id,version,checksum,yanked,created_at) VALUES(?,1,?,'checksum',0,?)",
    ).run(release, "1.0." + (i + 1), time);
    db.prepare(
      "INSERT INTO reports(id,release_id,author_id,visibility,withdrawn_at,created_at,updated_at,create_key) SELECT ?,?,author_id,visibility,withdrawn_at,created_at,updated_at,? FROM reports WHERE id=1",
    ).run(i + 2, release, "bounded-report-" + i);
    db.prepare(
      "INSERT INTO report_revisions SELECT ?,revision_no,title,explanation,trusted_assumptions,tool_version_id,environment,evidence_url,limitations,created_at FROM report_revisions WHERE report_id=1",
    ).run(i + 2);
  }
  const read = async (path: string) =>
    new JSDOM(
      await (
        await app.request(
          "https://example.test" + path,
          { headers: { Cookie: "__Host-proofsr_session=alice" } },
          env,
        )
      ).text(),
    );
  const crate = await read("/crate/sample?version=1.0.0");
  assert.equal(
    crate.window.document.querySelectorAll(
      'details a[href^="/crate/sample?version="]',
    ).length,
    37,
  );
  assert.equal(
    crate.window.document.querySelectorAll('a[href^="/api/bounded-api-"]')
      .length,
    36,
  );
  const report = await read("/report/1");
  assert.equal(
    report.window.document.querySelectorAll(
      '.report-api-claims a[href^="/claim/bounded-claim-"]',
    ).length,
    36,
  );
  const tool = await read("/tool/kani");
  assert.equal(
    tool.window.document.querySelectorAll('a[href^="/tool-version/"]').length,
    37,
  );
  const settings = await read("/settings");
  assert.equal(
    settings.window.document.querySelectorAll('form[action="/_actions/revoke"]')
      .length,
    36,
  );
  for (const dom of [crate, report, tool, settings]) dom.window.close();
});

test("signup and CLI approval complete through HTML forms and return session cookies", async () => {
  const { JSDOM } = await import("jsdom");
  const { db, env } = await fixture();
  const origin = env.APP_ORIGIN;
  const time = new Date().toISOString();
  db.prepare("INSERT INTO pending_signups VALUES(?,?,?,?,?,?)").run(
    await hash("pending-html"),
    JSON.stringify({
      user: { id: 999, login: "html-user" },
      email: { email: "html@example.test", verified: true, primary: true },
      emailsOK: true,
    }),
    "signup-csrf",
    "/book/concepts",
    time,
    new Date(Date.now() + 600000).toISOString(),
  );
  const signup = await app.request(
    origin + "/signup",
    { headers: { Cookie: "__Host-proofsr_signup=pending-html" } },
    env,
  );
  assert.equal(signup.status, 200);
  const dom = new JSDOM(await signup.text());
  assert.equal(
    dom.window.document
      .querySelector('form[action="/_actions/signup"] input[name="_csrf"]')!
      .getAttribute("value"),
    "signup-csrf",
  );
  const completed = await app.request(
    origin + "/_actions/signup",
    {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: "__Host-proofsr_signup=pending-html",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: "signup-csrf",
        terms_version: "test",
      }),
    },
    env,
  );
  assert.equal(completed.status, 303, await completed.clone().text());
  assert.equal(completed.headers.get("location"), "/book/concepts");
  assert.match(completed.headers.get("set-cookie")!, /__Host-proofsr_session=/);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM pending_signups").get()!.n,
    0,
  );
  const codeResponse = await app.request(
    origin + "/auth/device/code",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "proofs-cli", scope: "publish" }),
    },
    env,
  );
  const code: any = await codeResponse.json();
  assert.equal(codeResponse.status, 200);
  const inspect = await app.request(
    origin + "/device?code=" + encodeURIComponent(code.user_code),
    { headers: { Cookie: "__Host-proofsr_session=alice" } },
    env,
  );
  assert.equal(inspect.status, 200, await inspect.clone().text());
  assert.match(await inspect.text(), /Authorize/);
  const approved = await app.request(
    origin + "/_actions/device",
    {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: "__Host-proofsr_session=alice",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: "csrf", user_code: code.user_code }),
    },
    env,
  );
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.match(await approved.text(), /CLI connected/);
  assert.equal(
    db.prepare("SELECT state FROM device_authorizations").get()!.state,
    "approved",
  );
  dom.window.close();
});
