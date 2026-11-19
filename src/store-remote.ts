/**
 * qmd-remote — store helper (the patch-free injection seam, spec D2/D10).
 *
 * `createStoreRemote` builds a stock qmd store (`createStore`) and swaps its
 * LLM slot for a `createBackend` composite BEFORE any call: qmd resolves the
 * LLM of every search/embed path via `store.llm ?? getDefaultLlamaCpp()` on
 * the internal store, so one assignment covers search AND reindex. No patch.
 *
 * Seam completion (three qmd-internal capture wrinkles, all verified against
 * stock dist 2.8.3):
 *   - `store.searchVector` captured the pre-swap LlamaCpp's embedModelName →
 *     re-wired to the backend's name (one-line reassignment over the exposed
 *     `internal.searchVec`).
 *   - `chunkDocumentByTokens` (dist/store.js, called by `generateEmbeddings`
 *     → `store.embed()`) resolves its tokenizer via the GLOBAL
 *     `getDefaultLlamaCpp()`, not `store.llm` → the composite is also set as
 *     qmd's global default (dist/llm.js `setDefaultLlamaCpp`). Without this,
 *     an all-remote `embed` on a clean machine downloads + loads the default
 *     318 MB embedding model just to tokenize (spec D2's `getLlm(store)`
 *     claim covered embed/rerank/expand — not the chunking tokenizer).
 *   - `store.close` disposes the pre-swap instance (its closure) → wrapped so
 *     the backend (which may own a real LlamaCpp for local jobs) is disposed
 *     too.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createStore, type QMDStore } from "@tobilu/qmd";
import { createBackend, importSetDefaultLlamaCpp, type QmdLlamaCppCtor } from "./backend/factory.js";
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
 * getLocalDbPath (pinned 2.8.3): walking up from `startDir`, a `.qmd/index.yaml`
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
 * (pinned 2.8.3): INDEX_PATH env override, else a project-local
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
 * (pinned 2.8.3): $QMD_CONFIG_DIR, else a project-local `.qmd/index.y(a)ml`,
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

  // 3b. global-default seam (see header, wrinkle 2): route qmd's hardcoded
  //     `getDefaultLlamaCpp()` tokenizer path through the composite too.
  //     All-remote ⇒ lossless code-unit tokenizer (no download, no native
  //     lib); mixed ⇒ the shared local LlamaCpp the composite already owns.
  const setDefaultLlamaCpp = await importSetDefaultLlamaCpp();
  setDefaultLlamaCpp(backend);

  // 4a. seam completion: searchVector's closure still names the pre-swap
  //     LlamaCpp's embed model — re-wire it over the exposed internal.
  const internalStore = store.internal;
  store.searchVector = (query, opts) =>
    internalStore.searchVec(query, backend.embedModelName, opts?.limit, opts?.collection);

  // 4b. seam completion: close() disposes the closure's pre-swap LlamaCpp, not
  //     the swapped-in backend — dispose both.
  const originalClose = store.close.bind(store);
  store.close = async () => {
    await backend.dispose();
    await originalClose();
  };

  return store;
}
