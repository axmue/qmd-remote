/**
 * qmd-remote — store helper (the patch-free injection seam, spec D2/D10).
 *
 * `createStoreRemote` builds a stock qmd store (`createStore`) and swaps its
 * LLM slot for a `createBackend` composite BEFORE any call: qmd resolves the
 * LLM of every search/embed path via `store.llm ?? getDefaultLlamaCpp()` on
 * the internal store (dist/store.js:135, verified against pinned 2.9.0), so
 * one assignment covers search AND reindex. No patch.
 *
 * Seam completion (two qmd-internal capture wrinkles, verified against
 * pinned 2.9.0):
 *   - `store.searchVector` captures the pre-swap LlamaCpp from the
 *     `createStore` closure (dist/index.js) → re-wired to run the session-
 *     scoped query embed through the backend, mirroring qmd's own 2.9.0
 *     body (`withLLMSessionForLlm(backend, s => internal.searchVec(q,
 *     backend.embedModelName, limit, collection, s, undefined, filter))`).
 *   - `store.close` disposes the pre-swap instance (its closure) → wrapped so
 *     the backend (which may own a real LlamaCpp for local jobs) is disposed
 *     too.
 *
 * The 2.8.3 global-default tokenizer hole (chunking resolved its tokenizer
 * via `getDefaultLlamaCpp()`, forcing a 318 MB default-model download —
 * ADR-0003) is closed upstream in 2.9.0: `generateEmbeddings` chunks through
 * `chunkDocumentByTokensWithLlm(llm, …)` with the store's llm (dist/store.js:
 * 2262/2658). The `setDefaultLlamaCpp` workaround is retired; the CLI
 * clean-machine test remains the regression proof.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createStore, parseMetadataFilter, type QMDStore, type SearchResult } from "@tobilu/qmd";
import { createBackend, importWithLLMSessionForLlm, type QmdLlamaCppCtor } from "./backend/factory.js";
import { loadRemoteConfig } from "./config-file.js";

export type QmdStore = QMDStore;

/** The untyped LLM slot on qmd's internal store (the seam). */
interface InternalWithLlm {
  llm?: unknown;
}

/** qmd's own home resolution (dist/paths.js qmdHomedir): HOME/USERPROFILE before os.homedir(). */
function qmdHomedir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || homedir() || "/tmp";
}

/**
 * Project-local qmd index, mirroring dist/collections.js findLocalConfigPath +
 * getLocalDbPath (pinned 2.9.0): walking up from `startDir`, a `.qmd/index.yaml`
 * or `.qmd/index.yml` makes that directory the index root, with the sqlite file
 * next to it. Stock `qmd` prefers this over the global locations, so we must
 * too — otherwise a user inside such a project silently queries a different
 * (global, probably empty) index than the one `qmd` built.
 */
export function findLocalQmdIndex(startDir: string = process.cwd()): { configPath: string; dbPath: string } | undefined {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of ["index.yaml", "index.yml"]) {
      const configPath = join(dir, ".qmd", name);
      if (existsSync(configPath)) return { configPath, dbPath: join(dir, ".qmd", "index.sqlite") };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Stock qmd's default index DB path — mirrors dist/store.js getDefaultDbPath
 * (pinned 2.9.0): INDEX_PATH env override, else a project-local
 * `.qmd/index.sqlite` if one is found, else $XDG_CACHE_HOME|~/.cache/qmd/index.sqlite.
 * (qmd's own export throws outside its "production mode" flag, so we mirror
 * the resolution rules instead of calling it.)
 */
export function defaultQmdDbPath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.INDEX_PATH) return env.INDEX_PATH;
  if (!env.QMD_CONFIG_DIR) {
    const local = findLocalQmdIndex(cwd);
    if (local) return local.dbPath;
  }
  const cacheDir = env.XDG_CACHE_HOME || resolve(qmdHomedir(env), ".cache");
  return join(cacheDir, "qmd", "index.sqlite");
}

