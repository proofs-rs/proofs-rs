import sanitizeHtml from "sanitize-html";
import { importedPosts } from "./blog-posts";
import { renderMarkdown } from "./markdown";

type Post = (typeof importedPosts)[number];
const revision = "083c58bec59ada5ab1da48b5b075b2e0c41b8572";
const repo = "https://github.com/proofs-rs/lean-miri";
const example = (path: string) => `${repo}/blob/${revision}/examples/${path}`;
const wpSlug = "lean-miri-weakest-preconditions";
const wp = {
  slug: wpSlug,
  title: "Weakest preconditions for Rust MIR in lean-miri",
  description:
    "Generate Lean proof obligations from imported Rust MIR, including branches, loops, and calls, without hand-encoding the control-flow graph.",
  author: "Yuichi Nishiwaki",
  published: "2026-11-26",
  original: "",
  guid: `https://proofs.rs/blog/${wpSlug}`,
  html: renderMarkdown(
    `Earlier lean-miri examples showed that you could prove Rust safety properties in Lean using Miri's execution model. The new weakest-precondition (WP) path makes that work more direct: it takes a Rust function's imported MIR and turns it into Lean proof obligations. You choose what to prove and which inputs and machine states are admitted; the generator follows the function's control flow for you.

# From a Rust function to Lean goals

Suppose you want to show that a function never triggers undefined behavior (UB) under particular calling conditions. A weakest precondition describes the starting states from which the allowed executions satisfy the postconditions you chose. A success postcondition can say something about the return value or memory. A failure postcondition can rule out a UB diagnostic while permitting a non-UB stop such as resource exhaustion.

The [whole-body example](${example("body_vcgen/README.md")}) uses Rust's compiled MIR for \`count_up\`, including a branch, a loop, and a call to \`increment\`. The generator reads the graph and resolves available callees from the imported program. Forward steps can be substituted; cyclic edges use shared conditions, so the proof doesn't have to unroll the loop. For a cyclic proof you supply predicates indexed by location and discharge the generated entry, exit, preservation, and fallback obligations. The obligations are tied to the interpreter's step rules, not to a second Rust execution model.

# What changed in practice

The [mutable argument example](${`${repo}/pull/94`}) goes through call preparation and checks the boundary as well as the body. In the checked instance, a callee writes \`42\` through a mutable argument and returns \`7\`; the proof checks protector cleanup and resumes the caller, where a later store writes \`99\`. This demonstrates why pulling the call boundary into the proof matters: reasoning about the callee's return value alone would miss whether the caller can continue using its memory.

The [duplicate_prefix example](${example("duplicate_prefix_vcgen/README.md")}) shows both sides. It checks concrete entries for the copy and an adversarial caller whose copy would disable a protected shared tag. The latter can enter the body but still reaches UB on the write. The example illustrates why the admitted calling states matter, not that a proof automatically covers every possible input.

# What it does not do

Generating obligations isn't the same as solving them. Loop invariants, contracts, and assumptions about the modeled machine still need to be supplied or proved. The whole-body no-UB condition is about permitted finite outcomes; it does not prove termination. The examples cover their stated profiles, not arbitrary Rust programs, and this is an improvement to how proofs are written, not a measured speed claim.

Start with [the whole-body walkthrough](${example("body_vcgen/README.md")}) or browse the [lean-miri project page](https://proofs-rs.github.io/lean-miri/).`,
    1,
  ),
};

export const blogPosts: readonly Post[] = [wp, ...importedPosts];
export function blogPath(slug: string) {
  return `/blog/${slug}`;
}
export const blogAliases: ReadonlyMap<string, string> = new Map([
  [
    "how-anneal-uses-lean-miri",
    "how-google-s-zerocopy-project-uses-lean-miri-to-verify-unsafe-rust",
  ],
]);

const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

function articleHTML(post: Post) {
  return sanitizeHtml(post.html, {
    allowedTags: [
      "p",
      "u",
      "a",
      "h2",
      "h3",
      "strong",
      "em",
      "pre",
      "code",
      "ol",
      "ul",
      "li",
      "blockquote",
      "br",
    ],
    allowedAttributes: { a: ["href", "title"], code: ["class"], ol: ["start"] },
    allowedSchemes: ["https", "http", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => {
        const url = attribs.href;
        const old = blogPosts.find(
          (candidate) => candidate.original && candidate.original === url,
        );
        return {
          tagName,
          attribs: old ? { ...attribs, href: blogPath(old.slug) } : attribs,
        };
      },
    },
  });
}

function byline(post: Post) {
  return `<p class="meta">${xml(post.author)} · <time datetime="${xml(post.published)}">${xml(post.published.slice(0, 10))}</time></p>`;
}
export function blogIndex() {
  return `<section class="report-section"><h1>proofs.rs blog</h1><p>Updates on Rust formal verification and the tools we build.</p><p><a href="/blog/rss.xml">RSS feed</a></p>${blogPosts.map((post) => `<article><h2><a href="${blogPath(post.slug)}">${xml(post.title)}</a></h2>${byline(post)}<p>${xml(post.description)}</p></article>`).join("")}</section>`;
}
export function blogArticle(post: Post) {
  return `<article class="report-section"><p><a href="/blog">← Blog</a></p><h1>${xml(post.title)}</h1>${byline(post)}<div class="markdown-body">${articleHTML(post)}</div>${post.original ? `<p class="meta">Originally published on <a href="${xml(post.original)}">Hashnode</a>.</p>` : ""}</article>`;
}
export function blogRSS(origin: string) {
  const absolute = (path: string) => new URL(path, origin).href;
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>proofs.rs blog</title><link>${xml(absolute("/blog"))}</link><description>Updates on Rust formal verification and the tools we build.</description><language>en</language><atom:link href="${xml(absolute("/blog/rss.xml"))}" rel="self" type="application/rss+xml"/>${blogPosts.map((post) => `<item><title>${xml(post.title)}</title><link>${xml(absolute(blogPath(post.slug)))}</link><guid isPermaLink="false">${xml(post.guid)}</guid><dc:creator>${xml(post.author)}</dc:creator><pubDate>${new Date(post.published).toUTCString()}</pubDate><description>${xml(post.description)}</description><content:encoded>${xml(articleHTML(post).replace(/href="(\/blog\/[^"]+)"/g, (_, path: string) => `href="${absolute(path)}"`))}</content:encoded></item>`).join("")}</channel></rss>`,
    {
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
