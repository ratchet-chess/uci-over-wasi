// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * Builds and validates `<id>.meta.json` for an adapted engine folder by combining
 * `adapted/<folder>/pin` (upstream URL, commit, license, comparison) with the curated
 * sidecar `adapted/<folder>/meta.json` (authors, date, blurb, and 8-15 CPW features).
 *
 *   bun tools/meta.ts adapted/stockfish-10 [--out dist/stockfish-10.meta.json]
 *   bun tools/meta.ts adapted/stockfish-10 --check
 *   bun tools/meta.ts --all --check
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ExternalSource {
  label: string;
  url: string;
  role: "source" | "archive" | "emulator" | "record" | "upstream" | "cpw";
  sha256?: string;
  commit?: string;
  note?: string;
}

export interface HistoricalResult {
  where: string;
  result: string;
  date: string;
  kind: "tournament" | "match" | "rating";
}

export interface FidelitySummary {
  status: "exact" | "matched" | "approximate";
  headline: string;
  referenceOf: string;
  games?: string;
  notes?: string;
}

export interface CpwFeature {
  key: string;
  label: string;
  group: "Board" | "Search" | "Ordering" | "Evaluation" | "Tables";
  implementation: string;
  ref?: string;
  landmark?: boolean;
}

export interface EngineMeta {
  kind: "adapted";
  buildBasis: "adapted-from-code";
  date: string;
  year: number;
  originalAuthors: string[];
  affiliation?: string;
  originalLanguage?: string;
  originalLicense?: string;
  originalLicenseNote?: string;
  sources: ExternalSource[];
  cpwPage?: string;
  blurb: string;
  results?: HistoricalResult[];
  fidelity?: FidelitySummary;
  features: CpwFeature[];
  probe?: {
    depths: number[];
    defaultDepth: number;
  };
}

interface PinFields {
  url: string;
  commit: string;
  license: string;
  compare: string;
  nodes?: string;
  module: string;
}

interface SidecarMeta {
  date: string;
  year: number;
  originalAuthors: string[];
  affiliation?: string;
  originalLanguage?: string;
  upstreamTag?: string;
  cpwPage?: string;
  blurb: string;
  results?: HistoricalResult[];
  fidelityNotes?: string;
  features: CpwFeature[];
  probe?: {
    depths: number[];
    defaultDepth: number;
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const GROUPS = new Set(["Board", "Search", "Ordering", "Evaluation", "Tables"]);
const LEAK_PATTERNS = [/<artifacts>/i, /\/mnt\//, /\/home\//, /\/work\//];

function parsePin(path: string): PinFields {
  const fields: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    fields[k] = v;
  }
  for (const req of ["url", "commit", "license", "compare", "module"]) {
    if (!fields[req]) throw new Error(`${path}: missing ${req}`);
  }
  return {
    url: fields.url,
    commit: fields.commit,
    license: fields.license,
    compare: fields.compare,
    nodes: fields.nodes,
    module: fields.module,
  };
}

function repoShortName(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1] : url;
}

function upstreamTreeUrl(url: string, commit: string): string {
  const clean = url.replace(/\.git$/, "").replace(/\/$/, "");
  if (clean.includes("github.com/")) return `${clean}/tree/${commit}`;
  return clean;
}

function parseSidecar(path: string): SidecarMeta {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) throw new Error(`${path}: root must be an object`);
  if (typeof raw.date !== "string" || !/^\d{4}/.test(raw.date)) {
    throw new Error(`${path}: missing or invalid date`);
  }
  if (typeof raw.year !== "number" || !Number.isInteger(raw.year)) {
    throw new Error(`${path}: missing or invalid year`);
  }
  if (!Array.isArray(raw.originalAuthors) || raw.originalAuthors.length === 0 || !raw.originalAuthors.every((a) => typeof a === "string")) {
    throw new Error(`${path}: originalAuthors must be a non-empty string array`);
  }
  if (typeof raw.blurb !== "string" || !raw.blurb.trim()) {
    throw new Error(`${path}: missing blurb`);
  }
  if (!Array.isArray(raw.features) || raw.features.length < 8 || raw.features.length > 15) {
    throw new Error(`${path}: features must have 8-15 CPW entries`);
  }
  for (const f of raw.features) {
    if (
      !isRecord(f) ||
      typeof f.key !== "string" ||
      typeof f.label !== "string" ||
      typeof f.group !== "string" ||
      !GROUPS.has(f.group) ||
      typeof f.implementation !== "string"
    ) {
      throw new Error(`${path}: invalid feature entry`);
    }
  }
  return raw as unknown as SidecarMeta;
}

