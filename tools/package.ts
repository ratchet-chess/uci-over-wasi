// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * Packages a checked adapted engine build into `<out>/<id>/` with:
 *   <id>.wasm           the WASI module, renamed from `pin`'s `module=` to the folder id
 *   <id>.meta.json      public EngineMeta provenance built by tools/meta.ts
 *   <id>-LICENSE.txt    upstream copyright/license notice (and GPL text for GPL engines), then the folder's NOTICE if it
 *                       has one, then SIMDe's if the build used it
 *   <id>-source.tar.gz  Corresponding Source archive for GPL/LGPL/AGPL engines
 *   SHA256SUMS          sha256 digests for all packaged files
 *
 *   bun tools/package.ts adapted/stockfish-10 [--wasm <path>] [--tree <dir>] [--license-file <path>] [--out tmp/dist] [--no-source]
 *
 * Run `tools/adapted.sh check adapted/<folder>` first unless passing `--wasm <path>`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptationUrl, buildAdaptedMeta, parsePin } from "./meta.ts";

function isCopyleft(license: string): boolean {
  return /\b(?:A|L)?GPL\b/i.test(license);
}

const LICENSE_NAMES = [
  "license",
  "license.txt",
  "license.md",
  "license-mit",
  "copying",
  "copying.txt",
  "copying.md",
  "copyright",
  "copyright.txt",
];

