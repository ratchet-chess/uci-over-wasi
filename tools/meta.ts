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

export interface ProbeHint {
  depths: number[];
  defaultDepth: number;
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
  probe?: ProbeHint;
}

export interface PinFields {
  url: string;
  commit: string;
  license: string;
  compare: string;
  nodes?: string;
  gate?: string;
  module: string;
}

interface SidecarMeta {
  date: string;
  year: number;
  originalAuthors: string[];
  affiliation?: string;
  originalLanguage?: string;
  originalLicenseNote?: string;
  upstreamTag?: string;
  cpwPage?: string;
  blurb: string;
  results?: HistoricalResult[];
  fidelityNotes?: string;
  features: CpwFeature[];
  probe?: ProbeHint;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNonEmptyStr = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
const GROUPS = new Set(["Board", "Search", "Ordering", "Evaluation", "Tables"]);
const RESULT_KINDS = new Set(["tournament", "match", "rating"]);
const SIDECAR_KEYS = new Set([
  "date",
  "year",
  "originalAuthors",
  "affiliation",
  "originalLanguage",
  "originalLicenseNote",
  "upstreamTag",
  "cpwPage",
  "blurb",
  "results",
  "fidelityNotes",
  "features",
  "probe",
]);
const LEAK_PATTERNS = [/<artifacts>/i, /\/mnt\//, /\/home\//, /\/work\//, /downloads\//];
/** this repo's public home, which a package's sources link to */
export const REPO_URL = "https://github.com/ratchet-chess/uci-over-wasi";

/** the adapted folder `id` at its release tag, which is named after the folder, so a release links to the tree it was built from */
export function adaptationUrl(id: string): string {
  return `${REPO_URL}/tree/${id}/adapted/${id}`;
}

/** reads an adapted folder's `pin` file (shell assignments) and throws for a missing or malformed field */
export function parsePin(path: string): PinFields {
  const fields: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    fields[k] = v;
  }
  for (const req of ["url", "commit", "license", "compare", "module"]) {
    if (!fields[req]) throw new Error(`${path}: missing ${req}`);
  }
  if (fields.compare === "bench" && (!fields.nodes || !/^\d+$/.test(fields.nodes))) {
    throw new Error(`${path}: compare=bench requires numeric nodes`);
  }
  return {
    url: fields.url,
    commit: fields.commit,
    license: fields.license,
    compare: fields.compare,
    nodes: fields.nodes,
    gate: fields.gate,
    module: fields.module,
  };
}

function repoShortName(url: string): string {
  const m = /(?:github\.com|gitlab\.com|bitbucket\.org)\/(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1] : url;
}

function upstreamTreeUrl(url: string, commit: string): string {
  const clean = url.replace(/\.git$/, "").replace(/\/$/, "");
  if (clean.includes("github.com/")) return `${clean}/tree/${commit}`;
  if (clean.includes("gitlab.com/")) return `${clean}/-/tree/${commit}`;
  if (clean.includes("bitbucket.org/")) return `${clean}/src/${commit}`;
  return clean;
}

function assertOptStr(obj: Record<string, unknown>, key: string, path: string): void {
  if (obj[key] !== undefined && !isNonEmptyStr(obj[key])) {
    throw new Error(`${path}: ${key} must be a non-empty string`);
  }
}

function parseSidecar(path: string): SidecarMeta {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) throw new Error(`${path}: root must be an object`);
  for (const key of Object.keys(raw)) {
    if (!SIDECAR_KEYS.has(key)) throw new Error(`${path}: unknown field "${key}"`);
  }
  if (typeof raw.date !== "string" || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(raw.date)) {
    throw new Error(`${path}: missing or invalid date`);
  }
  if (typeof raw.year !== "number" || !Number.isInteger(raw.year)) {
    throw new Error(`${path}: missing or invalid year`);
  }
  if (raw.year !== Number(raw.date.slice(0, 4))) {
    throw new Error(`${path}: year ${raw.year} does not match date ${raw.date}`);
  }
  if (!Array.isArray(raw.originalAuthors) || raw.originalAuthors.length === 0 || !raw.originalAuthors.every(isNonEmptyStr)) {
    throw new Error(`${path}: originalAuthors must be a non-empty string array`);
  }
  assertOptStr(raw, "affiliation", path);
  assertOptStr(raw, "originalLanguage", path);
  assertOptStr(raw, "originalLicenseNote", path);
  assertOptStr(raw, "upstreamTag", path);
  assertOptStr(raw, "cpwPage", path);
  assertOptStr(raw, "fidelityNotes", path);
  if (!isNonEmptyStr(raw.blurb)) {
    throw new Error(`${path}: missing blurb`);
  }
  if (raw.results !== undefined) {
    if (!Array.isArray(raw.results)) throw new Error(`${path}: results must be an array`);
    for (const r of raw.results) {
      if (
        !isRecord(r) ||
        !isNonEmptyStr(r.where) ||
        !isNonEmptyStr(r.result) ||
        !isNonEmptyStr(r.date) ||
        typeof r.kind !== "string" ||
        !RESULT_KINDS.has(r.kind)
      ) {
        throw new Error(`${path}: invalid results entry`);
      }
    }
  }
  if (raw.probe !== undefined) {
    if (
      !isRecord(raw.probe) ||
      !Array.isArray(raw.probe.depths) ||
      raw.probe.depths.length === 0 ||
      !raw.probe.depths.every((d) => typeof d === "number" && Number.isInteger(d) && d > 0) ||
      typeof raw.probe.defaultDepth !== "number" ||
      !Number.isInteger(raw.probe.defaultDepth) ||
      raw.probe.defaultDepth <= 0 ||
      !raw.probe.depths.includes(raw.probe.defaultDepth)
    ) {
      throw new Error(`${path}: invalid probe entry`);
    }
  }
  if (!Array.isArray(raw.features) || raw.features.length < 8 || raw.features.length > 15) {
    throw new Error(`${path}: features must have 8-15 CPW entries`);
  }
  const seenKeys = new Set<string>();
  for (const f of raw.features) {
    if (
      !isRecord(f) ||
      !isNonEmptyStr(f.key) ||
      !isNonEmptyStr(f.label) ||
      typeof f.group !== "string" ||
      !GROUPS.has(f.group) ||
      !isNonEmptyStr(f.implementation) ||
      (f.ref !== undefined && !isNonEmptyStr(f.ref)) ||
      (f.landmark !== undefined && typeof f.landmark !== "boolean")
    ) {
      throw new Error(`${path}: invalid feature entry`);
    }
    if (seenKeys.has(f.key)) throw new Error(`${path}: duplicate CPW feature key "${f.key}"`);
    seenKeys.add(f.key);
  }
  return raw as unknown as SidecarMeta;
}

