# P2 plan — `createStoreRemote` + config file + the e2e seam proof

**Status:** drafted 2026-10-31. Ready to start.
**Parent spec:** `docs/tmp/qmd-remote-package-spec.md` (D2, D6, D9, D10, D11).
**Predecessor:** P1 done — `createBackend(jobs)` + `normalizeJobs` + adapters, 17 green tests.

## Goal / definition of done

A user (or SDK consumer) can point a **real qmd store** at remote models with
one call, and the patch-free story is **proven end-to-end by a test**:
in-process `store.update()` + `store.embed()` + `store.search()` all route
through the injected backend (mock HTTP provider), no patch, no GGUF.

**Green gate (commit when met):** `npm run typecheck` clean + full suite green,
including the new e2e test which asserts: (a) `update()` indexes the docs,
(b) `embed()` hit the mock `/v1/embeddings` (write path), (c) `search()` hit
the mock for query-embed + rerank + expand (search path) and found the doc.

## Components

### P2.1 — Config file loading: `src/config-file.ts`

- `defaultConfigPath(): string` — `$QMD_REMOTE_CONFIG` if set, else
  `$XDG_CONFIG_HOME/qmd-remote/config.json` (default `~/.config/qmd-remote/config.json`).
- `loadRemoteConfig(path?: string): { jobs: RemoteJobs; source: string }`
  - file absent → `{ jobs: normalizeJobs(undefined), source: "default (all local)" }`
    (default-local is a *feature*, not an error — D6).
  - file present → parse JSON (loud error on invalid JSON, naming the path) →
    expected shape `{ "jobs": { … } }` → `normalizeJobs(o.jobs)`. Top-level
    keys other than `jobs` → loud error (typo protection; D9 single shape).
  - `source` = the resolved path (for `doctor` output in P3).
- Unit tests: absent file → all local; valid file → normalized; invalid JSON,
  unknown top-level key, malformed job → throws naming the path; env-var path
  override wins; `XDG_CONFIG_HOME` honored (env set/restored in test).

### P2.2 — Store helper: `src/store-remote.ts`

```ts
export interface CreateStoreRemoteOptions {
  /** default: qmd's getDefaultDbPath() (stock location, D6) */
  dbPath?: string;
  /** default: qmd's config path (getConfigPath()) IF the file exists, else DB-only mode —
      mirrors qmd's own startMcpServer behavior */
  configPath?: string;
  /** raw or normalized jobs; default: loadRemoteConfig() */
  jobs?: unknown;
  /** test hook, passed to createBackend */
  llamaCtor?: QmdLlamaCppCtor;
}
export async function createStoreRemote(options?: CreateStoreRemoteOptions): Promise<QmdStore>
```

Implementation (the seam, exactly as proven in axel-agent `QmdKb.create`):
1. `const store = await createStore({ dbPath, ...(configPath ? { configPath } : {}) })`
   — stock qmd eagerly builds its local `LlamaCpp` (lazy models; no download
   until first use). Unavoidable in the patch-free design (spec fine print).
2. `const backend = await createBackend(jobs ?? loadRemoteConfig().jobs, { llamaCtor })`
3. Replace the slot: dispose `store.internal.llm` if it differs (it loaded
   nothing, cheap), then `store.internal.llm = backend`. **Before any call.**
4. Seam completion (the two closure-capture wrinkles, spec fine print):
   - **re-wire `store.searchVector`** to use `backend.embedModelName` (the
     original closure captures the pre-swap LlamaCpp's name — stale for remote
     embed). `store.internal.searchVec(q, backend.embedModelName, …)` is
     exposed, so this is a one-line reassignment, not a patch.
   - **wrap `store.close`** to also `await backend.dispose()` (the original
     close disposes the *closure's* LlamaCpp, not the swapped-in backend —
     in mixed setups the backend owns a real LlamaCpp that must be released).
5. Return the store (same object, all qmd methods intact).

`QmdStore` type = `Awaited<ReturnType<typeof createStore>>`; the
`internal.llm` assignment goes through a small typed seam
(`{ llm?: unknown }` cast, as in axel-agent — qmd ships no type for it).

