import { prop } from "./properties";
export interface CatalogAPI {
  id: string;
  display_path: string;
  kind: string;
  signature: string;
  is_unsafe: number;
  category?: string | null;
  trait_path?: string | null;
  self_type?: string | null;
  method_name?: string | null;
  is_blanket?: number | null;
  panic_count: number;
  no_ub_count: number;
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
      a.category ||
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
export function renderAPICatalog(
  apis: CatalogAPI[],
  crate: string,
  options: {
    hideEmpty?: boolean;
    hideCounts?: boolean;
    expandFamilies?: boolean;
    details?: (api: CatalogAPI) => string;
  } = {},
): string {
  const prefix = crate.replaceAll("-", "_") + "::";
  const local = (s: string) =>
    s.startsWith(prefix) ? s.slice(prefix.length) : s;
  const unsafe = (yes: boolean) =>
    yes ? ' <strong class="unsafe">unsafe</strong>' : "";
  const claimCounts = (a: Pick<CatalogAPI, "panic_count" | "no_ub_count">) => {
    if (options.hideCounts) return "";
    const text = [
      a.panic_count ? `${esc(prop("panic_contract"))} (${a.panic_count})` : "",
      a.no_ub_count ? `${esc(prop("no_ub"))} (${a.no_ub_count})` : "",
    ]
      .filter(Boolean)
      .join(" / ");
    return `<span class="api-claim-count${text ? "" : " muted"}">${text || "—"}</span>`;
  };
  const link = (a: CatalogAPI, text: string) =>
    `<a class="api-name" href="/api/${encodeURIComponent(a.id)}">${esc(text)}</a>`;
  const row = (a: CatalogAPI, text: string, keyword = "fn ") =>
    `<div class="catalog-row"><span><span class="api-keyword">${keyword}</span>${link(a, text)}${unsafe(!!a.is_unsafe)}</span>${options.details ? options.details(a) : claimCounts(a)}</div>`;
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
  function inherent(category: string) {
    const groups = new Map<string, ReturnType<typeof describe>[]>();
    for (const a of data.filter((a) => a.category === category)) {
      if (!groups.has(a.self)) groups.set(a.self, []);
      groups.get(a.self)!.push(a);
    }
    return [...groups]
      .sort(([a], [b]) => cmp(a, b))
      .map(
        ([type, items]) =>
          `<section class="api-impl"><h4><code><span class="api-keyword">impl </span>${esc(local(type))}</code></h4>${items
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
                panic_count: sum.panic_count + a.api.panic_count,
                no_ub_count: sum.no_ub_count + a.api.no_ub_count,
              }),
              { panic_count: 0, no_ub_count: 0 },
            );
            return `<details class="api-family"${options.expandFamilies ? " open" : ""}><summary><span><span class="api-keyword">fn </span><code>${esc(name)}</code>${unsafe(impls.some((a) => !!a.api.is_unsafe))}<span class="implementation-count">${impls.length} implementations</span></span>${claimCounts(counts)}</summary><div class="api-implementations">${impls
              .sort((a, b) => cmp(a.self, b.self) || cmp(a.api.id, b.api.id))
              .map((a) => row(a.api, `impl ${trait} for ${local(a.self)}`, ""))
              .join("")}</div></details>`;
          })
          .join("");
        return `<section class="api-impl"><h4><code><span class="api-keyword">impl </span>${esc(trait)}<span class="api-keyword"> for </span>${types.size === 1 ? esc(local(items[0].self)) : "…"}</code></h4>${body}</section>`;
      })
      .join("");
  }
  if (!apis.length) return "<p>No APIs.</p>";
  const blanket = traits(true);
  return (
    (options.hideCounts
      ? ""
      : '<div class="catalog-columns"><span>API</span><span>Claims</span></div>') +
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
    section(
      "Trait implementations",
      traits(false),
      "No trait implementations.",
    ) +
    (blanket ? section("Blanket implementations", blanket, "") : "")
  );
}
