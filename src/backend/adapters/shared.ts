/**
 * Shared plumbing for the remote qmd job adapters: HTTP post helper,
 * document truncation, and the query-expansion prompt/parse (mirroring the
 * parsing qmd's local expandQuery uses, incl. its soft fallback semantics).
 */
import type { QmdGenerateOptions, QmdQueryable, QmdQueryType } from "../types.js";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_RERANK_MAX_CHARS = 8_000;
export const DEFAULT_EXPAND_MAX_TOKENS = 600;

/** Truncate a document to maxChars (no-op when it fits). */
export function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

interface PostOpts {
  baseUrl: string;
  label: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs: number;
}

/**
 * POST JSON to `${baseUrl}${path}`. Throws on HTTP errors and timeouts with
 * a provider-identifying message (a downed provider is a hard, visible error
 * — callers do NOT fall back to local models).
 */
export async function postJson<T = Record<string, unknown>>(path: string, body: unknown, opts: PostOpts): Promise<T> {
  const url = opts.baseUrl.replace(/\/+$/, "") + path;
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.extraHeaders };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (err) {
    const reason = err instanceof Error ? (err.name === "TimeoutError" ? `timed out after ${opts.timeoutMs} ms` : err.message) : String(err);
    throw new Error(`qmd-remote: ${opts.label} request to ${url} failed: ${reason}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`qmd-remote: ${opts.label} request to ${url} failed: HTTP ${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

/**
 * Same expansion prompt + line grammar + parsing + fallback as qmd's local
 * `LlamaCpp.expandQuery` (src/llm.ts): one `type: text` line per variant.
 * On provider failure we mirror qmd's local semantics (log + degrade the
 * expansion to the original query) — we never switch to a local model; the
 * vec leg's remote embed failure still fails loudly.
 */
export const EXPAND_PROMPT = (query: string): string =>
  `/no_think Expand this search query: ${query}\n` +
  `Reply with 2 to 6 lines, each exactly in the form "type: text" where type is one of:` +
  ` lex (keyword or phrase variant), vec (semantic paraphrase),` +
  ` hyde (a short hypothetical passage answering the query). Nothing else.`;

export function parseExpansion(content: string, query: string, includeLexical: boolean): QmdQueryable[] {
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const hasQueryTerm = (text: string): boolean => {
    const lower = text.toLowerCase();
    if (queryTerms.length === 0) return true;
    return queryTerms.some((term) => lower.includes(term));
  };

  const queryables: QmdQueryable[] = content
    .trim()
    .split("\n")
    .map((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) return null;
      const type = line.slice(0, colonIdx).trim();
      if (type !== "lex" && type !== "vec" && type !== "hyde") return null;
      const text = line.slice(colonIdx + 1).trim();
      if (text === "" || !hasQueryTerm(text)) return null;
      return { type: type as QmdQueryType, text };
    })
    .filter((q): q is QmdQueryable => q !== null);

  const filtered = includeLexical ? queryables : queryables.filter((q) => q.type !== "lex");
  if (filtered.length > 0) return filtered;

  // qmd's in-prompt-failure fallback: the original query itself.
  const fallback: QmdQueryable[] = [
    { type: "hyde", text: `Information about ${query}` },
    { type: "lex", text: query },
    { type: "vec", text: query },
  ];
  return includeLexical ? fallback : fallback.filter((q) => q.type !== "lex");
}

export interface CompleteFn {
  (prompt: string, options?: QmdGenerateOptions): Promise<string>;
}

/** Run a remote expansion through a completion function; soft fallback on error. */
export async function expandViaComplete(
  complete: CompleteFn,
  query: string,
  options: { context?: string; includeLexical?: boolean } = {},
  maxTokens: number = DEFAULT_EXPAND_MAX_TOKENS,
): Promise<QmdQueryable[]> {
  const includeLexical = options.includeLexical ?? true;
  try {
    const content = await complete(EXPAND_PROMPT(query), { maxTokens, temperature: 0.7 });
    return parseExpansion(content, query, includeLexical);
  } catch (err) {
    console.error(`qmd-remote: remote query expansion failed: ${err instanceof Error ? err.message : err}`);
    const fallback: QmdQueryable[] = [{ type: "vec", text: query }];
    if (includeLexical) fallback.unshift({ type: "lex", text: query });
    return fallback;
  }
}
