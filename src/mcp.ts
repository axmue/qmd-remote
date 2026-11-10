/**
 * qmd-remote MCP server — the thin agent-facing door (spec D3).
 *
 * The tool surface (4 tools + the qmd:// resource + instructions) is COPIED
 * verbatim from qmd 2.8.3's internal createMcpServer(dist/mcp/server.js:122 —
 * not exported; its exported entries build their own store with no injection
 * point, so a patch-free package must carry its own copy). Descriptions and
 * zod schemas are re-synced DELIBERATELY when the qmd pin changes (D11 flow)
 * — never silently.
 *
 * Server SDK + zod are pinned to qmd 2.8.3's exact versions so a consumer
 * tree carries one MCP SDK and identical protocol-era behavior.
 *
 * Stdio purity: this module must never write to stdout outside protocol
 * frames (no console.log in the server path; console.error is safe).
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { extractSnippet, addLineNumbers, DEFAULT_MULTI_GET_MAX_BYTES, type QMDStore } from "@tobilu/qmd";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// =============================================================================
// Helpers (copied from dist/mcp/server.js:26-48)
// =============================================================================

/** Encode a path for use in qmd:// URIs (slashes preserved). */
function encodeQmdPath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

interface SummaryHit {
  docid: string;
  score: number;
  file: string;
  title: string;
}

function formatSearchSummary(results: SummaryHit[], query: string): string {
  if (results.length === 0) {
    return `No results found for "${query}"`;
  }
  const lines = [`Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n`];
  for (const r of results) {
    lines.push(`${r.docid} ${Math.round(r.score * 100)}% ${r.file} - ${r.title}`);
  }
  return lines.join("\n");
}

function getPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// =============================================================================
// Inflight gate (our own — qmd's lives in an unexported subpath)
// =============================================================================