/**
 * Stock qmd's default config yaml path — mirrors dist/collections.js
 * (pinned 2.9.0): $QMD_CONFIG_DIR, else a project-local `.qmd/index.y(a)ml`,
 * else ($XDG_CONFIG_HOME|~/.config)/qmd/index.yml.
 */
export function defaultQmdConfigPath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.QMD_CONFIG_DIR) return join(env.QMD_CONFIG_DIR, "index.yml");
  const local = findLocalQmdIndex(cwd);
  if (local) return local.configPath;
  const configHome = env.XDG_CONFIG_HOME || join(qmdHomedir(env), ".config");
  return join(configHome, "qmd", "index.yml");
}

export interface CreateStoreRemoteOptions {
  /** default: defaultQmdDbPath() (stock qmd location, spec D6) */
  dbPath?: string;
  /**
   * default: stock qmd's config yaml IF the file exists, else DB-only mode
   * (mirrors qmd's own MCP server). Pass null to force DB-only mode.
   */
  configPath?: string | null;
  /** raw or normalized jobs block; default: loadRemoteConfig() */
  jobs?: unknown;
  /** test hook, passed through to createBackend */
  llamaCtor?: QmdLlamaCppCtor;
}

export async function createStoreRemote(options: CreateStoreRemoteOptions = {}): Promise<QmdStore> {
  const dbPath = options.dbPath ?? defaultQmdDbPath();
  const stockConfigPath = defaultQmdConfigPath();
  const configPath = options.configPath === null ? undefined : options.configPath ?? (existsSync(stockConfigPath) ? stockConfigPath : undefined);

  // 1. stock store — eagerly builds its local LlamaCpp (lazy models; no
  //    download until first use). Replaced below before any call.
  const store = await createStore({ dbPath, ...(configPath ? { configPath } : {}) });

  // 2. the remote composite.
  const jobs = options.jobs ?? loadRemoteConfig().jobs;
  const backend = await createBackend(jobs, { llamaCtor: options.llamaCtor });

  // 3. the seam: swap the slot BEFORE any call. The replaced instance loaded
  //    nothing (lazy), so disposing it is cheap.
  const internal = store.internal as unknown as InternalWithLlm;
  if (internal.llm && internal.llm !== backend) {
    await (internal.llm as { dispose?: () => Promise<void> }).dispose?.();
  }
  internal.llm = backend;

  // 3b. seam completion: searchVector captures the pre-swap LlamaCpp from
  //     the createStore closure — re-wire it to run the query embed through
  //     the backend, mirroring qmd's own 2.9.0 body (session-scoped, metadata-
  //     filter aware; the internal searchVec resolves the llm via
  //     getLlm(store) for the embedding itself).
  const withLLMSessionForLlm = await importWithLLMSessionForLlm();
  const internalStore = store.internal;
  store.searchVector = async (q, opts) => {
    // Parsed before the session opens — mirrors qmd's own 2.9.0 body
    // (dist/index.js parses opts.filter, then withLLMSessionForLlm); async so
    // a malformed filter REJECTS like qmd's own searchVector, not a sync throw.
    const filter = opts?.filter === undefined ? undefined : parseMetadataFilter(opts.filter);
    return (await withLLMSessionForLlm(
      backend,
      (session) => {
        // The internal searchVec wrapper is typed for qmd's own session
        // class; ours is the same shape through the untyped dist import.
        return (internalStore.searchVec as (query: string, model: string, limit?: number, collection?: string | string[], session?: unknown, precomputedEmbedding?: unknown, filter?: unknown) => Promise<SearchResult[]>)(
          q, backend.embedModelName, opts?.limit, opts?.collection, session, undefined, filter,
        );
      },
      { signal: opts?.signal, name: "searchVector" },
    )) as SearchResult[];
  };

  // 4. seam completion: close() disposes the closure's pre-swap LlamaCpp, not
  //     the swapped-in backend — dispose both.
  const originalClose = store.close.bind(store);
  store.close = async () => {
    await backend.dispose();
    await originalClose();
  };

  return store;
}
