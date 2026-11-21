/**
 * Regression test for the drift-check extraction itself (scripts/
 * check-mcp-drift.mjs exports). The check gates the VERBATIM MCP copy — if
 * its extractor stops seeing keys (e.g. the lazy schema regex truncating at
 * braces inside a `.describe("…")` string, the 2.9.0 `filter` describe), a
 * real drift passes silently. These tests pin the extractor's strength:
 * the former blind spot is covered, and a renamed key is detected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toolNames, schemaKeys, stripStringLiterals } from "../scripts/check-mcp-drift.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A registerTool block shaped like qmd's 2.9.0 `query` tool: the `filter`
 *  describe embeds nested `{...}}` braces, and KEYS FOLLOW IT. */
function fixture(renames: Record<string, string> = {}) {
  const k = (name: string) => renames[name] ?? name;
  return `
  server.registerTool("query", {
    inputSchema: z.object({
      query: z.string().optional().describe("Plain-text query."),
      filter: z.record(z.string(), z.unknown()).optional().describe("Metadata filter (recursive JSON AST). Groups: " +
        "{operator:'and'|'or', operands:[...]}, conditions {field, operator, value} — every result satisfies " +
        "{field:'type',operator:'eq'} style nodes {…}}"),
      ${k("intent")}: z.string().optional().describe("Background context."),
      ${k("rerank")}: z.boolean().optional().default(true).describe("Rerank results."),
    }),
  }, handler);
`;
}

test("keys after a nested-brace describe are still extracted (the old blind spot)", () => {
  const keys = schemaKeys(fixture())["query"] ?? [];
  for (const expected of ["query", "filter", "intent", "rerank"]) assert.ok(keys.includes(expected), `missing ${expected} in [${keys}]`);
});

test("a renamed key after the describe is detected as drift", () => {
  const before = schemaKeys(fixture())["query"]?.join(",");
  const after = schemaKeys(fixture({ intent: "purpose" }))["query"]?.join(",");
  assert.notEqual(before, after, "renaming intent→purpose must change the extracted key set");
});

test("stripStringLiterals removes brace-bearing strings, keeps code", () => {
  const stripped = stripStringLiterals('x: z.string().describe("a } b { c"), y: z.number().optional(),');
  assert.equal(stripped, 'x: z.string().describe(""), y: z.number().optional(),');
});

test("the REAL copy: the query tool extracts filter + the keys after it", () => {
  // If src/mcp.ts ever regresses to the truncation (or the copy drifts to a
  // shape the extractor can't see), this fails even when ours==theirs.
  const ours = readFileSync(join(root, "src", "mcp.ts"), "utf-8");
  assert.ok(toolNames(ours).length >= 5, "expected at least 5 tools in the copy");
  const keys = schemaKeys(ours)["query"] ?? [];
  for (const expected of ["query", "searches", "filter", "intent", "rerank"]) {
    assert.ok(keys.includes(expected), `real copy: missing ${expected} in [${keys}]`);
  }
});
