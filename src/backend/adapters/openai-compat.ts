/**
 * OpenAI-compatible remote adapter (covers OpenRouter, Jina, Azure-OpenAI, …).
 *
 * Endpoints (all POST):
 *   embed  → {base}/embeddings       { model, input }                 → { data: [{ embedding, index? }] }
 *   rerank → {base}/rerank           { model, query, documents }       → { results: [{ index, relevance_score }] } (Jina style)
 *   expand → {base}/chat/completions { model, messages, max_tokens }   → { choices: [{ message: { content } }] }
 *
 * embed and rerank THROW on provider failure (a downed provider is a hard,
 * visible error — never a silent local fallback); expand degrades to the
 * original query like qmd's local fallback (see shared.expandViaComplete).
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

interface EmbedData {
  embedding?: number[];
  index?: number;
}
interface EmbedResponse {
  data?: EmbedData[];
  model?: string;
}
interface RerankResponse {
  results?: { index?: number; relevance_score?: number; score?: number }[];
  model?: string;
}
interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
}

export class OpenAiCompatAdapter {
  readonly jobName: "embed" | "rerank" | "expand";
  readonly job: RemoteJobConfig;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(jobName: "embed" | "rerank" | "expand", job: RemoteJobConfig) {
    if (job.provider !== "openai-compat") throw new Error(`qmd-remote: OpenAiCompatAdapter requires provider "openai-compat", got "${job.provider}"`);
    if (!job.baseUrl) throw new Error(`qmd-remote: ${jobName} job (openai-compat) requires a baseUrl`);
    this.jobName = jobName;
    this.job = job;
    this.baseUrl = job.baseUrl;
    this.timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Stable model identifier (feeds qmd's DB cache keys / embedding fingerprints). */
  get name(): string {
    return `api:openai-compat:${this.job.model}`;
  }

  private post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return postJson<T>(path, body, {
      baseUrl: this.baseUrl,
      label: `${this.jobName} (openai-compat ${this.job.model})`,
      apiKey: this.job.apiKey,
      extraHeaders: this.job.headers,
      timeoutMs: this.timeoutMs,
    });
  }

  async embed(text: string, options: QmdEmbedOptions = {}): Promise<QmdEmbeddingResult> {
    const res = await this.post<EmbedResponse>("/embeddings", { model: this.job.model, input: this.applyPrefix(text, options) });
    const first = res.data?.[0];
    if (!first?.embedding) throw new Error(`qmd-remote: embed (openai-compat ${this.job.model}) returned no embedding`);
    return { embedding: first.embedding, model: this.name };
  }

  async embedBatch(texts: string[], options: QmdEmbedOptions = {}): Promise<QmdEmbeddingResult[]> {
    if (texts.length === 0) return [];
    const res = await this.post<EmbedResponse>("/embeddings", {
      model: this.job.model,
      input: texts.map((t) => this.applyPrefix(t, options)),
    });
    if (!res.data || res.data.length !== texts.length) {
      throw new Error(`qmd-remote: embed (openai-compat ${this.job.model}) returned ${res.data?.length ?? 0} of ${texts.length} embeddings`);
    }
    const byIndex = new Map<number, number[]>();
    res.data.forEach((d, i) => byIndex.set(d.index ?? i, d.embedding!));
    return texts.map((_, i) => {
      const embedding = byIndex.get(i);
      if (!embedding) throw new Error(`qmd-remote: embed (openai-compat ${this.job.model}) batch response missing embedding at index ${i}`);
      return { embedding, model: this.name };
    });
  }

  async rerank(query: string, documents: QmdRerankDocument[], options: { model?: string } = {}): Promise<QmdRerankResult> {
    const maxChars = this.job.rerankMaxChars ?? DEFAULT_RERANK_MAX_CHARS;
    const res = await this.post<RerankResponse>("/rerank", {
      model: this.job.model,
      query,
      documents: documents.map((d) => truncateText(d.text, maxChars)),
      return_documents: false,
    });
    if (!res.results) throw new Error(`qmd-remote: rerank (openai-compat ${this.job.model}) returned no results`);
    const results = res.results
      .map((r, _i) => {
        const idx = r.index;
        if (typeof idx !== "number" || idx < 0 || idx >= documents.length) return null;
        const score = r.relevance_score ?? r.score ?? 0;
        return { file: documents[idx].file, score, index: idx };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score);
    return { results, model: this.name };
  }

  async complete(prompt: string, options: QmdGenerateOptions = {}): Promise<string> {
    const res = await this.post<ChatResponse>("/chat/completions", {
      model: this.job.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options.maxTokens ?? DEFAULT_EXPAND_MAX_TOKENS,
      temperature: options.temperature ?? 0.7,
    });
    const content = res.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`qmd-remote: chat/completions (openai-compat ${this.job.model}) returned no content`);
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

  /** Two-tower embed models distinguish query/passage via text prefixes. */
  private applyPrefix(text: string, options: QmdEmbedOptions): string {
    const prefix = options.isQuery ? this.job.embedQueryPrefix : this.job.embedDocPrefix;
    return prefix ? `${prefix}${text}` : text;
  }
}
