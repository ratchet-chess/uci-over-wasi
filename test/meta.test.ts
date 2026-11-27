// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildAdaptedMeta, parsePin } from "../tools/meta.ts";

function withTempFolder(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "uci-over-wasi-meta-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_PIN = [
  'url="https://github.com/example/engine"',
  "commit=0123456789abcdef0123456789abcdef01234567",
  "license=MIT",
  "compare=bench",
  "nodes=123456",
  "module=engine.wasm",
].join("\n");

function validMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: "2024-06-01",
    year: 2024,
    originalAuthors: ["Author"],
    blurb: "Test engine blurb.",
    features: Array.from({ length: 8 }, (_, i) => ({
      key: `Feature_${i}`,
      label: `Feature ${i}`,
      group: "Search",
      implementation: `Impl ${i}`,
    })),
    ...overrides,
  };
}

describe("parsePin", () => {
  it("parses valid pins and strips only matching quotes", () => {
    withTempFolder((dir) => {
      const p = join(dir, "pin");
      writeFileSync(p, `${VALID_PIN}\ngo="depth 8'\n`);
      const parsed = parsePin(p);
      assert.equal(parsed.url, "https://github.com/example/engine");
      assert.equal(parsed.nodes, "123456");
    });
  });

  it("rejects missing required fields and non-numeric bench nodes", () => {
    withTempFolder((dir) => {
      const p = join(dir, "pin");
      writeFileSync(p, "url=https://github.com/example/engine\ncommit=abc\n");
      assert.throws(() => parsePin(p), /missing license/);

      writeFileSync(p, VALID_PIN.replace("nodes=123456", "nodes=abc"));
      assert.throws(() => parsePin(p), /numeric nodes/);
    });
  });
});

describe("buildAdaptedMeta", () => {
  it("builds valid EngineMeta and rejects invalid sidecars or private path leaks", () => {
    withTempFolder((dir) => {
      writeFileSync(join(dir, "pin"), VALID_PIN);
      writeFileSync(join(dir, "meta.json"), JSON.stringify(validMeta()));
      const { meta } = buildAdaptedMeta(dir, dir);
      assert.equal(meta.kind, "adapted");
      assert.equal(meta.fidelity?.status, "exact");
      assert.match(meta.fidelity?.headline ?? "", /123,456/);

      writeFileSync(join(dir, "meta.json"), JSON.stringify(validMeta({ extra: 1 })));
      assert.throws(() => buildAdaptedMeta(dir, dir), /unknown field/);

      writeFileSync(join(dir, "meta.json"), JSON.stringify(validMeta({ year: 2023 })));
      assert.throws(() => buildAdaptedMeta(dir, dir), /does not match date/);

      writeFileSync(join(dir, "meta.json"), JSON.stringify(validMeta({ blurb: "from <artifacts>/notes" })));
      assert.throws(() => buildAdaptedMeta(dir, dir), /private path/);
    });
  });
});