export class InflightGate {
  private active = 0;
  private waiters: Array<() => void> = [];
  /** Curried: track(cb) → a drop-in replacement for cb that counts in-flight calls. */
  track<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
    return async (...args: A) => {
      this.active += 1;
      try {
        return await fn(...args);
      } finally {
        this.active -= 1;
        if (this.active === 0) {
          while (this.waiters.length > 0) this.waiters.shift()!();
        }
      }
    };
  }
  waitForIdle(timeoutMs = 10_000): Promise<boolean> {
    if (this.active === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

// =============================================================================
// Instructions (copied from dist/mcp/server.js:65-113; `qmd embed` →
// `qmd-remote embed` — the one deliberate wording delta)
// =============================================================================

async function buildInstructions(store: QMDStore): Promise<string> {
  const status = await store.getStatus();
  const globalCtx = await store.getGlobalContext();
  const lines: string[] = [];
  // --- What is this? ---
  lines.push(`QMD is your local search engine over ${status.totalDocuments} markdown documents.`);
  if (globalCtx) lines.push(`Context: ${globalCtx}`);
  // --- What's searchable? ---
  // Names only — per-collection counts/descriptions are available via `status`.
  const collections = await store.listCollections();
  if (collections.length > 0) {
    lines.push("");
    const names = collections.map((c) => c.name).join(", ");
    lines.push(`Collections (scope with \`collections\` parameter): ${names}`);
    lines.push("Call the `status` tool for collection descriptions, paths, and per-collection doc counts.");
  }
  // --- Capability gaps ---
  if (!status.hasVectorIndex) {
    lines.push("");
    lines.push("Note: No vector embeddings yet. Run `qmd-remote embed` to enable semantic search (vec/hyde).");
  } else if (status.needsEmbedding > 0) {
    lines.push("");
    lines.push(`Note: ${status.needsEmbedding} documents need embedding. Run \`qmd-remote embed\` to update.`);
  }
  // --- Search tool ---
  lines.push("");
  lines.push("Search: Use `query` with sub-queries (lex/vec/hyde):");
  lines.push("  - type:'lex' — BM25 keyword search (exact terms, fast)");
  lines.push("  - type:'vec' — semantic vector search (meaning-based)");
  lines.push("  - type:'hyde' — hypothetical document (write what the answer looks like)");
  lines.push("");
  lines.push("  Always provide `intent` on every search call to disambiguate and improve snippets.");
  lines.push("");
  lines.push("Examples:");
  lines.push("  Quick keyword lookup: [{type:'lex', query:'error handling'}]");
  lines.push("  Semantic search: [{type:'vec', query:'how to handle errors gracefully'}]");
  lines.push("  Best results: [{type:'lex', query:'error'}, {type:'vec', query:'error handling best practices'}]");
  lines.push("  With intent: searches=[{type:'lex', query:'performance'}], intent='web page load times'");
  // --- Retrieval workflow ---
  lines.push("");
  lines.push("Retrieval:");
  lines.push("  - `get` — single document by path or docid (#abc123). Supports a line-range suffix: `file.md:100` (from line 100) or `file.md:100:40` (40 lines from line 100).");
  lines.push("  - `multi_get` — batch retrieve by glob (`journals/2025-05*.md`), comma-separated list, or docids (#abc123).");
  // --- Non-obvious things that prevent mistakes ---
  lines.push("");
  lines.push("Tips:");
  lines.push("  - File paths in results are relative to their collection.");
  lines.push("  - Use `minScore: 0.5` to filter low-confidence results.");
  lines.push("  - Results include a `context` field describing the content type.");
  return lines.join("\n");
}

// =============================================================================
// Server
// =============================================================================

export interface QmdRemoteMcpServerOptions {
  /** inflight gate for clean shutdown (default: a fresh gate) */
  inflight?: InflightGate;
}

/**
 * Build the qmd-remote MCP server over a prepared (remote-wired) qmd store.
 * Tool names/descriptions/schemas mirror qmd 2.8.3's MCP server.
 */
export async function createQmdRemoteMcpServer(store: QMDStore, options: QmdRemoteMcpServerOptions = {}): Promise<McpServer> {
  const inflight = options.inflight ?? new InflightGate();
  const track = inflight.track.bind(inflight);
  const server = new McpServer({ name: "qmd-remote", version: getPackageVersion() }, {
    instructions: await buildInstructions(store),
  });

  // Pre-fetch default collection names for search tools
  const defaultCollectionNames = await store.getDefaultCollectionNames();

  // ---------------------------------------------------------------------------
  // Resource: qmd://{path} — read-only access to documents by path
  // ---------------------------------------------------------------------------
  server.registerResource("document", new ResourceTemplate("qmd://{+path}", { list: undefined }), {
    title: "QMD Document",
    description: "A markdown document from your QMD knowledge base. Use search tools to discover documents.",
    mimeType: "text/markdown",
  }, track(async (uri, { path }) => {
    const pathStr = Array.isArray(path) ? path.join("/") : (path || "");
    const decodedPath = decodeURIComponent(pathStr);
    const result = await store.get(decodedPath, { includeBody: true });
    if ("error" in result) {
      const text = result.error === "excluded_by_ignore"
        ? `Document excluded by ignore rule: ${decodedPath}\nCollection: ${result.collection}\nMatched path: ${result.path}\nIgnore rule: ${result.rule}`
        : `Document not found: ${decodedPath}`;
      return { contents: [{ uri: uri.href, text }] };
    }
    let text = addLineNumbers(result.body || ""); // Default to line numbers
    if (result.context) {
      text = `<!-- Context: ${result.context} -->\n\n` + text;
    }
    return {
      contents: [{
        uri: uri.href,
        name: result.displayPath,
        title: result.title || result.displayPath,
        mimeType: "text/markdown",
        text,
      }],
    };
  }));

  // ---------------------------------------------------------------------------
  // Tool: query (Primary search tool) — description copied verbatim (qmd 2.8.3)
  // ---------------------------------------------------------------------------
  const subSearchSchema = z.object({
    type: z.enum(["lex", "vec", "hyde"]).describe("lex = BM25 keywords (supports \"phrase\" and -negation); " +
      "vec = semantic question; hyde = hypothetical answer passage"),
    query: z.string().describe("The query text. For lex: use keywords, \"quoted phrases\", and -negation. " +
      "For vec: natural language question. For hyde: 50-100 word answer passage."),
  });
  server.registerTool("query", {
    title: "Query",
    description: `Search the knowledge base using a query document — one or more typed sub-queries combined for best recall.

Each result includes a \`line\` field with the absolute 1-indexed line of the best match in the source markdown. To read more context around a hit, call \`get(file, fromLine = max(1, line - 20), maxLines = 80, lineNumbers = true)\`.

## Query Types

**lex** — BM25 keyword search. Fast, exact, no LLM needed.
Full lex syntax:
- \`term\` — prefix match ("perf" matches "performance")
- \`"exact phrase"\` — phrase must appear verbatim
- \`-term\` or \`-"phrase"\` — exclude documents containing this

Good lex examples:
- \`"connection pool" timeout -redis\`
- \`"machine learning" -sports -athlete\`
- \`handleError async typescript\`

**vec** — Semantic vector search. Write a natural language question. Finds documents by meaning, not exact words.
- \`how does the rate limiter handle burst traffic?\`
- \`what is the tradeoff between consistency and availability?\`

**hyde** — Hypothetical document. Write 50-100 words that look like the answer. Often the most powerful for nuanced topics.
- \`The rate limiter uses a token bucket algorithm. When a client exceeds 100 req/min, subsequent requests return 429 until the window resets.\`

## Strategy

Combine types for best results. First sub-query gets 2× weight — put your strongest signal first.

| Goal | Approach |
|------|----------|
| General search (recommended) | Pass \`query\` — auto-expanded into typed variants, fused, reranked |
| Know exact term/name | \`lex\` only |
| Concept search | \`vec\` only |
| Best recall | \`lex\` + \`vec\` |
| Complex/nuanced | \`lex\` + \`vec\` + \`hyde\` |
| Unknown vocabulary | Pass \`query\` with natural language so the server auto-expands it |

## Examples

Simple lookup:
\`\`\`json
[{ "type": "lex", "query": "CAP theorem" }]
\`\`\`

Best recall on a technical topic:
\`\`\`json
[
  { "type": "lex", "query": "\\"connection pool\\" timeout -redis" },
  { "type": "vec", "query": "why do database connections time out under load" },
  { "type": "hyde", "query": "Connection pool exhaustion occurs when all connections are in use and new requests must wait. This typically happens under high concurrency when queries run longer than expected." }
]
\`\`\`

Intent-aware lex (C++ performance, not sports):
\`\`\`json
[
  { "type": "lex", "query": "\\"C++ performance\\" optimization -sports -athlete" },
  { "type": "vec", "query": "how to optimize C++ program performance" }
]
\`\`\``,
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: z.object({
      query: z.string().optional().describe("Plain-text query, auto-expanded by the SDK into lex/vec/hyde variants, fused via " +
        "RRF and reranked. Recommended default for most searches. Mutually exclusive with 'searches'."),
      searches: z.array(subSearchSchema).max(10).optional().describe("Typed sub-queries to execute (lex/vec/hyde). First gets 2x weight. Use for precise " +
        "control over retrieval strategy. Mutually exclusive with 'query'."),
      limit: z.number().optional().default(10).describe("Max results (default: 10)"),
      minScore: z.number().optional().default(0).describe("Min relevance 0-1 (default: 0)"),
      candidateLimit: z.number().optional().describe("Maximum candidates to rerank (default: 40, lower = faster but may miss results)"),
      collections: z.array(z.string()).optional().describe("Filter to collections (OR match)"),
      intent: z.string().optional().describe("Background context to disambiguate the query. Example: query='performance', intent='web page load times and Core Web Vitals'. Does not search on its own."),
      rerank: z.boolean().optional().default(true).describe("Rerank results using LLM (default: true). Set to false for faster results on CPU-only machines."),
    }),
  }, track(async ({ query, searches, limit, minScore, candidateLimit, collections, intent, rerank }) => {
    if (!query && (!searches || searches.length === 0)) {
      return {
        content: [{ type: "text" as const, text: "Error: provide either 'query' (plain text) or 'searches' (typed sub-queries)" }],
        isError: true,
      };
    }
    if (query && searches && searches.length > 0) {
      return {
        content: [{ type: "text" as const, text: "Error: 'query' and 'searches' are mutually exclusive; provide only one" }],
        isError: true,
      };
    }
    const effectiveCollections = collections ?? defaultCollectionNames;
    const searchOptions = query
      ? { query }
      : { queries: (searches ?? []).map((s) => ({ type: s.type, query: s.query })) };
    const results = await store.search({
      ...searchOptions,
      collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
      limit,
      minScore,
      candidateLimit,
      rerank,
      intent,
    });
    const primaryQuery =
      query ||
      searches?.find((s) => s.type === "lex")?.query ||
      searches?.find((s) => s.type === "vec")?.query ||
      searches?.[0]?.query ||
      "";
    const filtered = results.map((r) => {
      const { line, snippet } = extractSnippet(r.body, primaryQuery, 300, r.bestChunkPos, r.bestChunk.length, intent);
      return {
        docid: `#${r.docid}`,
        file: r.displayPath,
        title: r.title,
        score: Math.round(r.score * 100) / 100,
        context: r.context,
        line,
        snippet: addLineNumbers(snippet, line),
      };
    });
    return {
      content: [{ type: "text" as const, text: formatSearchSummary(filtered, primaryQuery) }],
      structuredContent: { results: filtered },
    };
  }));

  // ---------------------------------------------------------------------------
  // Tool: get (Retrieve document) — copied verbatim (qmd 2.8.3)
  // ---------------------------------------------------------------------------
  server.registerTool("get", {
    title: "Get Document",
    description: "Retrieve the full content of a document by its file path or docid. Use paths or docids (#abc123) from search results. Suggests similar files if not found.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: z.object({
      file: z.string().describe("File path or docid from search results. Supports a line-range suffix: 'pages/meeting.md:100' starts at line 100; 'pages/meeting.md:100:40' (or '#abc123:100:40') reads 40 lines from line 100."),
      fromLine: z.number().optional().describe("Start from this line number (1-indexed)"),
      maxLines: z.number().optional().describe("Maximum number of lines to return"),
      lineNumbers: z.boolean().optional().default(true).describe("Add line numbers to output (format: 'N: content'). On by default; set false for raw content."),
    }),
  }, track(async ({ file, fromLine, maxLines, lineNumbers }) => {
    let parsedFromLine = fromLine;
    let parsedMaxLines = maxLines;
    let lookup = file;
    const rangeMatch = lookup.match(/:(\d+):(\d+)$/);
    if (rangeMatch) {
      if (parsedFromLine === undefined) parsedFromLine = parseInt(rangeMatch[1]!, 10);
      if (parsedMaxLines === undefined) parsedMaxLines = parseInt(rangeMatch[2]!, 10);
      lookup = lookup.slice(0, -rangeMatch[0].length);
    } else {
      const colonMatch = lookup.match(/:(\d+)$/);
      if (colonMatch && colonMatch[1] && parsedFromLine === undefined) {
        parsedFromLine = parseInt(colonMatch[1], 10);
        lookup = lookup.slice(0, -colonMatch[0].length);
      }
    }
    if (parsedFromLine !== undefined) parsedFromLine = Math.max(1, parsedFromLine);
    const result = await store.get(lookup, { includeBody: false });
    if ("error" in result) {
      let msg = result.error === "excluded_by_ignore"
        ? `Document excluded by ignore rule: ${file}\nCollection: ${result.collection}\nMatched path: ${result.path}\nIgnore rule: ${result.rule}`
        : `Document not found: ${file}`;
      if (result.error === "not_found" && result.similarFiles.length > 0) {
        msg += `\n\nDid you mean one of these?\n${result.similarFiles.map((s) => `  - ${s}`).join("\n")}`;
      }
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
    const body = (await store.getDocumentBody(result.filepath, { fromLine: parsedFromLine, maxLines: parsedMaxLines })) ?? "";
    let text = body;
    if (lineNumbers) {
      const startLine = parsedFromLine || 1;
      text = addLineNumbers(text, startLine);
    }
    if (result.context) {
      text = `<!-- Context: ${result.context} -->\n\n` + text;
    }
    return {
      content: [{
        type: "resource" as const,
        resource: {
          uri: `qmd://${encodeQmdPath(result.displayPath)}`,
          name: result.displayPath,
          title: result.title,
          mimeType: "text/markdown",
          text,
        },
      }],
    };
  }));

  // ---------------------------------------------------------------------------
  // Tool: multi_get (Retrieve multiple documents) — copied verbatim (qmd 2.8.3)
  // ---------------------------------------------------------------------------
  server.registerTool("multi_get", {
    title: "Multi-Get Documents",
    description: "Retrieve multiple documents by glob pattern (e.g., 'journals/2025-05*.md'), comma-separated list, or docids. Skips files larger than maxBytes.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern, docid, or comma-separated list of file paths/docids"),
      maxLines: z.number().optional().describe("Maximum lines per file"),
      maxBytes: z.number().optional().default(DEFAULT_MULTI_GET_MAX_BYTES).describe("Skip files larger than this (default: 65536 = 64KB)"),
      lineNumbers: z.boolean().optional().default(true).describe("Add line numbers to output (format: 'N: content'). On by default; set false for raw content."),
    }),
  }, track(async ({ pattern, maxLines, maxBytes, lineNumbers }) => {
    const { docs, errors } = await store.multiGet(pattern, { includeBody: true, maxBytes: maxBytes || DEFAULT_MULTI_GET_MAX_BYTES });
    if (docs.length === 0 && errors.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No files matched pattern: ${pattern}` }],
        isError: true,
      };
    }
    const content: Array<
      | { type: "text"; text: string }
      | { type: "resource"; resource: { uri: string; name: string; title: string; mimeType: string; text: string } }
    > = [];
    if (errors.length > 0) {
      content.push({ type: "text", text: `Errors:\n${errors.join("\n")}` });
    }
    for (const result of docs) {
      if (result.skipped) {
        content.push({
          type: "text",
          text: `[SKIPPED: ${result.doc.displayPath} - ${result.skipReason}. Use 'qmd_get' with file="${result.doc.displayPath}" to retrieve.]`,
        });
        continue;
      }
      let text = result.doc.body || "";
      if (maxLines !== undefined) {
        const lines = text.split("\n");
        text = lines.slice(0, maxLines).join("\n");
        if (lines.length > maxLines) {
          text += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
        }
      }
      if (lineNumbers) {
        text = addLineNumbers(text);
      }
      if (result.doc.context) {
        text = `<!-- Context: ${result.doc.context} -->\n\n` + text;
      }
      content.push({
        type: "resource",
        resource: {
          uri: `qmd://${encodeQmdPath(result.doc.displayPath)}`,
          name: result.doc.displayPath,
          title: result.doc.title,
          mimeType: "text/markdown",
          text,
        },
      });
    }
    return { content };
  }));

  // ---------------------------------------------------------------------------
  // Tool: status (Index status) — copied verbatim (qmd 2.8.3)
  // ---------------------------------------------------------------------------
  server.registerTool("status", {
    title: "Index Status",
    description: "Show the status of the QMD index: collections, document counts, and health information.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: z.object({}),
  }, track(async () => {
    const status = await store.getStatus();
    const summary = [
      `QMD Index Status:`,
      `  Total documents: ${status.totalDocuments}`,
      `  Needs embedding: ${status.needsEmbedding}`,
      `  Vector index: ${status.hasVectorIndex ? "yes" : "no"}`,
      `  Collections: ${status.collections.length}`,
    ];
    for (const col of status.collections) {
      summary.push(`    - ${col.name}: ${col.path} (${col.documents} docs)`);
    }
    return {
      content: [{ type: "text" as const, text: summary.join("\n") }],
      structuredContent: status,
    };
  }));

  return server;
}
