// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * Packages a checked adapted engine build into `<out>/<id>/` with:
 *   <id>.wasm       the WASI module, renamed from `pin`'s `module=` to the folder id
 *   <id>.meta.json  public EngineMeta provenance built by tools/meta.ts
 *   SHA256SUMS      sha256 digests for both files
 *
 *   bun tools/package.ts adapted/stockfish-10 [--wasm <path>] [--out tmp/dist]
 *
 * Run `tools/adapted.sh check adapted/<folder>` first unless passing `--wasm <path>`.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAdaptedMeta } from "./meta.ts";

function readPinModule(pinPath: string): string {
  for (const raw of readFileSync(pinPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() === "module") {
      return line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error(`${pinPath}: missing module`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function usage(): never {
  console.error("usage: bun tools/package.ts <adapted/folder> [--wasm <path>] [--out <dir>]");
  process.exit(2);
}

const args = process.argv.slice(2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const opt = (flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};
const folder = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--wasm" && args[i - 1] !== "--out");
if (!folder) usage();

const absFolder = resolve(folder);
const id = basename(absFolder);
const pinPath = join(absFolder, "pin");
if (!existsSync(pinPath)) throw new Error(`no pin file at ${pinPath}`);

const moduleName = readPinModule(pinPath);
const wasmSrc = resolve(opt("--wasm") ?? join(root, "tmp/adapted", id, "out", moduleName));
if (!existsSync(wasmSrc)) {
  throw new Error(`no WASI build at ${wasmSrc}; run tools/adapted.sh check adapted/${id} first or pass --wasm`);
}
const wasmBytes = readFileSync(wasmSrc);
if (wasmBytes.length < 4 || wasmBytes[0] !== 0x00 || wasmBytes[1] !== 0x61 || wasmBytes[2] !== 0x73 || wasmBytes[3] !== 0x6d) {
  throw new Error(`${wasmSrc} is not a WebAssembly module`);
}

const { meta } = buildAdaptedMeta(absFolder, root);
const metaJson = `${JSON.stringify(meta, null, 2)}\n`;

const outBase = resolve(opt("--out") ?? join(root, "tmp/dist"));
const outDir = join(outBase, id);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const wasmName = `${id}.wasm`;
const metaName = `${id}.meta.json`;
const wasmOut = join(outDir, wasmName);
const metaOut = join(outDir, metaName);
copyFileSync(wasmSrc, wasmOut);
writeFileSync(metaOut, metaJson);

const sums = [
  `${sha256(wasmBytes)}  ${wasmName}`,
  `${sha256(Buffer.from(metaJson, "utf8"))}  ${metaName}`,
].join("\n") + "\n";
writeFileSync(join(outDir, "SHA256SUMS"), sums);

process.stdout.write(`${outDir}\n${sums}`);
