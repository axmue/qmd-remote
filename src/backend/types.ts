/**
 * qmd-remote — shared types.
 *
 * A backend object replaces qmd's local node-llama-cpp LLM (the `LlamaCpp`
 * class in @tobilu/qmd's dist/llm.js). qmd resolves every model job —
 * embedding, reranking, query expansion, tokenization — through a single
 * duck-typed LLM object (`store.llm ?? getDefaultLlamaCpp()` in
 * dist/store.js). The interface below mirrors that runtime surface: the
 * qmd package exports no types for it, and no pin-guarantee, so the mirror
 * is validated at runtime by the contract tests.
 */

// =============================================================================
// Job configuration (the `jobs` block the user writes in their config file)
// =============================================================================

/** Which model backend serves a qmd job. */
export type RemoteProvider = "local" | "openai-compat" | "ollama";

/** One qmd job (embed / rerank / expand) configuration. */
export interface RemoteJobConfig {
  /** `local` = qmd's node-llama-cpp models (default); `openai-compat` = any OpenAI-style API (OpenRouter, Jina, …); `ollama` = a local Ollama server. */
  provider: RemoteProvider;
  /** API base URL. `openai-compat`: required (e.g. "https://api.jina.ai/v1"). `ollama`: optional (default "http://127.0.0.1:11434"). Ignored for local. */
  baseUrl?: string;
  /** provider model name (required for non-local jobs). */
  model?: string;
  /**
   * API key (openai-compat; ignored for local). Three forms:
   * `"sk-…"` literal, `"env:VAR_NAME"` (read from the environment at load
   * time), `"file:~/.secrets/key"` (first line of a file). The indirections
   * keep provider keys out of the config file — see src/backend/secrets.ts.
   */
  apiKey?: string;
  /** per-request wall-clock cap in ms (default 60000). */
  timeoutMs?: number;
  /** retries for retryable failures (HTTP 429/5xx, network errors); default 2, max 10, 0 disables. */
  maxRetries?: number;
  /** extra request headers for openai-compat (e.g. OpenRouter's "Referer" / "X-Title"). */
  headers?: Record<string, string>;
  /** embed job only: text prefix applied to QUERY-side embeddings (the single `embed(..., { isQuery: true })` call). Two-tower embed models (Jina v3) distinguish query/passage via text prefixes. Absent = no prefix. */
  embedQueryPrefix?: string;
  /** embed job only: text prefix applied to DOCUMENT-side embeddings (absent = no prefix). */
  embedDocPrefix?: string;
  /** rerank job only: truncate each document to this many chars before sending (default 8000). */
  rerankMaxChars?: number;
  /** expand job only: max completion tokens (default 600). */
  expandMaxTokens?: number;
}

/** The three qmd model jobs. All default to `{ provider: "local" }`. */
export interface RemoteJobs {
  embed: RemoteJobConfig;
  rerank: RemoteJobConfig;
  expand: RemoteJobConfig;
}

// =============================================================================
// The qmd LLM runtime surface (duck-typed mirror of the LLM interface in
// @tobilu/qmd dist/llm.js — the package exports no types for it). qmd calls
// these on `store.llm ?? getDefaultLlamaCpp()`; methods returning nullable
// values mirror LlamaCpp's failure semantics, EXCEPT the three remote job
// methods (embed / rerank / expandQuery), which THROW on provider failure —
// a downed provider is a hard, visible error, never a silent local fallback.
// =============================================================================

export interface QmdEmbeddingResult {
  embedding: number[];
  /** stable model identifier (feeds qmd's DB cache keys / embedding fingerprints). */
  model: string;
}

export interface QmdGenerateResult {
  text: string;
  model: string;
  done: boolean;
}

export interface QmdRerankDocument {
  file: string;
  text: string;
  title?: string;
}

export interface QmdRerankDocumentResult {
  file: string;
  /** relevance score, higher = more relevant. */
  score: number;
  /** index into the documents array the caller passed. */
  index: number;
}

export interface QmdRerankResult {
  results: QmdRerankDocumentResult[];
  model: string;
}

export type QmdQueryType = "lex" | "vec" | "hyde";

export interface QmdQueryable {
  type: QmdQueryType;
  text: string;
}

export interface QmdEmbedOptions {
  model?: string;
  isQuery?: boolean;
  title?: string;
}

export interface QmdGenerateOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface QmdModelInfo {
  name: string;
  exists: boolean;
  path?: string;
}

export interface QmdDeviceInfo {
  gpu: string | false;
  gpuOffloading: boolean;
  gpuDevices: string[];
  vram?: { total: number; used: number; free: number };
  cpuCores: number;
}

/** The full runtime surface the backend object must implement. */
export interface QmdLlmBackend {
  /** stable model names — they feed qmd's DB cache keys + embedding fingerprints. */
  readonly embedModelName: string;
  readonly generateModelName: string;
  readonly rerankModelName: string;
  embed(text: string, options?: QmdEmbedOptions): Promise<QmdEmbeddingResult | null>;
  embedBatch(texts: string[], options?: QmdEmbedOptions): Promise<(QmdEmbeddingResult | null)[]>;
  generate(prompt: string, options?: QmdGenerateOptions): Promise<QmdGenerateResult | null>;
  expandQuery(query: string, options?: { context?: string; includeLexical?: boolean }): Promise<QmdQueryable[]>;
  rerank(query: string, documents: QmdRerankDocument[], options?: { model?: string }): Promise<QmdRerankResult>;
  modelExists(modelUri: string): Promise<QmdModelInfo>;
  tokenize(text: string): Promise<readonly number[]>;
  countTokens(text: string): Promise<number>;
  detokenize(tokens: readonly number[]): Promise<string>;
  getDeviceInfo(): Promise<QmdDeviceInfo>;
  dispose(): Promise<void>;
}
