import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 3)
  throw new Error(
    "Usage: node scripts/sync-blog.mjs <clean proofs-rs/blog checkout>",
  );
const source = resolve(process.argv[2]);
const git = (...args) =>
  execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
if (git("status", "--porcelain"))
  throw new Error("Commit blog changes before syncing");
if (!existsSync(join(source, "hugo.toml")))
  throw new Error("Expected a Hugo blog checkout");
const revision = git("rev-parse", "HEAD");
const generated = mkdtempSync(join(tmpdir(), "proofs-blog-output-"));
const destination = fileURLToPath(new URL("../public/blog", import.meta.url));
try {
  execFileSync(
    "sh",
    [
      join(source, "scripts/build.sh"),
      "--environment",
      "production",
      "--destination",
      generated,
    ],
    { stdio: "inherit" },
  );
  const index = readFileSync(join(generated, "index.html"), "utf8");
  if (!index.includes("https://proofs.rs/blog/"))
    throw new Error("Expected canonical proofs.rs/blog base URL");
  if (!existsSync(join(generated, "sitemap.xml")))
    throw new Error("Generated blog has no sitemap");
  rmSync(destination, { recursive: true, force: true });
  cpSync(generated, destination, { recursive: true });
  writeFileSync(
    new URL("../blog-source.txt", import.meta.url),
    `https://github.com/proofs-rs/blog/tree/${revision}\n`,
  );
  console.log(`Imported Hugo output from proofs-rs/blog at ${revision}.`);
} finally {
  rmSync(generated, { recursive: true, force: true });
}
