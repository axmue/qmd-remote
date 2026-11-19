/**
 * qmd-remote — composite backend factory.
 *
 * Builds ONE object implementing qmd's full LLM runtime surface
 * (QmdLlmBackend), routing each job to:
 *   - a remote adapter (openai-compat / ollama) per the `jobs` config, or
 *   - a single shared local `LlamaCpp` instance (created only when at least
 *     one job is `local`, so all-remote setups never touch node-llama-cpp).
 *
 * The returned object is set as `store.internal.llm` on a qmd store (the
 * injection seam: qmd resolves every model job via `store.llm ??
 * getDefaultLlamaCpp()`).
 *
 * Naming: remote jobs report `api:<provider>:<model>` as their model name;
 * local jobs report LlamaCpp's resolved model URI. These stable strings feed
 * qmd's DB cache keys and embedding fingerprints, so a provider/model switch
 * reads as a model switch → stale embeddings get re-embedded by qmd's own
 * bookkeeping (and a provider/model with different dimensions triggers the
 * vec-table rebuild).
 *
 * Tokenization: qmd tokenizes with the embedding model for chunking. Remote
 * providers have no standard tokenizer endpoint, so when ALL jobs are remote
 * we use a lossless UTF-16 code-unit encode/decode: round-trips exactly
 * (detokenize reconstructs the text), and token COUNT is a (conservative)
 * overestimate — qmd's chunker self-corrects via the actual chars/token
 * ratio, so remote-mode chunks simply land ~3-4× smaller than local-mode
 * chunks. When at least one job is local, the real LlamaCpp tokenizer is
 * used instead.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { availableParallelism } from "node:os";
import { existsSync } from "node:fs";
import type {
  QmdDeviceInfo,
  QmdEmbedOptions,
  QmdGenerateOptions,
  QmdLlmBackend,
  QmdModelInfo,
  QmdRerankDocument,
  RemoteJobConfig,
  RemoteJobs,
} from "./types.js";
import { OpenAiCompatAdapter } from "./adapters/openai-compat.js";
import { OllamaAdapter } from "./adapters/ollama.js";
import { normalizeJobs } from "./config.js";

/** A (duck-typed) LlamaCpp constructor — the qmd package exports no types for it. */
export type QmdLlamaCppCtor = new (config?: Record<string, unknown>) => QmdLlmBackend;

export interface QmdBackendOptions {
  /**
   * Injectable LlamaCpp constructor (test hook). Default: the real one,
   * imported by file-URL from the installed @tobilu/qmd dist (the package
   * exports map blocks subpath imports; the exact 2.8.3 pin makes the
   * dist path as durable as any textual reference).
   */
  llamaCtor?: QmdLlamaCppCtor;
}

type RemoteAdapter = OpenAiCompatAdapter | OllamaAdapter;

function makeAdapter(jobName: keyof RemoteJobs, job: RemoteJobConfig): RemoteAdapter {
  switch (job.provider) {
    case "openai-compat":
      return new OpenAiCompatAdapter(jobName as "embed" | "rerank" | "expand", job);
    case "ollama":
      return new OllamaAdapter(jobName as "embed" | "rerank" | "expand", job);
    default:
      throw new Error(`qmd-remote: no remote adapter for provider "${job.provider}"`);
  }
}

/** The untyped qmd dist/llm.js module surface qmd-remote needs (pinned 2.8.3). */
interface QmdLlmModule {
  LlamaCpp?: QmdLlamaCppCtor;
  /** qmd's global-default setter (dist/llm.js, not re-exported from the package entry). */
  setDefaultLlamaCpp?: (llm: unknown) => void;
}

/**
 * Import the installed qmd package's dist/llm.js. qmd's exports map blocks
 * subpath imports and has no `require` condition, so the module must be
 * loaded from its file path. Resolution order:
 *   1. `import.meta.resolve("@tobilu/qmd")` → the real entry point, then
 *      `../dist/llm.js` next to it. This is the only form that works on
 *      pnpm's symlinked store and Yarn PnP.
 *   2. walk up from this file looking for `node_modules/@tobilu/qmd` (classic
 *      hoisted npm trees, and anything where (1) is unavailable).
 * The exact 2.8.3 pin makes the dist path as durable as any textual reference.
 */
