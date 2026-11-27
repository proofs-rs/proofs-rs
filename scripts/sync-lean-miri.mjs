import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [checkout, flag, ...extra] = process.argv.slice(2);
if (!checkout || (flag && flag !== "--check") || extra.length)
  throw new Error("Usage: node scripts/sync-lean-miri.mjs <lean-miri checkout> [--check]");

const git = (...args) => execFileSync("git", ["-C", resolve(checkout), ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
const revision = git("rev-parse", "HEAD").trim();
const files = git("ls-tree", "-r", "--name-only", revision, "site/").split("\n");
const input = files.includes("site/landing.html") ? "site/landing.html" : "site/index.html";
let html = git("show", revision + ":" + input);

const replacements = [
  [
    "<title>lean-miri — A proofs.rs project</title>",
    "<title>lean-miri — A proofs.rs project</title>\n  <link rel=\"canonical\" href=\"https://proofs.rs/lean-miri/\">",
    1
  ],
  [
    "href=\"Miri.html\"",
    "href=\"https://proofs-rs.github.io/lean-miri/Miri.html\"",
    2
  ],
  [
    "https://proofs-rs.hashnode.dev/lean-miri-formally-proving-rust-programs-free-of-undefined-behavior-with-lean",
    "https://proofs.rs/blog/lean-miri-formally-proving-rust-programs-free-of-undefined-behavior-with-lean/",
    1
  ]
];
for (const [before, after, count] of replacements) {
  if (html.split(before).length !== count + 1)
    throw new Error("Unexpected source markup; review the substitution: " + before);
  html = html.replaceAll(before, after);
}
const directory = new URL("../public/lean-miri/", import.meta.url);
const output = new URL("index.html", directory);
const source = new URL("../lean-miri-source.txt", import.meta.url);
const pointer = "https://github.com/proofs-rs/lean-miri/tree/" + revision + "\n";
if (flag === "--check") {
  if (readFileSync(output, "utf8") !== html || readFileSync(source, "utf8") !== pointer)
    throw new Error("The deployed landing page does not match this source revision");
} else {
  mkdirSync(directory, { recursive: true });
  writeFileSync(output, html);
  writeFileSync(source, pointer);
}
console.log("lean-miri landing page checked against " + revision);