/** Normalizes a MediaWiki heading to its URL fragment identifier. */
function headingToAnchor(heading: string): string {
  return heading
    .replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/<[^>]+>/g, "")
    .trim()
    .replace(/\s+/g, "_");
}

function hasWikiSection(wikiText: string, section: string): boolean {
  const decoded = decodeURIComponent(section);
  for (const line of wikiText.split(/\r?\n/)) {
    const m = /^=+(.+?)=+\s*$/.exec(line.trim());
    if (m && headingToAnchor(m[1]) === decoded) return true;
  }
  const idRe = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/g;
  for (const m of wikiText.matchAll(idRe)) {
    const id = m[1] ?? m[2] ?? m[3];
    if (id === decoded || id === section) return true;
  }
  return false;
}

/** Validates CPW page and `#Section` keys when a local CPW dump is symlinked at `vendor/cpw/pages`. */
function checkCpwKeys(root: string, meta: EngineMeta, slug: string): boolean {
  const cpwDir = join(root, "vendor/cpw/pages");
  if (!existsSync(cpwDir)) return false;
  const pageCache = new Map<string, string>();
  const check = (key: string) => {
    const hashIdx = key.indexOf("#");
    const page = hashIdx >= 0 ? key.slice(0, hashIdx) : key;
    const section = hashIdx >= 0 ? key.slice(hashIdx + 1) : undefined;
    const wikiPath = join(cpwDir, `${page}.wiki`);
    if (!existsSync(wikiPath)) {
      throw new Error(`${slug}: CPW key "${key}" has no page ${page}.wiki in vendor/cpw/pages/`);
    }
    if (section !== undefined) {
      let text = pageCache.get(page);
      if (text === undefined) {
        text = readFileSync(wikiPath, "utf8");
        pageCache.set(page, text);
      }
      if (!hasWikiSection(text, section)) {
        throw new Error(`${slug}: CPW key "${key}" has no section or anchor #${section} in ${page}.wiki`);
      }
    }
  };
  if (meta.cpwPage) check(meta.cpwPage);
  for (const f of meta.features) check(f.key);
  return true;
}

