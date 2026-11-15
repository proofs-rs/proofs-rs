import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderMarkdown } from "../src/markdown";
import { createViews } from "../src/site-views";

test("Markdown supports prose, tables, code, and relative heading levels", () => {
  const source =
    '# First\n\nSecond\n------\n\n###### Deep\n\n**bold** *italic* ~~old~~ `code`\nnext\n\n- item\n\n> quote\n\n```rust\nlet x = "<tag>";\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[link](https://example.com)';
  for (const parent of [1, 2] as const) {
    const d = new JSDOM(renderMarkdown(source, parent)).window.document;
    assert.equal(d.querySelector(`h${parent + 1}`)?.textContent, "First");
    assert.equal(d.querySelector(`h${parent + 2}`)?.textContent, "Second");
    assert.equal(d.querySelector("h6")?.textContent, "Deep");
    for (const tag of [
      "strong",
      "em",
      "s",
      "code",
      "br",
      "li",
      "blockquote",
      "pre",
      "table",
      "a",
    ])
      assert.ok(d.querySelector(tag), tag);
    assert.equal(
      d.querySelector("pre code")?.textContent,
      'let x = "<tag>";\n',
    );
    assert.equal(d.querySelector("h1"), null);
  }
  assert.equal(renderMarkdown("", 2), "");
});

test("untrusted Markdown cannot inject executable elements or attributes", () => {
  const payloads = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '<svg onload=alert(1)><a href="javascript:alert(1)">x</a></svg>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<a id="app" style="color:red" onclick="alert(1)">x</a>',
    "[x](javascript:alert%281%29)",
    "[x](JaVaScRiPt:alert%281%29)",
    "[x](jav&#x61;script:alert%281%29)",
    "[x](vbscript:alert%281%29)",
    "[x](data:text/html;base64,PHNjcmlwdD4=)",
    "[x](file:///etc/passwd)",
    "[x](//evil.example)",
    "![x](https://evil.example/track.png)",
    '[x](https://example.com "&quot; onmouseover=&quot;alert(1)")',
    '```"><img src=x onerror=alert(1)>\n<script>x</script>\n```',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
  ];
  for (const source of payloads) {
    const d = new JSDOM(renderMarkdown(source, 2)).window.document;
    assert.equal(
      d.querySelector("script,img,svg,math,iframe,style,form,input"),
      null,
      source,
    );
    for (const el of d.body.querySelectorAll("*")) {
      for (const attr of el.attributes)
        assert.ok(["href", "title", "start"].includes(attr.name), source);
      const href = el.getAttribute("href");
      if (href) assert.match(href, /^(https?:|mailto:|\/(?!\/)|#)/i, source);
    }
  }
});

test("report and claim prose use contextual headings while code stays literal", () => {
  const views = createViews({ user: null }, {}, () => "");
  const c = {
    title: "# Literal",
    explanation: "# Intro",
    trusted_assumptions: "# Trust",
    limitations: "# Limits",
    environment: "# Environment",
    shared_trusted_assumptions: "# Shared trust",
    shared_limitations: "# Shared limits",
    precondition: "# Literal condition",
    signature: "fn f()",
    tool_limitations: "# Literal tool",
  };
  const report = new JSDOM(views.reportContent(c) + views.reportBody(c)).window
    .document;
  assert.equal(report.querySelector("h1")?.textContent, "# Literal");
  assert.equal(report.querySelector(".report-explanation"), null);
  assert.deepEqual(
    [...report.querySelectorAll(".markdown-body h3")].map((x) => x.textContent),
    ["Environment", "Trust", "Limits"],
  );
  const claim = new JSDOM(views.claimContent(c)).window.document;
  assert.equal(
    claim.querySelector(".report-explanation h3")?.textContent,
    "Intro",
  );
  assert.deepEqual(
    [...claim.querySelectorAll(".markdown-body h3")].map((x) => x.textContent),
    ["Intro", "Trust", "Shared trust", "Limits", "Shared limits"],
  );
  assert.equal(
    claim.querySelector(".plain-text.code")?.textContent,
    "# Literal condition",
  );
  assert.equal(
    claim.querySelector(".tool-limitations .plain-text")?.textContent,
    "# Literal tool",
  );
  assert.equal(
    new JSDOM(views.reportBody({})).window.document.querySelector(
      ".markdown-body",
    ),
    null,
  );
});

test("Overview separates author headings from preset sections and is omitted when empty", () => {
  const views = createViews({ user: null }, {}, () => "");
  for (const render of [views.claimContent]) {
    const d = new JSDOM(
      render({
        explanation: "# Parsing\n\n## Details\n\n# Evidence\n\nAuthor evidence",
        evidence_url: "https://example.com/evidence",
      }),
    ).window.document;
    const overview = d.querySelector("section.report-explanation")!;
    assert.equal(
      overview.querySelector(":scope > h2")?.textContent,
      "Overview",
    );
    assert.deepEqual(
      [...overview.querySelectorAll(".markdown-body h3")].map(
        (x) => x.textContent,
      ),
      ["Parsing", "Evidence"],
    );
    assert.equal(overview.querySelector("h4")?.textContent, "Details");
    assert.equal(
      overview.querySelector(".markdown-body h1, .markdown-body h2"),
      null,
    );
    // A claim leads with its explanation, before the preset sections.
    assert.equal(
      overview.nextElementSibling?.querySelector("h2")?.textContent,
      render === views.claimContent ? "Preconditions" : "Evidence",
    );
    for (const explanation of [undefined, ""]) {
      assert.equal(
        new JSDOM(render({ explanation })).window.document.querySelector(
          ".report-explanation",
        ),
        null,
      );
    }
  }
});