export function buildAdaptedMeta(folder: string): EngineMeta {
  const abs = resolve(folder);
  const slug = basename(abs);
  const pinPath = join(abs, "pin");
  const sidecarPath = join(abs, "meta.json");
  if (!existsSync(pinPath)) throw new Error(`no pin file at ${pinPath}`);
  if (!existsSync(sidecarPath)) throw new Error(`no meta.json sidecar at ${sidecarPath}`);

  const pin = parsePin(pinPath);
  const sidecar = parseSidecar(sidecarPath);

  const label = sidecar.upstreamTag
    ? `${repoShortName(pin.url)} (${sidecar.upstreamTag})`
    : repoShortName(pin.url);

  const fidelityHeadline =
    pin.compare === "bench" && pin.nodes
      ? `Bench exact (${Number(pin.nodes).toLocaleString("en-US")} nodes vs. native)`
      : "Exact moves and node counts vs. native";

  const refSuffix = sidecar.upstreamTag ? ` (${sidecar.upstreamTag})` : "";
  const fidelity: FidelitySummary = {
    status: "exact",
    headline: fidelityHeadline,
    referenceOf: `Native binary compiled from commit ${pin.commit.slice(0, 8)}${refSuffix}`,
    ...(sidecar.fidelityNotes ? { notes: sidecar.fidelityNotes } : {}),
  };

  const meta: EngineMeta = {
    kind: "adapted",
    buildBasis: "adapted-from-code",
    date: sidecar.date,
    year: sidecar.year,
    originalAuthors: sidecar.originalAuthors,
    ...(sidecar.affiliation ? { affiliation: sidecar.affiliation } : {}),
    ...(sidecar.originalLanguage ? { originalLanguage: sidecar.originalLanguage } : {}),
    originalLicense: pin.license,
    sources: [
      {
        label,
        url: upstreamTreeUrl(pin.url, pin.commit),
        role: "upstream",
        commit: pin.commit,
        note: sidecar.originalLanguage ? `Upstream ${sidecar.originalLanguage} source` : "Upstream source",
      },
    ],
    ...(sidecar.cpwPage ? { cpwPage: sidecar.cpwPage } : {}),
    blurb: sidecar.blurb,
    ...(sidecar.results?.length ? { results: sidecar.results } : {}),
    fidelity,
    features: sidecar.features,
    ...(sidecar.probe ? { probe: sidecar.probe } : {}),
  };

  const text = JSON.stringify(meta, null, 2);
  for (const pat of LEAK_PATTERNS) {
    if (pat.test(text)) throw new Error(`${slug}: metadata contains private path matching ${pat}`);
  }
  return meta;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const check = args.includes("--check");
  const all = args.includes("--all");
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

  if (all) {
    const adaptedDir = join(root, "adapted");
    let count = 0;
    for (const entry of readdirSync(adaptedDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(adaptedDir, entry.name);
      if (!existsSync(join(dir, "meta.json"))) continue;
      const meta = buildAdaptedMeta(dir);
      console.log(`${entry.name}: valid (${meta.features.length} CPW features)`);
      count++;
    }
    if (count === 0) throw new Error("no adapted/*/meta.json files found");
  } else {
    const folder = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
    if (!folder) {
      console.error("usage: bun tools/meta.ts <adapted/folder> [--out <path>] [--check] | --all --check");
      process.exit(2);
    }
    const meta = buildAdaptedMeta(folder);
    const json = `${JSON.stringify(meta, null, 2)}\n`;
    if (check) {
      console.log(`${basename(resolve(folder))}: valid (${meta.features.length} CPW features)`);
    } else if (outPath) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, json);
      console.error(`wrote ${outPath}`);
    } else {
      process.stdout.write(json);
    }
  }
}