/**
 * The public metadata of the adapted engine in `folder`, from its pin and its meta.json. Throws for an invalid
 * sidecar, an unknown CPW key, or a private path in the result. `cpwChecked` is whether the CPW keys were
 * checked against `vendor/cpw/pages` under `repoRoot`, which is this repo by default.
 *
 *   const { meta } = buildAdaptedMeta("adapted/stockfish-10");
 */
export function buildAdaptedMeta(folder: string, repoRoot?: string): { meta: EngineMeta; cpwChecked: boolean } {
  const abs = resolve(folder);
  const root = repoRoot ? resolve(repoRoot) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

  const fidelityStatus: FidelitySummary["status"] = pin.gate ? "matched" : "exact";
  const fidelityHeadline =
    pin.compare === "bench" && pin.nodes
      ? `Bench exact (${Number(pin.nodes).toLocaleString("en-US")} nodes vs. native)`
      : pin.gate
        ? `Exact moves and node counts vs. native (gated with ${pin.gate})`
        : "Exact moves and node counts vs. native";

  const refSuffix = sidecar.upstreamTag ? ` (${sidecar.upstreamTag})` : "";
  const fidelity: FidelitySummary = {
    status: fidelityStatus,
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
    ...(sidecar.originalLicenseNote ? { originalLicenseNote: sidecar.originalLicenseNote } : {}),
    sources: [
      {
        label,
        url: upstreamTreeUrl(pin.url, pin.commit),
        role: "upstream",
        commit: pin.commit,
        note: sidecar.originalLanguage ? `Upstream ${sidecar.originalLanguage} source` : "Upstream source",
      },
      {
        label: `ratchet-chess/uci-over-wasi (adapted/${slug})`,
        url: adaptationUrl(slug),
        role: "source",
        note: "UCI over WASI adaptation patches and build script",
      },
    ],
    ...(sidecar.cpwPage ? { cpwPage: sidecar.cpwPage } : {}),
    blurb: sidecar.blurb,
    ...(sidecar.results?.length ? { results: sidecar.results } : {}),
    fidelity,
    features: sidecar.features,
    ...(sidecar.probe ? { probe: sidecar.probe } : {}),
  };

  const cpwChecked = checkCpwKeys(root, meta, slug);
  const text = JSON.stringify(meta, null, 2);
  for (const pat of LEAK_PATTERNS) {
    if (pat.test(text)) throw new Error(`${slug}: metadata contains private path matching ${pat}`);
  }
  return { meta, cpwChecked };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const check = args.includes("--check");
  const all = args.includes("--all");
  const outIdx = args.indexOf("--out");
  let outPath: string | undefined;
  if (outIdx >= 0) {
    outPath = args[outIdx + 1];
    if (!outPath || outPath.startsWith("--")) {
      console.error("--out requires a path");
      process.exit(2);
    }
  }

  if (all) {
    const adaptedDir = join(root, "adapted");
    const entries = readdirSync(adaptedDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(adaptedDir, e.name, "pin")))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    let count = 0;
    let cpwCheckedAny = false;
    for (const entry of entries) {
      const dir = join(adaptedDir, entry.name);
      const { meta, cpwChecked } = buildAdaptedMeta(dir, root);
      if (cpwChecked) cpwCheckedAny = true;
      console.log(`${entry.name}: valid (${meta.features.length} CPW features${cpwChecked ? ", CPW verified" : ""})`);
      count++;
    }
    if (count === 0) throw new Error("no adapted/*/pin folders found");
    if (!cpwCheckedAny) console.log("note: vendor/cpw/pages not present; skipped local CPW dump verification");
  } else {
    const folder = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
    if (!folder) {
      console.error("usage: bun tools/meta.ts <adapted/folder> [--out <path>] [--check] | --all --check");
      process.exit(2);
    }
    const { meta, cpwChecked } = buildAdaptedMeta(folder, root);
    const json = `${JSON.stringify(meta, null, 2)}\n`;
    if (check) {
      console.log(
        `${basename(resolve(folder))}: valid (${meta.features.length} CPW features${cpwChecked ? ", CPW verified" : ""})`,
      );
    } else if (outPath) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, json);
      console.error(`wrote ${outPath}`);
    } else {
      process.stdout.write(json);
    }
  }
}