async function importQmdLlmModule(): Promise<QmdLlmModule> {
  const candidates: string[] = [];
  try {
    const entry = fileURLToPath(import.meta.resolve("@tobilu/qmd"));
    candidates.push(join(dirname(entry), "llm.js"), join(dirname(entry), "dist", "llm.js"));
  } catch {
    /* no resolver (bundled/older runtime) — fall through to the walk */
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    candidates.push(join(dir, "node_modules", "@tobilu/qmd", "dist", "llm.js"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const mod = (await import(pathToFileURL(candidate).href)) as QmdLlmModule;
    if (!mod.LlamaCpp) throw new Error(`qmd-remote: ${candidate} exports no LlamaCpp — package layout changed? (pinned 2.8.3)`);
    return mod;
  }
  throw new Error(
    "qmd-remote: cannot locate the installed @tobilu/qmd package (a local qmd job is configured) — " +
      `is it installed? (looked for dist/llm.js in ${candidates.length} locations)`,
  );
}

async function importLlamaCppCtor(): Promise<QmdLlamaCppCtor> {
  return (await importQmdLlmModule()).LlamaCpp!;
}

/**
 * qmd's `setDefaultLlamaCpp` (dist/llm.js) — the global-default seam. Needed
 * because qmd 2.8.3's `chunkDocumentByTokens` (dist/store.js, called by
 * `generateEmbeddings`) resolves its tokenizer via the global
 * `getDefaultLlamaCpp()`, NOT the store's injected `llm` slot.
 */
export async function importSetDefaultLlamaCpp(): Promise<(llm: unknown) => void> {
  const mod = await importQmdLlmModule();
  if (!mod.setDefaultLlamaCpp) throw new Error("qmd-remote: installed @tobilu/qmd exports no setDefaultLlamaCpp — package layout changed? (pinned 2.8.3)");
  return mod.setDefaultLlamaCpp;
}

/**
 * Build the composite qmd LLM backend.
 * Accepts a raw (or normalized) `jobs` block — it is normalized first, so
 * typos/malformations fail here with a config-path-naming error. Throws on
 * misconfigured REMOTE jobs (adapter constructors validate); local jobs
 * cannot fail at construction (LlamaCpp loads lazily).
 */
export async function createBackend(rawJobs: unknown, options: QmdBackendOptions = {}): Promise<QmdLlmBackend> {
  const jobs = normalizeJobs(rawJobs);
  const hasLocal = Object.values(jobs).some((j) => j.provider === "local");

  const remote: Record<keyof RemoteJobs, RemoteAdapter | null> = {
    embed: jobs.embed.provider === "local" ? null : makeAdapter("embed", jobs.embed),
    rerank: jobs.rerank.provider === "local" ? null : makeAdapter("rerank", jobs.rerank),
    expand: jobs.expand.provider === "local" ? null : makeAdapter("expand", jobs.expand),
  };

  const llama: QmdLlmBackend | null = hasLocal ? new (options.llamaCtor ?? (await importLlamaCppCtor()))() : null;

  // Stable names, snapshotted at construction (LlamaCpp's getters are constant
  // after construction).
  const embedModelName = remote.embed ? remote.embed.name : llama!.embedModelName;
  const generateModelName = remote.expand ? remote.expand.name : llama!.generateModelName;
  const rerankModelName = remote.rerank ? remote.rerank.name : llama!.rerankModelName;

  // All-remote: lossless code-unit tokenization (see header comment).
  const tokenizeAllRemote = (text: string): number[] => {
    const out = new Array<number>(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  };
  const detokenizeAllRemote = (tokens: readonly number[]): string => {
    let s = "";
    for (let i = 0; i < tokens.length; i += 8192) s += String.fromCharCode(...tokens.slice(i, i + 8192));
    return s;
  };

  return {
    get embedModelName() {
      return embedModelName;
    },
    get generateModelName() {
      return generateModelName;
    },
    get rerankModelName() {
      return rerankModelName;
    },

    embed: (text: string, options?: QmdEmbedOptions) =>
      remote.embed ? remote.embed.embed(text, options) : llama!.embed(text, options),
    embedBatch: (texts: string[], options?: QmdEmbedOptions) =>
      remote.embed ? remote.embed.embedBatch(texts, options) : llama!.embedBatch(texts, options),
    generate: (prompt: string, options?: QmdGenerateOptions) =>
      remote.expand ? remote.expand.generate(prompt, options) : llama!.generate(prompt, options),
    expandQuery: (query: string, options?: { context?: string; includeLexical?: boolean }) =>
      remote.expand ? remote.expand.expandQuery(query, options) : llama!.expandQuery(query, options),
    rerank: (query: string, documents: QmdRerankDocument[], options?: { model?: string }) =>
      remote.rerank ? remote.rerank.rerank(query, documents, options) : llama!.rerank(query, documents, options),

    async modelExists(modelUri: string): Promise<QmdModelInfo> {
      if (modelUri.startsWith("api:")) return { name: modelUri, exists: true };
      if (llama) return llama.modelExists(modelUri);
      const exists = existsSync(modelUri);
      return { name: modelUri, exists, path: exists ? modelUri : undefined };
    },

    tokenize: (text: string) => (llama ? llama.tokenize(text) : Promise.resolve(tokenizeAllRemote(text))),
    countTokens: async (text: string) => {
      const tokens = llama ? await llama.tokenize(text) : tokenizeAllRemote(text);
      return tokens.length;
    },
    detokenize: (tokens: readonly number[]) =>
      llama ? llama.detokenize(tokens) : Promise.resolve(detokenizeAllRemote(tokens)),

    async getDeviceInfo(): Promise<QmdDeviceInfo> {
      if (llama) return llama.getDeviceInfo();
      return { gpu: false, gpuOffloading: false, gpuDevices: [], cpuCores: availableParallelism() };
    },

    dispose: () => (llama ? llama.dispose() : Promise.resolve()),
  };
}
