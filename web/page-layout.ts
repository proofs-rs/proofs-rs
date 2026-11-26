/** Page shell shared by the Worker and the bundled local preview server. */
export function pageLayout(
  title: string,
  body: string,
  account: string,
  canonical: string | null,
  external: (path: string) => string = (p) => p,
  preview = false,
  metadata?: {
    title: string;
    description: string;
    url: string;
    image: string;
    alt: string;
    type?: "website" | "article";
  },
) {
  const escape = (v: string) =>
    v.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · proofs.rs</title><meta name="description" content="${escape(metadata?.description ?? "Rust API verification reports, claims and evidence.")}">${
    metadata && !preview
      ? `<meta property="og:type" content="${metadata.type ?? "article"}"><meta property="og:site_name" content="proofs.rs">${[
          ["og:title", metadata.title],
          ["og:description", metadata.description],
          ["og:url", metadata.url],
          ["og:image", metadata.image],
          ["og:image:alt", metadata.alt],
          ["og:image:width", "1200"],
          ["og:image:height", "630"],
        ]
          .map(
            ([name, value]) =>
              `<meta property="${name}" content="${escape(value)}">`,
          )
          .join("")}<meta name="twitter:card" content="summary_large_image">${[
          ["twitter:title", metadata.title],
          ["twitter:description", metadata.description],
          ["twitter:image", metadata.image],
          ["twitter:image:alt", metadata.alt],
        ]
          .map(
            ([name, value]) =>
              `<meta name="${name}" content="${escape(value)}">`,
          )
          .join("")}`
      : ""
  }${canonical ? `<link rel="canonical" href="${escape(canonical)}">` : '<meta name="robots" content="noindex,nofollow">'}<script src="/theme.js"></script><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/theme-a.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/theme-header.css"><link rel="icon" href="/favicon.svg"><script src="/site.js" defer></script></head><body><header class="proofs-site-header"><a class="brand" href="/">proofs.rs</a><nav aria-label="Main navigation"><a href="${escape(external("/crates"))}">Crates</a><a href="${escape(external("/reports"))}">Reports</a><a href="${escape(external("/tools"))}">Tools</a><a href="${escape(external("/book/"))}">Docs</a><a href="${escape(external("/blog"))}">Blog</a><a href="https://proofs-rs.zulipchat.com/" class="external">Zulip<span class="external-mark" aria-hidden="true">↗</span></a></nav><div id="account-nav">${account}</div></header><main id="app">${preview ? '<p role="status"><strong>Local preview — not published</strong></p>' : ""}${body}</main><footer>© 2026 proofs.rs · <a href="${escape(external("/book/"))}">About</a> · <a href="https://github.com/proofs-rs/proofs-rs">GitHub</a> · <a href="${escape(external("/privacy"))}">Privacy</a> · <a href="${escape(external("/terms"))}">Terms</a> · <a href="${escape(external("/contact"))}">Help &amp; feedback</a></footer></body></html>`;
}
