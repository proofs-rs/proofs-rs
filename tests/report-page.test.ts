import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
for (const loggedIn of [false, true])
  test(`report renders before history and requests past revision directly (logged in: ${loggedIn})`, async () => {
    const dom = new JSDOM('<main id="app"></main>', {
      url: "https://example.test/#/report/1?v=1",
      runScripts: "outside-only",
    });
    const w = dom.window as any;
    let resolveHistory: (value: any) => void;
    const history = new Promise((resolve) => (resolveHistory = resolve));
    const calls: string[] = [];
    w.request = async (path: string) => {
      calls.push(path);
      if (path === "/reports/1/revisions") return history;
      assert.equal(path, "/reports/1/revisions/1");
      return {
        id: 1,
        title: "Report body",
        revision_no: 1,
        latest_revision_no: 2,
        claims: [],
        run_ids: [],
        comment_count: 0,
      };
    };
    w.loadComments = async (_id: any, _parent: any, box: any) => {
      box.textContent = "Comments loaded";
    };
    w.loggedIn = loggedIn;
    const source = readFileSync(
      new URL("../web/main.ts", import.meta.url),
      "utf8",
    );
    const report = source.slice(
      source.indexOf("async function reportPage("),
      source.indexOf("async function loadComments("),
    );
    const setup = `const config={show_star_karma:false};const root=document.querySelector('#app'); const me={user:loggedIn?{id:'bob'}:null};let commentReply=null;const current=()=>new URL('https://example.test/?v=1');const enc=encodeURIComponent;const esc=(x)=>String(x??'');const reportContent=(c)=>'<h1>'+c.title+'</h1>';const user=()=>'';const date=()=>'';const reproduceSection=()=>'';const claimItem=()=>'';const reportBody=()=>'';const reportAPIs=()=>'';const breadcrumbs=()=>'';const crateCrumbs=()=>[];const notice='';const bindReproduce=()=>{};const bindStars=()=>{};const bind=()=>{};`;
    w.eval(
      transpileModule(setup + report + ";window.finished=reportPage(1);", {
        compilerOptions: {
          module: ModuleKind.None,
          target: ScriptTarget.ES2022,
        },
      }).outputText,
    );
    await w.finished;
    assert.match(w.document.querySelector("h1").textContent, /Report body/);
    assert.match(
      w.document.querySelector("#comments").textContent,
      /Comments loaded/,
    );
    assert.deepEqual(calls, ["/reports/1/revisions/1", "/reports/1/revisions"]);
    resolveHistory!({
      items: [{ revision_no: 2 }, { revision_no: 1 }],
      next_cursor: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(w.document.querySelectorAll("#revision-history a").length, 2);
    if (loggedIn)
      assert.equal(w.document.querySelector("[name=revision_no]").value, "1");
    dom.window.close();
  });

test("report body removes redundant labels and groups claims by API with revision links", async () => {
  const ts = await import("typescript");
  const source = readFileSync(
    new URL("../web/main.ts", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "main.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = [
    "reportContent",
    "reportBody",
    "reportDependencies",
    "reportAPIs",
    "toolLimitations",
    "toolLink",
  ];
  const functions = ast.statements
    .filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name!.text))
    .map((n) => n.getText(ast))
    .join("\n");
  const { renderAPICatalog } = await import("../web/api-catalog");
  const dom = new JSDOM("<main></main>", { runScripts: "outside-only" });
  const w = dom.window as any;
  w.renderAPICatalog = renderAPICatalog;
  const reproductionSource = ts.createSourceFile(
    "reproduce.ts",
    readFileSync(new URL("../web/reproduce.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const reproductionSection = reproductionSource.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "reproduceSection",
  )!;
  w.eval(
    ts.transpileModule(
      reproductionSection.getText(reproductionSource).replace("export ", ""),
      { compilerOptions: { module: ts.ModuleKind.None } },
    ).outputText,
  );
  w.c = {
    title: "Report",
    crate: "sample",
    version: "1.0.0",
    tool: "Verifier",
    tool_version: "1",
    tool_version_id: "v",
    explanation: "Body <script>unsafe</script>",
    trusted_assumptions: "Assume A",
    limitations: "Report limit",
    tool_limitations: "Tool limit",
    environment: "Machine details",
    run_ids: ["run-1"],
    evidence_url: "https://example.test/evidence",
    claims: [1, 2, 3].map((n) => ({
      id: "claim-" + n,
      api_item_id: "api-1",
      display_path: "sample::decode",
      kind: "function",
      signature: "pub fn decode()",
      claim_number: n,
      report_revision: 3,
      title: "Claim " + n,
      property: n <= 2 ? "panic_contract" : "no_ub",
      star_count: 0,
      precondition: "input is valid",
      explanation: "Claim explanation",
    })),
  };
  const setup = `const enc=encodeURIComponent;const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');const prop=p=>p==='no_ub'?'No undefined behavior':'Panic contract';const date=v=>v;`;
  w.eval(
    ts.transpileModule(
      setup +
        reproductionSection.getText(reproductionSource).replace("export ", "") +
        functions +
        `;document.querySelector('main').innerHTML=reportContent(c)+reportBody(c)+reportAPIs(c);`,
      {
        compilerOptions: {
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
  );
  const d = w.document;
  assert.equal(d.querySelector('a[href^="#/crate/"]'), null);
  assert.equal(
    d.querySelector(".report-explanation").textContent,
    "Body <script>unsafe</script>",
  );
  assert.equal(d.querySelector("script"), null);
  assert.equal(d.querySelector("dt"), null);
  assert.equal(d.querySelector(".report-environment").tagName, "DETAILS");
  assert.equal(d.querySelector(".report-environment").open, false);
  assert.equal(
    d.querySelector(".report-environment").parentElement.id,
    "reproduce",
  );
  assert.equal(
    d.querySelector("#reproduce").parentElement.className,
    "report-section report-evidence",
  );
  assert.equal(
    d
      .querySelector(".report-explanation")
      .nextElementSibling.querySelector("h2").textContent,
    "Evidence",
  );
  assert.equal(d.querySelector(".api-claim-count"), null);
  assert.equal(d.querySelector(".catalog-columns"), null);
  assert(!d.body.textContent.includes("Preconditions"));
  assert.match(
    d.querySelector(".report-limitations").textContent,
    /Report limit.*Tool limit/s,
  );
  assert.equal(
    d.querySelector(".report-apis h2").textContent,
    "Verified APIs (1)",
  );
  assert.equal(d.querySelectorAll('a[href="#/api/api-1"]').length, 1);
  assert.equal(d.querySelectorAll(".report-api-claim").length, 2);
  assert.equal(
    d.querySelectorAll(".catalog-row > .report-api-claims").length,
    1,
  );
  assert.equal(d.querySelector(".report-api-claim a").textContent, "Claim #1");
  assert(!d.querySelector(".report-api-claims").textContent.includes("stars"));
  assert(
    !d.querySelector(".report-api-claims").textContent.includes("Claim 1"),
  );
  assert.equal(d.querySelectorAll('a[href$="?report_revision=3"]').length, 3);
  assert.equal(
    d.querySelector(".report-api-claim").textContent,
    "Panic contractClaim #1, Claim #2",
  );
  assert(
    ![...d.querySelectorAll("h2")].some((n: any) =>
      n.textContent.startsWith("Claims"),
    ),
  );
  assert(!d.body.textContent.includes("Shared"));
  dom.window.close();
});

test("reviewed dependencies keep pinned evidence links, current withdrawal, and author attribution", () => {
  const source = readFileSync(
    new URL("../web/main.ts", import.meta.url),
    "utf8",
  );
  const dependencyFunction = source.slice(
    source.indexOf("function reportDependencies("),
    source.indexOf("function reportAPIs("),
  );
  const dom = new JSDOM("<main></main>", { runScripts: "outside-only" });
  const w = dom.window as any;
  w.eval(
    transpileModule(
      `const enc=encodeURIComponent;const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');` +
        dependencyFunction +
        `;window.render=c=>{document.querySelector('main').innerHTML=reportDependencies(c)};`,
      {
        compilerOptions: {
          module: ModuleKind.None,
          target: ScriptTarget.ES2022,
        },
      },
    ).outputText,
  );
  for (const c of [{}, { dependencies: [] }]) {
    w.render(c);
    assert.equal(
      w.document.querySelector("h2").textContent,
      "Reviewed dependencies (0)",
    );
    assert.match(
      w.document.body.textContent,
      /No reviewed dependencies declared/,
    );
  }
  w.render({
    dependencies: [
      {
        crate: "dependency<script>",
        version: "1.2.3",
        report: 10,
        revision: 2,
        withdrawn: false,
      },
      {
        crate: "withdrawn",
        version: "2.0.0",
        report: 11,
        revision: 1,
        withdrawn: true,
      },
      {
        crate: "private",
        version: "3.0.0",
        report: null,
        revision: null,
        withdrawn: true,
      },
    ],
  });
  assert.equal(
    w.document.querySelector("h2").textContent,
    "Reviewed dependencies (3)",
  );
  assert.equal(w.document.querySelectorAll("li").length, 3);
  assert.equal(
    w.document.querySelector("a").getAttribute("href"),
    "#/report/10?v=2",
  );
  assert.equal(w.document.querySelector("script"), null);
  assert.match(w.document.body.textContent, /dependency<script> 1\.2\.3/);
  assert.match(
    w.document.body.textContent,
    /Evidence report currently withdrawn/,
  );
  assert.match(w.document.body.textContent, /Evidence unavailable/);
  assert.match(w.document.body.textContent, /report author declares/);
  assert.match(
    w.document.body.textContent,
    /not independent certification by proofs.rs/,
  );
  dom.window.close();
});

test("report comments fetch every page and reply without a More button", async () => {
  const source = readFileSync(
    new URL("../web/main.ts", import.meta.url),
    "utf8",
  );
  const fn = source.slice(
    source.indexOf("async function loadComments("),
    source.indexOf("function renderComment("),
  );
  const dom = new JSDOM("<main></main>", { runScripts: "outside-only" });
  const w = dom.window as any;
  const calls: string[] = [];
  w.request = async (path: string) => {
    calls.push(path);
    if (path.includes("parent_id"))
      return { items: [{ id: "reply", reply_count: 0 }], next_cursor: null };
    if (path.includes("cursor=0"))
      return { items: [{ id: "first", reply_count: 1 }], next_cursor: 20 };
    return { items: [{ id: "last", reply_count: 0 }], next_cursor: null };
  };
  w.eval(
    transpileModule(
      `const enc=encodeURIComponent; const renderComment=(cm,box)=>{const el=document.createElement('article');el.textContent=cm.id;box.append(el);return el;};` +
        fn +
        `;window.finished=loadComments(3,null,document.querySelector('main'));`,
      {
        compilerOptions: {
          module: ModuleKind.None,
          target: ScriptTarget.ES2022,
        },
      },
    ).outputText,
  );
  await w.finished;
  assert.equal(calls.length, 3);
  assert.equal(w.document.querySelectorAll("article").length, 3);
  assert.equal(w.document.querySelector("button"), null);
  dom.window.close();
});
