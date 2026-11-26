import { blogPath, blogPosts } from "./blog";
import MarkdownIt from "markdown-it";
export type SocialCard = {
  title: string;
  description: string;
  label: string;
  context: string;
  footer: string;
  path: string;
  type: "website" | "article";
  layout?: "home";
};
export type SocialGet = (path: string) => Promise<any>;
const markdown = new MarkdownIt({ html: false });
export function socialText(source: string, limit = 160): string {
  const tokens = markdown.parse(source || "", {});
  const text = tokens
    .flatMap((t) =>
      t.children
        ? t.children.map((c) =>
            c.type === "text" || c.type === "code_inline"
              ? c.content
              : c.type.endsWith("break")
                ? " "
                : "",
          )
        : t.type === "fence" || t.type === "code_block"
          ? [t.content]
          : [" "],
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : text;
}
const pages: Record<string, [string, string]> = {
  "/": [
    "Rust API Verification Reports",
    "Formal verification results for Rust crates, organized by crate, version and API. Explore claims, findings and evidence.",
  ],
  "/crates": [
    "Crates",
    "Explore Rust crates and their API verification reports, claims and evidence.",
  ],
  "/reports": [
    "Verification Reports",
    "Browse Rust API verification reports and the assumptions and evidence behind them.",
  ],
  "/tools": [
    "Verification Tools",
    "Explore tools used to verify Rust APIs, including Kani, Creusot and Aeneas.",
  ],
  "/terms": [
    "Terms",
    "Terms for using proofs.rs and publishing verification reports.",
  ],
  "/privacy": ["Privacy", "How proofs.rs handles your information."],
  "/contact": [
    "Help & feedback",
    "Get help with Rust API verification reports and share feedback about proofs.rs.",
  ],
};
export async function resolveSocialCard(
  input: URL,
  get: SocialGet,
): Promise<SocialCard | null> {
  const path = input.pathname;
  const post = blogPosts.find((item) => blogPath(item.slug) === path);
  if (post || path === "/blog") {
    return {
      title: post?.title ?? "proofs.rs blog",
      description:
        post?.description ??
        "Updates on Rust formal verification and the tools we build.",
      label: "proofs.rs blog",
      context: post?.author ?? "",
      footer: post?.published.slice(0, 10) ?? "Rust · Formal verification",
      path,
      type: post ? "article" : "website",
    };
  }
  if (pages[path]) {
    const [title, description] = pages[path];
    return {
      title,
      description,
      layout: path === "/" ? "home" : undefined,
      label:
        path === "/"
          ? "A Public Registry for Rust Formal Verification Results"
          : "Rust API Verification Reports",
      context: "",
      footer:
        path === "/"
          ? "Claims · Findings · Evidence"
          : "Rust crates · Claims · Evidence",
      path,
      type: "website",
    };
  }
  const match =
    /^\/(crate|claim|finding|api|tool|tool-version|user)\/([^/]+)$/.exec(path);
  if (!match) return null;
  const [, kind, encoded] = match;
  const id = decodeURIComponent(encoded);
  const enc = encodeURIComponent;
  const base = {
    label: "Rust API Verification Reports",
    context: "",
    footer: "",
    path: `/${kind}/${enc(id)}`,
    type: "website" as "website" | "article",
  };
  if (kind === "crate") {
    const releases = await get(`/crates/${enc(id)}/releases`);
    const version =
      input.searchParams.get("version") || releases.default_version;
    if (!version || !releases.items.some((r: any) => r.version === version))
      return null;
    return {
      ...base,
      title: `${id} ${version}`,
      description: socialText(
        releases.description ||
          `Verification reports, claims and findings for ${id} ${version}.`,
      ),
      label: "Crate Verification Reports",
      footer: "Claims · Findings · Evidence",
      path: `${base.path}?version=${enc(version)}`,
    };
  }
  if (kind === "claim") {
    const revision = input.searchParams.get("report_revision");
    if (revision && !/^[1-9]\d*$/.test(revision)) return null;
    const c = await get(
      `/claims/${enc(id)}${revision ? `?report_revision=${enc(revision)}` : ""}`,
    );
    return {
      ...base,
      type: "article",
      title: `${c.withdrawn_at ? "Withdrawn · " : ""}${c.title}`,
      description: socialText(
        c.explanation ||
          c.precondition ||
          `Verification claim for ${c.display_path} using ${c.tool}.`,
      ),
      label: "Rust API Verification Claim",
      context: `${c.crate} ${c.version}`,
      footer: `${c.tool} · ${c.display_path}`,
      path: `${base.path}?report_revision=${c.report_revision}`,
    };
  }
  if (kind === "finding") {
    const f = await get(`/findings/${enc(id)}`);
    return {
      ...base,
      type: "article",
      title: `${f.withdrawn_at ? "Withdrawn · " : ""}${f.title}`,
      description: socialText(f.body),
      label: "Rust API Verification Finding",
      context: `${f.crate} ${f.version}`,
      footer: `${f.validity.replaceAll("_", " ")} · ${f.upstream_status.replaceAll("_", " ")}`,
    };
  }
  if (kind === "api") {
    const a = await get(`/apis/${enc(id)}`);
    return {
      ...base,
      title: a.display_path,
      description: socialText(
        a.signature ||
          `Verification claims and evidence for ${a.display_path}.`,
      ),
      label: "Rust API Verification",
      context: `${a.crate} ${a.version}`,
      footer: "Claims · Evidence",
    };
  }
  if (kind === "user") {
    const u = await get(`/users/${enc(id)}`);
    return {
      ...base,
      title: u.username,
      description: `Public verification reports and contributions by ${u.username} on proofs.rs.`,
      label: "Verification Community",
      footer: "Reports · Claims · Discussion",
    };
  }
  const t = await get(
    `/${kind === "tool" ? "tools" : "tool-versions"}/${enc(id)}`,
  );
  return {
    ...base,
    title: kind === "tool" ? t.name : `${t.tool} ${t.version}`,
    description: socialText(
      t.description || t.limitations || `Rust API verification with ${t.tool}.`,
    ),
    label: "Rust API Verification Tool",
    footer: "Tools · Reports · Evidence",
  };
}
export function cardMetadata(card: SocialCard, origin: string) {
  return {
    title: `${card.title} · proofs.rs`,
    description: card.description,
    url: new URL(card.path, origin).href,
    image: new URL(`/og/page.png?path=${encodeURIComponent(card.path)}`, origin)
      .href,
    alt: `${card.label} · ${card.context ? card.context + " · " : ""}${card.title}`,
    type: card.type,
  };
}
