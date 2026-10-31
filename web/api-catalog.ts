export interface CatalogAPI {
  id: string;
  display_path: string;
  kind: string;
  signature: string;
  is_unsafe: number | null;
  origin?: "rustdoc" | "recorded";
  category?: string | null;
  trait_path?: string | null;
  self_type?: string | null;
  method_name?: string | null;
  is_blanket?: number | null;
  claim_count: number;
  // Valid findings that name this API; only the crate page supplies it.
  finding_count?: number;
}
const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function describe(a: CatalogAPI) {
  // Old catalogues remain navigable until their archived rustdoc is refreshed.
  const legacy = a.display_path.match(/^<(.+) as (.+)>::([^:]+)$/);
  const method = a.method_name || a.display_path.split("::").at(-1)!;
  return {
    api: a,
    category:
      (a.origin === "recorded" ? "recorded" : null) ||
      (a.category === "trait" && a.trait_path && a.self_type == null && !legacy
        ? "trait-declaration"
        : a.category) ||
      (legacy
        ? "trait"
        : a.kind === "function"
          ? "function"
          : /\(\s*(?:&\s*(?:'\w+\s+)?(?:mut\s+)?)?self\b/.test(a.signature)
            ? "method"
            : "associated"),
    trait: a.trait_path || legacy?.[2] || "",
    self:
      a.self_type ||
      legacy?.[1] ||
      a.display_path.slice(0, -(method.length + 2)),
    method,
    blanket: a.is_blanket === 1,
  };
}
const kindLabels: Record<string, string> = {
  function: "Function",
  associated: "Associated function",
  method: "Method",
  trait: "Trait method",
  "trait-declaration": "Trait method",
};
export function apiKindLabel(a: CatalogAPI) {
  return a.origin === "recorded"
    ? "Recorded callable"
    : (kindLabels[describe(a).category] ?? "Function");
}
// The declaration line of a signature, without any `impl … for …` header.
function declaration(signature: string) {
  const lines = signature.split("\n").map((line) => line.trim());
  return lines.find((line) => /\bfn\b/.test(line)) ?? lines.at(-1) ?? "";
}
// Escaped signature with the function name marked, as in rustdoc's item-decl.
export function signatureHTML(signature: string) {
  return esc(signature).replace(
    /\bfn (\w+)/,
    'fn <span class="fn-name">$1</span>',
  );
}
// Item path with the module prefix separated from the item name.
export function itemPathHTML(path: string) {
  const i = path.lastIndexOf("::");
  return i < 0
    ? `<span class="item-name">${esc(path)}</span>`
    : `<span class="path-prefix">${esc(path.slice(0, i + 2))}</span><span class="item-name">${esc(path.slice(i + 2))}</span>`;
}
export function renderAPICatalog(
  apis: CatalogAPI[],
  crate: string,
  options: {
    hideEmpty?: boolean;
    hideCounts?: boolean;
    expandFamilies?: boolean;
    details?: (api: CatalogAPI) => string;
    apiHref?: (id: string) => string | null;
  } = {},
): string {
  const href =
    options.apiHref ?? ((id: string) => `/api/${encodeURIComponent(id)}`);
  const prefix = crate.replaceAll("-", "_") + "::";
  const local = (s: string) =>
    s.startsWith(prefix) ? s.slice(prefix.length) : s;
  const unsafe = (yes: boolean) =>
    yes ? '<strong class="unsafe">unsafe</strong> ' : "";
  const claimCounts = (
    a: Pick<CatalogAPI, "claim_count" | "finding_count"> & { id?: string },
  ) => {
    if (options.hideCounts) return "";
    const text = a.claim_count
      ? `${a.claim_count} claim${a.claim_count === 1 ? "" : "s"}`
      : "";
    const findings = a.finding_count
      ? `<a href="#findings">${a.finding_count} finding${a.finding_count === 1 ? "" : "s"}</a>`
      : "";
    return `<span class="api-claim-count${text || findings ? "" : " muted"}">${text && a.id && href(a.id) ? `<a href="${esc(href(a.id)!)}#claims">${text}</a>` : text || (findings ? "" : "—")}${text && findings ? " · " : ""}${findings}</span>`;
  };
  const link = (a: CatalogAPI, text: string) =>
    href(a.id)
      ? `<a class="api-name" href="${esc(href(a.id)!)}">${esc(text)}</a>`
      : `<span class="api-name">${esc(text)} (unverified)</span>`;
  // As in rustdoc's impl blocks, the declaration itself is the row, with
  // the item name as its link; rows without a usable declaration keep a label.
  const declared = (a: CatalogAPI, text: string) => {
    const line = declaration(a.signature);
    const name = line.match(/\bfn\s+\w+/);
    if (!name) return "";
    let before = esc(line.slice(0, name.index));
    if (/\bunsafe\b/.test(before))
      before = before.replace(
        /\bunsafe\b/,
        '<strong class="unsafe">unsafe</strong>',
      );
    else if (a.is_unsafe) before += '<strong class="unsafe">unsafe</strong> ';
    return `<code class="api-signature">${before}fn ${link(a, text)}${esc(line.slice(name.index! + name[0].length))}</code>`;
  };
  const label = (a: CatalogAPI, text: string, keyword: string) =>
    `<span class="api-label">${unsafe(!!a.is_unsafe)}<span class="api-keyword">${keyword}</span>${link(a, text)}</span>`;
  const row = (a: CatalogAPI, text: string, keyword = "fn ") =>
    `<div class="catalog-row" data-api-path="${esc(a.display_path)}" data-claims="${a.claim_count}"${a.finding_count === undefined ? "" : ` data-findings="${a.finding_count}"`}><span>${a.origin === "recorded" ? `${link(a, local(a.display_path))} <span class="meta">recorded callable · signature and safety not recorded</span>` : (keyword && declared(a, text)) || label(a, text, keyword)}</span>${options.details ? options.details(a) : claimCounts(a)}</div>`;
  const data = apis
    .map(describe)
    .sort(
      (a, b) =>
        cmp(a.api.display_path, b.api.display_path) || cmp(a.api.id, b.api.id),
    );
  function section(title: string, content: string, empty: string) {
    if (!content && options.hideEmpty) return "";
    return `<section class="api-category"><h3>${title}</h3>${content || `<p class="muted">${empty}</p>`}</section>`;
  }
  function inherent(category: string, keyword = "impl ") {
    const groups = new Map<string, ReturnType<typeof describe>[]>();
    for (const a of data.filter((a) => a.category === category)) {
      if (!groups.has(a.self)) groups.set(a.self, []);
      groups.get(a.self)!.push(a);
    }
    return [...groups]
      .sort(([a], [b]) => cmp(a, b))
      .map(
        ([type, items]) =>
          `<section class="api-impl"><h4><code><span class="api-keyword">${keyword}</span><span class="${keyword === "trait " ? "kind-trait" : "kind-type"}">${esc(local(type))}</span></code></h4>${items
            .sort((a, b) => cmp(a.method, b.method))
            .map((a) => row(a.api, a.method))
            .join("")}</section>`,
      )
      .join("");
  }
  function traits(blanket: boolean) {
    const groups = new Map<string, ReturnType<typeof describe>[]>();
    for (const a of data.filter(
      (a) => a.category === "trait" && a.blanket === blanket,
    )) {
      if (!groups.has(a.trait)) groups.set(a.trait, []);
      groups.get(a.trait)!.push(a);
    }
    return [...groups]
      .sort(([a], [b]) => cmp(a, b))
      .map(([trait, items]) => {
        const types = new Set(items.map((a) => a.self));
        const methods = new Map<string, typeof items>();
        for (const a of items) {
          if (!methods.has(a.method)) methods.set(a.method, []);
          methods.get(a.method)!.push(a);
        }
        const body = [...methods]
          .sort(([a], [b]) => cmp(a, b))
          .map(([name, impls]) => {
            if (impls.length === 1) return row(impls[0].api, name);
            const counts = impls.reduce(
              (sum, a) => ({
                claim_count: sum.claim_count + a.api.claim_count,
              }),
              { claim_count: 0 },
            );
            return `<details class="api-family"${options.expandFamilies ? " open" : ""}><summary><span>${unsafe(impls.some((a) => !!a.api.is_unsafe))}<span class="api-keyword">fn </span><code>${esc(name)}</code><span class="implementation-count">${impls.length} implementations</span></span>${claimCounts(counts)}</summary><div class="api-implementations">${impls
              .sort((a, b) => cmp(a.self, b.self) || cmp(a.api.id, b.api.id))
              .map((a) => row(a.api, `impl ${trait} for ${local(a.self)}`, ""))
              .join("")}</div></details>`;
          })
          .join("");
        return `<section class="api-impl"><h4><code><span class="api-keyword">impl </span><span class="kind-trait">${esc(trait)}</span><span class="api-keyword"> for </span><span class="kind-type">${types.size === 1 ? esc(local(items[0].self)) : "…"}</span></code></h4>${body}</section>`;
      })
      .join("");
  }
  if (!apis.length) return "<p>No APIs.</p>";
  const blanket = traits(true);
  return (
    (options.hideCounts
      ? ""
      : `<div class="catalog-columns"><span>API</span><span>${apis.some((a) => a.finding_count !== undefined) ? "Claims · findings" : "Claims"}</span></div>`) +
    section(
      "Functions",
      data
        .filter((a) => a.category === "function")
        .map((a) => row(a.api, local(a.api.display_path)))
        .join(""),
      "No functions.",
    ) +
    section(
      "Associated functions",
      inherent("associated"),
      "No associated functions.",
    ) +
    section("Methods", inherent("method"), "No inherent methods.") +
    (data.some((a) => a.category === "trait-declaration")
      ? section("Traits", inherent("trait-declaration", "trait "), "")
      : "") +
    section(
      "Trait implementations",
      traits(false),
      "No trait implementations.",
    ) +
    (blanket ? section("Blanket implementations", blanket, "") : "") +
    (data.some((a) => a.category === "recorded")
      ? section(
          "Recorded callables",
          data
            .filter((a) => a.category === "recorded")
            .map((a) => row(a.api, local(a.api.display_path), ""))
            .join(""),
          "",
        )
      : "")
  );
}
