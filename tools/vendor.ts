// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * Copies the host into another repo, and records the commit it came from. The copy is a snapshot: fix the host
 * here, then run this again.
 *
 *   bun tools/vendor.ts <folder> [file...]
 *
 * <folder> is the copy's place in the other repo, such as vendor/uci-over-wasi. The files are names in host/wasi/,
 * default all four; a page needs only browser.ts and wasi.ts. The copy also gets LICENSE and a README.md that
 * names the commit. It refuses when a file to copy has changes not committed, because the recorded commit would
 * then not describe the copy.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT = ["wasi.ts", "main.ts", "thread.ts", "browser.ts"];
const AVAILABLE = [...DEFAULT, "features.ts", "check.ts", "check-browser.ts", "check-worker.ts"];
const root = join(import.meta.dirname, "..");
const [folder, ...named] = process.argv.slice(2);
const files = named.length ? named : DEFAULT;
if (!folder || files.some((f) => !AVAILABLE.includes(f))) {
  console.error(`usage: bun tools/vendor.ts <folder> [file...]   files: ${AVAILABLE.join(", ")}`);
  process.exit(2);
}
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const paths = [...files.map((f) => `host/wasi/${f}`), "LICENSE"];
if (git("status", "--porcelain", "--", ...paths) !== "") {
  console.error(`${paths.join(", ")}: changes not committed in ${root}`);
  process.exit(1);
}
const commit = git("rev-parse", "HEAD");
const date = git("log", "-1", "--format=%cs", "HEAD");

const out = resolve(folder);
mkdirSync(out, { recursive: true });
for (const f of files) copyFileSync(join(root, "host/wasi", f), join(out, f));
copyFileSync(join(root, "LICENSE"), join(out, "LICENSE"));
writeFileSync(
  join(out, "README.md"),
  `# The host of UCI over WASI

A copy of ${files.map((f) => `\`host/wasi/${f}\``).join(", ")} from uci-over-wasi, commit ${commit} (${date}).
The files are under the MIT License, in \`LICENSE\` beside them. \`docs/uci-over-wasi.md\` in uci-over-wasi states
what the host does.

Do not edit these files. Fix the host in uci-over-wasi, then run its \`tools/vendor.ts\` again:
\`bun <uci-over-wasi>/tools/vendor.ts <this folder>${named.length ? ` ${named.join(" ")}` : ""}\`.
`,
);
console.log(`${folder} is uci-over-wasi ${commit.slice(0, 7)}`);
