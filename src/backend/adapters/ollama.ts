/**
 * Ollama remote adapter (native /api/* endpoints).
 *
 * Endpoints (all POST):
 *   embed  → {base}/api/embed   { model, input }   → { embedding } (singular) or { embeddings: [...] } (array input)
 *   rerank → {base}/api/rerank  { model, query, documents } → { results: [{ index, score }] }
 *   expand → {base}/api/chat    { model, messages, stream: false, options } → { message: { content } }
 *
 * Same failure policy as the openai-compat adapter: embed and rerank THROW on
 * provider failure (never a silent local fallback); expand degrades to the
 * original query.
 */
import type {
  QmdEmbedOptions,
  QmdEmbeddingResult,
  QmdGenerateOptions,
  QmdGenerateResult,
  QmdQueryable,
  QmdRerankDocument,
  QmdRerankResult,
  RemoteJobConfig,
} from "../types.js";
import {
  DEFAULT_EXPAND_MAX_TOKENS,
  DEFAULT_RERANK_MAX_CHARS,
  DEFAULT_TIMEOUT_MS,
  expandViaComplete,
  postJson,
  truncateText,
} from "./shared.js";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

interface OllamaEmbedResponse {
  embedding?: number[];
  embeddings?: number[][];
  error?: string;
}
interface OllamaRerankResponse {
  results?: { index?: number; score?: number }[];
  error?: string;
}
interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

export class OllamaAdapter {
  readonly jobName: "embed" | "rerank" | "expand";
  readonly job: RemoteJobConfig;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(jobName: "embed" | "rerank" | "expand", job: RemoteJobConfig) {
    if (job.provider !== "ollama") throw new Error(`qmd-remote: OllamaAdapter requires provider "ollama", got "${job.provider}"`);
    this.jobName = jobName;
    this.job = job;
    this.baseUrl = job.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
    this.timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Stable model identifier (feeds qmd's DB cache keys / embedding fingerprints). */
  get name(): string {
    return `api:ollama:${this.job.model}`;
  }

  private post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return postJson<T>(path, body, {
      baseUrl: this.baseUrl,
      label: `${this.jobName} (ollama ${this.job.model})`,
      apiKey: this.job.apiKey,
      extraHeaders: this.job.headers,
      timeoutMs: this.timeoutMs,
      maxRetries: this.job.maxRetries,
    });
  }

  async embed(text: string, options: QmdEmbedOptions = {}): Promise<QmdEmbeddingResult> {
    const res = await this.post<OllamaEmbedResponse>("/api/embed", { model: this.job.model, input: this.applyPrefix(text, options) });
    if (res.error) throw new Error(`qmd-remote: embed (ollama ${this.job.model}) failed: ${res.error}`);
    const embedding = res.embedding ?? res.embeddings?.[0];
    if (!embedding) throw new Error(`qmd-remote: embed (ollama ${this.job.model}) returned no embedding`);
    return { embedding, model: this.name };
  }

  /** Batch embed; short/holey responses yield `null` per position (see the openai-compat adapter). */
  async embedBatch(texts: string[], options: QmdEmbedOptions = {}): Promise<(QmdEmbeddingResult | null)[]> {
    if (texts.length === 0) return [];
    const res = await this.post<OllamaEmbedResponse>("/api/embed", {
      model: this.job.model,
      input: texts.map((t) => this.applyPrefix(t, options)),
    });
    if (res.error) throw new Error(`qmd-remote: embed (ollama ${this.job.model}) batch failed: ${res.error}`);
    const embeddings = res.embeddings ?? (res.embedding ? [res.embedding] : undefined);
    if (!embeddings || embeddings.length === 0) {
      throw new Error(`qmd-remote: embed (ollama ${this.job.model}) returned no embeddings for ${texts.length} inputs — the Ollama server must support array input on /api/embed`);
    }
    if (embeddings.length < texts.length) {
      console.error(
        `qmd-remote: embed (ollama ${this.job.model}) returned ${embeddings.length} of ${texts.length} embeddings — the missing chunks are reported as errors and retried`,
      );
    }
    return texts.map((_, i) => {
      const embedding = embeddings[i];
      return embedding ? { embedding, model: this.name } : null;
    });
  }

  // `options.model` is ignored on purpose — see the openai-compat adapter.
  async rerank(query: string, documents: QmdRerankDocument[], _options: { model?: string } = {}): Promise<QmdRerankResult> {
    const maxChars = this.job.rerankMaxChars ?? DEFAULT_RERANK_MAX_CHARS;
    const res = await this.post<OllamaRerankResponse>("/api/rerank", {
      model: this.job.model,
      query,
      documents: documents.map((d) => truncateText(d.text, maxChars)),
    });
    if (res.error) throw new Error(`qmd-remote: rerank (ollama ${this.job.model}) failed: ${res.error}`);
    if (!res.results) throw new Error(`qmd-remote: rerank (ollama ${this.job.model}) returned no results`);
    const results = res.results
      .map((r) => {
        const idx = r.index;
        if (typeof idx !== "number" || idx < 0 || idx >= documents.length) return null;
        return { file: documents[idx].file, score: r.score ?? 0, index: idx };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score);
    return { results, model: this.name };
  }

  async complete(prompt: string, options: QmdGenerateOptions = {}): Promise<string> {
    const res = await this.post<OllamaChatResponse>("/api/chat", {
      model: this.job.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? DEFAULT_EXPAND_MAX_TOKENS,
      },
    });
    if (res.error) throw new Error(`qmd-remote: chat (ollama ${this.job.model}) failed: ${res.error}`);
    const content = res.message?.content;
    if (typeof content !== "string") throw new Error(`qmd-remote: chat (ollama ${this.job.model}) returned no content`);
    return content;
  }

  async expandQuery(query: string, options: { context?: string; includeLexical?: boolean } = {}): Promise<QmdQueryable[]> {
    return expandViaComplete(
      (prompt, opts) => this.complete(prompt, opts),
      query,
      options,
      this.job.expandMaxTokens ?? DEFAULT_EXPAND_MAX_TOKENS,
    );
  }

  async generate(prompt: string, options: QmdGenerateOptions = {}): Promise<QmdGenerateResult> {
    const text = await this.complete(prompt, options);
    return { text, model: this.name, done: true };
  }

  private applyPrefix(text: string, options: QmdEmbedOptions): string {
    const prefix = options.isQuery ? this.job.embedQueryPrefix : this.job.embedDocPrefix;
    return prefix ? `${prefix}${text}` : text;
  }
}
