#!/usr/bin/env node
/**
 * Drift check for the verbatim MCP copy (spec D3, review §4.3).
 *
 * `src/mcp.ts` carries a COPY of qmd's internal MCP tool surface (tool names,
 * descriptions, input-schema keys) because qmd does not export its server
 * factory. A qmd version bump can therefore change the upstream tool surface
 * while our copy keeps serving the old one — silently. This script compares the
 * two and fails loudly so the re-sync is a deliberate act (D11 flow).
 *
 * Compared (behavioural surface, not wording):
 *   - the set of registered tool names
 *   - the set of input-schema keys per tool
 *   - the qmd version the copy was taken from
 *
 * Exit 0 = in sync · 1 = drift (read the report, re-sync src/mcp.ts, update
 * COPIED_FROM_QMD_VERSION) · 2 = the check itself could not run.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (code, msg) => {
  console.error(msg);
  process.exit(code);
};

/** The qmd version src/mcp.ts was copied from (kept in the source header). */
const ours = readFileSync(join(root, "src", "mcp.ts"), "utf-8");
const copiedFrom = /COPIED_FROM_QMD_VERSION = "([^"]+)"/.exec(ours)?.[1];
if (!copiedFrom) fail(2, "check-mcp-drift: src/mcp.ts has no COPIED_FROM_QMD_VERSION marker");

const require = createRequire(import.meta.url);
let pinned;
try {
  pinned = JSON.parse(readFileSync(require.resolve("@tobilu/qmd/package.json"), "utf-8")).version;
} catch {
  // qmd's exports map blocks package.json on some versions — fall back to the path
  try {
    pinned = JSON.parse(readFileSync(join(root, "node_modules", "@tobilu", "qmd", "package.json"), "utf-8")).version;
  } catch {
    fail(2, "check-mcp-drift: cannot read the installed @tobilu/qmd package.json");
  }
}

const upstreamPath = join(root, "node_modules", "@tobilu", "qmd", "dist", "mcp", "server.js");
let upstream;
try {
  upstream = readFileSync(upstreamPath, "utf-8");
} catch {
  fail(2, `check-mcp-drift: cannot read ${upstreamPath} — did qmd's layout change?`);
}

/** Tool names from `registerTool("name", …)` occurrences. */
const toolNames = (src) => [...src.matchAll(/registerTool\(\s*["']([^"']+)["']/g)].map((m) => m[1]).sort();

/**
 * Input-schema keys per tool: the block between a registerTool call and the
 * next one, scanned for `key: z.` property definitions. Coarse on purpose —
 * it catches added/removed/renamed parameters without depending on formatting.
 */
function schemaKeys(src) {
  const out = {};
  const calls = [...src.matchAll(/registerTool\(\s*["']([^"']+)["']/g)];
  for (let i = 0; i < calls.length; i++) {
    const start = calls[i].index;
    const end = i + 1 < calls.length ? calls[i + 1].index : src.length;
    const block = src.slice(start, end);
    const schema = /inputSchema:\s*(?:z\.object\(\{|\{)([\s\S]*?)\}\s*\)?,?\s*\}/.exec(block)?.[1] ?? "";
    out[calls[i][1]] = [...schema.matchAll(/(?:^|[\s{,])([A-Za-z_][\w]*)\s*:\s*z\./g)].map((m) => m[1]).sort();
  }
  return out;
}

const problems = [];
if (copiedFrom !== pinned) {
  problems.push(
    `qmd pin moved: src/mcp.ts was copied from ${copiedFrom}, the installed package is ${pinned}.\n` +
      `  → re-read node_modules/@tobilu/qmd/dist/mcp/server.js, re-sync src/mcp.ts, then set COPIED_FROM_QMD_VERSION = "${pinned}".`,
  );
}

const oursTools = toolNames(ours);
const theirsTools = toolNames(upstream);
if (oursTools.join(",") !== theirsTools.join(",")) {
  problems.push(`tool set drift:\n  ours:     ${oursTools.join(", ")}\n  upstream: ${theirsTools.join(", ")}`);
}

const oursKeys = schemaKeys(ours);
const theirsKeys = schemaKeys(upstream);
for (const tool of theirsTools) {
  if (!oursKeys[tool]) continue; // already reported as tool-set drift
  const a = (oursKeys[tool] ?? []).join(", ");
  const b = (theirsKeys[tool] ?? []).join(", ");
  if (a !== b) problems.push(`input schema drift in "${tool}":\n  ours:     ${a}\n  upstream: ${b}`);
}

if (problems.length > 0) {
  console.error(`check-mcp-drift: ${problems.length} problem(s) between src/mcp.ts and qmd ${pinned}:\n`);
  for (const p of problems) console.error(`- ${p}\n`);
  process.exit(1);
}
console.log(`check-mcp-drift: src/mcp.ts is in sync with @tobilu/qmd ${pinned} (tools: ${oursTools.join(", ")})`);
