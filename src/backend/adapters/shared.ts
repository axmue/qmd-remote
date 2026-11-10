/**
 * Shared plumbing for the remote qmd job adapters: HTTP post helper,
 * document truncation, and the query-expansion prompt/parse (mirroring the
 * parsing qmd's local expandQuery uses, incl. its soft fallback semantics).
 */
import type { QmdGenerateOptions, QmdQueryable, QmdQueryType } from "../types.js";
import { redactSecrets } from "../secrets.js";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_RERANK_MAX_CHARS = 8_000;
export const DEFAULT_EXPAND_MAX_TOKENS = 600;
/** Retryable failures get this many extra attempts by default (429 is the normal case on metered APIs). */
export const DEFAULT_MAX_RETRIES = 2;
/** Base delay for the exponential backoff (ms) — overridable for tests. */
export const RETRY_BASE_DELAY_MS = 500;
/** Never wait longer than this between attempts, whatever `Retry-After` says. */
export const RETRY_MAX_DELAY_MS = 30_000;

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
  /** extra attempts for retryable failures (default DEFAULT_MAX_RETRIES). */
  maxRetries?: number;
  /** test hook: sleep implementation (default a real timer). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** HTTP statuses worth another attempt: rate limits and transient server faults. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600 && status !== 501);
}

/**
 * `Retry-After` is either delta-seconds or an HTTP date. Returns ms, or null
 * when the header is absent/unparseable.
 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_MAX_DELAY_MS);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), RETRY_MAX_DELAY_MS);
  return null;
}

/**
 * POST JSON to `${baseUrl}${path}`. Throws on HTTP errors and timeouts with
 * a provider-identifying message (a downed provider is a hard, visible error
 * — callers do NOT fall back to local models).
 *
 * Retries 429/5xx/network failures with exponential backoff honouring
 * `Retry-After`: metered providers (OpenRouter, Jina) rate-limit long embed
 * runs, and a hard failure there costs the user a whole batch. Timeouts and
 * 4xx (auth, bad request) are NOT retried — they are configuration errors and
 * must fail fast. Every printed detail goes through `redactSecrets` because
 * some gateways echo the request (incl. Authorization) in error payloads.
 */
export async function postJson<T = Record<string, unknown>>(path: string, body: unknown, opts: PostOpts): Promise<T> {
  const url = opts.baseUrl.replace(/\/+$/, "") + path;
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.extraHeaders };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const payload = JSON.stringify(body);
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  const fail = (reason: string, attempts: number): Error =>
    new Error(redactSecrets(`qmd-remote: ${opts.label} request to ${url} failed: ${reason}${attempts > 1 ? ` (after ${attempts} attempts)` : ""}`));

  for (let attempt = 0; ; attempt++) {
    const last = attempt >= maxRetries;
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(opts.timeoutMs) });
    } catch (err) {
      // A timeout is the user's `timeoutMs` budget being spent — retrying it
      // multiplies the wall-clock wait, so only true network errors retry.
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      const reason = timedOut ? `timed out after ${opts.timeoutMs} ms` : err instanceof Error ? err.message : String(err);
      if (timedOut || last) throw fail(reason, attempt + 1);
      await sleep(Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS));
      continue;
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      if (!last && isRetryableStatus(res.status)) {
        const wait = parseRetryAfter(res.headers.get("retry-after")) ?? Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
        await sleep(wait);
        continue;
      }
      throw fail(`HTTP ${res.status} ${detail}`, attempt + 1);
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw fail(`invalid JSON response: ${err instanceof Error ? err.message : err}`, attempt + 1);
    }
  }
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
    // Soft fallback (qmd's own local semantics): a downed expand provider
    // degrades the query instead of killing the search. This is the ONE
    // exception to the fail-loud rule (spec D7) — `doctor` therefore probes
    // the expand job through `generate()`, which throws.
    console.error(redactSecrets(`qmd-remote: remote query expansion failed, falling back to the plain query: ${err instanceof Error ? err.message : err}`));
    const fallback: QmdQueryable[] = [{ type: "vec", text: query }];
    if (includeLexical) fallback.unshift({ type: "lex", text: query });
    return fallback;
  }
}