Tests (no provider traffic; `llamaCtor: FakeLlamaCpp` + jobs all local):
- returned store is a qmd store (has search/update/embed/getStatus)
- `store.internal.llm` IS the created backend; the original instance was disposed
- `searchVector` uses the backend's embedModelName (spy via a backend whose
  name differs from the fake's)
- `close()` disposes the backend
- default configPath logic: existing yaml passed through; absent yaml → DB-only
  (temp dirs both ways)

### P2.3 — THE e2e seam test: `tests/e2e-seam.test.ts` *(the patch-free proof, D2 — also the future D11 CI compat test; name it so it is easy to find/keep)*

Setup (all temp dirs, all loopback, zero network):
- `docs/` temp folder with 2–3 distinct markdown files (content that makes
  one clearly answer a query, e.g. a "banana smoothie recipe" file)
- `index.yml` temp file: one collection `{"collections": {"test": {"path": "<docs>"}}}`
  (verify exact YAML shape qmd expects during implementation — `startMcpServer`
  and the CLI both read this format; stock `qmd` users have these files)
- mock provider (reuse the P1 mock-server helper — extract it to
  `tests/helpers/mock-server.ts`): routes for `/v1/embeddings` (deterministic
  per-text vector, fixed dims, e.g. 16-d from a string hash so the right doc
  actually ranks first), `/v1/rerank` (echo docs with scores), `/v1/chat/completions`
  (return valid `type: text` expansion lines)

Test body:
```ts
const store = await createStoreRemote({
  dbPath: join(dir, "index.sqlite"),
  configPath: join(dir, "index.yml"),
  jobs: { embed, rerank, expand: all openai-compat → mock },
});
const u = await store.update();
assert.ok(u.indexed >= 3);
assert.equal(mock.hits["/v1/embeddings"]?.length, 0, "update() must not embed");
const e = await store.embed();
assert.ok((mock.hits["/v1/embeddings"]?.length ?? 0) > 0, "WRITE PATH: embed() routed remote");
const r = await store.search({ query: "banana smoothie" });
assert.ok(r.results[0] matches the banana doc, "SEARCH PATH: found via remote embed+rerank");
assert.ok(mock hits include a query-side /v1/embeddings + /v1/rerank + /v1/chat/completions);
await store.close();
```
- The three `assert` comments mark the proof: **write path + search path, no patch.**
- Keep the total under ~10 s (tiny docs, mock latency 0).

### P2.4 — Public entry + docs

- `src/index.ts`: export `createStoreRemote`, `CreateStoreRemoteOptions`,
  `loadRemoteConfig`, `defaultConfigPath`.
- Plan/spec: check the boxes; P2 marked done. (README user-facing docs wait
  for P6, as planned.)

## Checkpoint/commit sequence

1. P2.1 config-file + tests green → commit
2. P2.2 store helper + its tests green → commit
3. P2.3 e2e seam test green → commit (P2 done → run green gate)
4. P2.4 exports + doc ticks → commit

## Known risks / notes

- **Eager LlamaCpp in `createStore`:** constructing it must not download or
  load anything (verified assumption — axel-agent's QmdKb runs exactly this on
  every machine; if the constructor ever becomes eager, the e2e test catches it
  via slowness/mock-hits, and the escape hatch is pre-seeding `internal.llm`).
- **`index.yml` shape:** qmd accepts collections in YAML; the exact accepted
  grammar (name/path/pattern) is read from `dist/collections.js` during
  implementation, not guessed.
- **Vec-table dim check** (`ensureVecTableInternal`): the mock's fixed dims
  make this a non-issue in-test; with a real provider a model switch changes
  dims → qmd re-embeds via its own bookkeeping (P1 name design).
- e2e runs in CI without GPU/network: no local models are ever requested
  (all jobs remote; `llamaCtor` real but unused — all-remote ⇒ no LlamaCpp at
  all, per the factory).
- This e2e is deliberately the **same test D11's CI compat matrix will run**
  against a bumped qmd pin — keep it dependency-free and self-contained.