function findUpstreamLicense(treeDir: string): string | undefined {
  if (!existsSync(treeDir)) return undefined;
  const entries = readdirSync(treeDir, { withFileTypes: true }).filter((e) => e.isFile());
  for (const want of LICENSE_NAMES) {
    const hit = entries.find((e) => e.name.toLowerCase() === want);
    if (hit) return join(treeDir, hit.name);
  }
  return undefined;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function usage(): never {
  console.error(
    "usage: bun tools/package.ts <adapted/folder> [--wasm <path>] [--tree <dir>] [--license-file <path>] [--out <dir>] [--no-source]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const valueFlags = new Set(["--wasm", "--tree", "--license-file", "--out"]);
const opt = (flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const val = args[idx + 1];
  if (!val || val.startsWith("--")) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return val;
};
const noSource = args.includes("--no-source");
const folder = args.find((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1] ?? ""));
if (!folder) usage();

const absFolder = resolve(folder);
const id = basename(absFolder);
const pinPath = join(absFolder, "pin");
if (!existsSync(pinPath)) throw new Error(`no pin file at ${pinPath}`);

const pin = parsePin(pinPath);
const workDir = join(root, "tmp/adapted", id);
const wasmSrc = resolve(opt("--wasm") ?? join(workDir, "out", pin.module));
if (!existsSync(wasmSrc)) {
  throw new Error(`no WASI build at ${wasmSrc}; run tools/adapted.sh check adapted/${id} first or pass --wasm`);
}
const wasmBytes = readFileSync(wasmSrc);
if (wasmBytes.length < 4 || wasmBytes[0] !== 0x00 || wasmBytes[1] !== 0x61 || wasmBytes[2] !== 0x73 || wasmBytes[3] !== 0x6d) {
  throw new Error(`${wasmSrc} is not a WebAssembly module`);
}

const { meta } = buildAdaptedMeta(absFolder, root);
const metaJson = `${JSON.stringify(meta, null, 2)}\n`;

// Resolve upstream license notice
const treeDir = opt("--tree")
  ? resolve(opt("--tree")!)
  : existsSync(join(workDir, "repo"))
    ? join(workDir, "repo")
    : join(workDir, "edited");
const explicitLicense = opt("--license-file") ? resolve(opt("--license-file")!) : undefined;
if (explicitLicense && !existsSync(explicitLicense)) {
  throw new Error(`--license-file not found: ${explicitLicense}`);
}
const foundLicense = explicitLicense ?? findUpstreamLicense(treeDir);
let licenseBody: string;
if (foundLicense) {
  licenseBody = readFileSync(foundLicense, "utf8");
} else if (isCopyleft(pin.license) && existsSync(join(root, "adapted/COPYING"))) {
  licenseBody = readFileSync(join(root, "adapted/COPYING"), "utf8");
} else {
  throw new Error(
    `no upstream license file found for ${id} in ${treeDir}; run tools/adapted.sh fetch adapted/${id} first or pass --license-file`,
  );
}

/** The distinct lines of every `Copyright:` block in a SIMDe header's license comments. */
function simdeCopyrights(header: string): string[] {
  const lines: string[] = [];
  let inBlock = false;
  for (const line of readFileSync(header, "utf8").split("\n")) {
    const text = line.replace(/^\s*\*\s?/, "").trim();
    if (/^\s*\*\s*Copyright:\s*$/.test(line)) {
      inBlock = true;
    } else if (inBlock && /^\s*\*/.test(line) && !line.includes("*/") && text !== "") {
      if (!lines.includes(text)) lines.push(text);
    } else {
      inBlock = false;
    }
  }
  return lines;
}

// SIMDe's headers compile into the module, so its MIT notice goes with every package of an engine built on them:
// the project's COPYING, then the copyright lines of the headers that the build's shim/ includes
const simdeDir = join(workDir, "simde");
let simdeNotice = "";
if (existsSync(simdeDir)) {
  const copying = join(simdeDir, "COPYING");
  if (!existsSync(copying)) {
    throw new Error(`${simdeDir} has no COPYING; the folder's fetch.sh must fetch SIMDe's license with its headers`);
  }
  const shimDir = join(workDir, "shim");
  const included = existsSync(shimDir)
    ? readdirSync(shimDir)
        .filter((name) => name.endsWith(".h"))
        .flatMap((name) => [...readFileSync(join(shimDir, name), "utf8").matchAll(/#include\s+"([^"]+)"/g)].map((m) => m[1]!))
        .filter((path) => existsSync(join(simdeDir, path)))
    : [];
  if (included.length === 0) {
    throw new Error(
      `no shim/*.h in ${workDir} includes a SIMDe header; run tools/adapted.sh check adapted/${id} first, whose build writes it`,
    );
  }
  const holders = [...new Set(included.flatMap((path) => simdeCopyrights(join(simdeDir, path))))];
  simdeNotice = [
    "",
    "---",
    "",
    "The module contains code compiled from SIMDe (https://github.com/simd-everywhere/simde), under the MIT License:",
    "",
    readFileSync(copying, "utf8").trimEnd(),
    "",
    `The SIMDe headers it compiled (${included.join(", ")}) name these copyright holders:`,
    "",
    ...holders.map((holder) => `  ${holder}`),
    "",
  ].join("\n");
}

// a notice the engine's own files ask to travel with it, beyond its license file, such as a training-data credit
const noticePath = join(absFolder, "NOTICE");
const folderNotice = existsSync(noticePath) ? `\n---\n\n${readFileSync(noticePath, "utf8").trimEnd()}\n` : "";

const licenseHeader = [
  `Engine: ${id}`,
  `Upstream: ${pin.url} (commit ${pin.commit})`,
  `License: ${pin.license}`,
  `Adaptation: ${adaptationUrl(id)}`,
  "",
  "---",
  "",
].join("\n");

const withSource = isCopyleft(pin.license) && !noSource;
const editedDir = join(workDir, "edited");
if (withSource && !existsSync(editedDir)) {
  throw new Error(
    `copyleft engine ${id} (${pin.license}) requires patched source at ${editedDir} for Corresponding Source; run tools/adapted.sh check adapted/${id} first (or pass --no-source for local smoke tests)`,
  );
}

const outBase = resolve(opt("--out") ?? join(root, "tmp/dist"));
const outDir = join(outBase, id);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const packaged: string[] = [];
const wasmName = `${id}.wasm`;
const metaName = `${id}.meta.json`;
const licenseName = `${id}-LICENSE.txt`;

copyFileSync(wasmSrc, join(outDir, wasmName));
packaged.push(wasmName);

writeFileSync(join(outDir, metaName), metaJson);
packaged.push(metaName);

writeFileSync(join(outDir, licenseName), `${licenseHeader}${licenseBody.trimEnd()}\n${folderNotice}${simdeNotice}`);
packaged.push(licenseName);

// Corresponding Source for GPL/LGPL/AGPL engines: the edited tree, the folder, the helper, and the scripts and
// toolchain pins that give build.sh its environment
if (withSource) {
  const stageRoot = join(outBase, `.stage-${id}`);
  const stageDir = join(stageRoot, `${id}-source`);
  rmSync(stageRoot, { recursive: true, force: true });
  try {
    mkdirSync(stageDir, { recursive: true });
    cpSync(editedDir, join(stageDir, "src"), {
      recursive: true,
      filter: (p) => {
        const name = basename(p);
        return name !== ".git" && name !== "target" && !name.endsWith(".o") && !name.endsWith(".wasm");
      },
    });
    cpSync(absFolder, join(stageDir, "adapted", id), { recursive: true });
    cpSync(join(root, "helper"), join(stageDir, "helper"), { recursive: true });
    for (const tool of ["adapted.sh", "toolchains.sh", "toolchains.txt"]) {
      cpSync(join(root, "tools", tool), join(stageDir, "tools", tool));
    }
    // what fetch.sh left that a build reads besides the tree: a Rust engine's crates, SIMDe's headers. Cargo's
    // unpacked registry/src is left out: an offline build unpacks it again from the downloaded registry/cache.
    for (const fetched of ["cargo", "simde"]) {
      const dir = join(workDir, fetched);
      if (existsSync(dir)) {
        const unpacked = join(dir, "registry", "src");
        cpSync(dir, join(stageDir, fetched), { recursive: true, filter: (p) => p !== unpacked });
      }
    }
    writeFileSync(join(stageDir, "LICENSE.txt"), `${licenseHeader}${licenseBody.trimEnd()}\n${folderNotice}${simdeNotice}`);
    const sourceName = `${id}-source.tar.gz`;
    execFileSync("tar", ["-czf", join(outDir, sourceName), "-C", stageRoot, `${id}-source`], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    packaged.push(sourceName);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

const sums = packaged.map((name) => `${sha256(join(outDir, name))}  ${name}`).join("\n") + "\n";
writeFileSync(join(outDir, "SHA256SUMS"), sums);

process.stdout.write(`${outDir}\n${sums}`);
