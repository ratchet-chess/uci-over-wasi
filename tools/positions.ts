// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * An engine's move and node count over a position file, each position in a fresh process, for comparing an adapted
 * engine with its native build where the native bench does not repeat (helper/README.md § Checking an adapted engine).
 *
 *   bun tools/positions.ts <positions.txt> "<go arguments>" <engine command...>
 *
 * Each line of the file is what follows `position`, such as `fen <FEN>` or `startpos moves e2e4`. For each one it
 * sends `uci` and `position`, waits for `readyok`, sends `go` with the arguments, and reads to `bestmove`. It prints one row
 * per position, the last `info` line's node count and the move, then the total. Two builds that play the same
 * search print the same text. A search that prints no node count fails the run, because its row would compare
 * the move alone.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const [file, go, ...command] = process.argv.slice(2);
if (!file || !go || !command.length) {
  console.error('usage: bun tools/positions.ts <positions.txt> "<go arguments>" <engine command...>');
  process.exit(2);
}
/** the longest one search may take before the run fails */
const LIMIT_MS = 300_000;

function search(position: string): Promise<{ nodes: number; move: string }> {
  return new Promise((resolve, reject) => {
    const engine = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => { engine.kill("SIGKILL"); reject(new Error(`no bestmove in ${LIMIT_MS} ms: ${position}`)); }, LIMIT_MS);
    let text = "", nodes = 0, move = "";
    engine.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n")) {
        const line = text.slice(0, end).trim();
        text = text.slice(end + 1);
        if (line === "readyok") engine.stdin.write(`go ${go}\n`);
        const count = /^info .*\bnodes\s+(\d+)/.exec(line);
        if (count) nodes = Number(count[1]);
        if (line.startsWith("bestmove")) {
          move = line.split(" ")[1] ?? "";
          engine.stdin.end("quit\n");
        }
      }
    });
    engine.on("error", reject);
    engine.on("close", () => {
      clearTimeout(timer);
      if (!move) reject(new Error(`the engine ended with no bestmove: ${position}`));
      else if (!nodes) reject(new Error(`the engine printed no node count: ${position}`));
      else resolve({ nodes, move });
    });
    engine.stdin.on("error", () => {});
    // a module may expect `uci` first (docs/uci-over-wasi.md § What a module does with each line)
    engine.stdin.write(`uci\nposition ${position}\nisready\n`);
  });
}

let total = 0;
for (const position of readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)) {
  const { nodes, move } = await search(position);
  total += nodes;
  console.log(`${nodes} ${move}`);
}
console.log(`total ${total}`);
