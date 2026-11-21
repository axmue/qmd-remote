# qmd 2.9.0 Upgrade — living plan

**Status:** decisions agreed with user (interview 2026-11-21). P1 (version bump +
seam update) done 2026-11-21; P2 (MCP re-sync) done 2026-11-21; P3 (CLI
parity) done 2026-11-21; P4 (docs/ADR/README + consumer gate) done
2026-11-21 — all phases complete, 66/66 tests + consumer 6/6.

## Decisions (confirmed in interview)

| # | Decision |
|---|----------|
| D-A | **Embed stays on our own remote adapter** (Option A). We do NOT adopt qmd 2.9.0's native remote embed (`models.embed` API-base URI in index.yml). Rationale: axel-agent's Q1 (embed → native) was shaped by their dist-patch bridge, app-owned index dir, and `auth.json`→`apiKeyEnv` key store. This package is patch-free with a single config file; native embed would split config across `index.yml` + env-var key indirection, impose a hard 30 s per-request timeout (not configurable; `--max-docs-per-batch 4` workaround on slow gateways), and drop Ollama embed. Our adapter: one config file, per-job `timeoutMs` (default 60 s), `api:<provider>:<model>` names, openai-compat + Ollama. |
| D-B | **Rerank/expand stay on our adapters** (mirrors axel-agent Q2): qmd's only native remote rerank is the TypeSafe service (lock-in we don't want); no native remote expand in 2.9.0. |
| D-C | **Full metadata surface adoption**: SDK gets `filter`/`listMetadata` for free (pass-through); MCP copy re-synced to 2.9.0 (restructured `query` tool: `query` OR typed `searches` sub-queries (lex/vec/hyde), `filter`, `intent`, `rerank`, `candidateLimit`, `collections` + new `metadata` tool); CLI gains `query --filter <json>`, `collections metadata` subcommand, and a `status` metadata hint. |
| D-D | **Retire the ADR-0003 global-default seam hack** (`setDefaultLlamaCpp(backend)` in `createStoreRemote`): 2.9.0's embed path tokenizes with the store's llm (`chunkDocumentByTokensWithLlm(llm, …)`), so the 318 MB download hole is closed upstream. Keep the clean-machine test as regression proof. Mark ADR-0003 superseded (historical, do not delete). |
| D-E | Housekeeping: pin `@tobilu/qmd` exactly `2.9.0`; allowScripts `node-llama-cpp` 3.20.0 → 3.22.3; `COPIED_FROM_QMD_VERSION` bump; amend spec **D14 sunset trigger** (upstream now ships *partial* official remote support — wording must be honest, package pitch unchanged); **README: new "migrating existing data" section** (user request) + upgrade notes. |

## Verified seam facts (2.9.0 dist, read 2026-11-21; corroborated by axel-agent P1)

- `getLlm(store)` = `store.llm ?? getDefaultLlamaCpp()` unchanged (`dist/store.js:135`) — the patch-free slot swap still covers search AND reindex.
- **ADR-0003 hole closed upstream**: `generateEmbeddings` chunking goes through `chunkDocumentByTokensWithLlm(llm, …)` (store.js:2262/2658) with the store's llm — no more global-default tokenizer download on the embed path. (The exported `chunkDocumentByTokens` still uses the global, but store paths don't.)
- **searchVector closure wrinkle survives**: `store.searchVector` still binds the pre-swap `llm` from the closure; internal `searchVec` signature is now `(query, model, limit, collectionName, session, precomputedEmbedding, filter)` (store.js:2458). New re-wire should mirror 2.9.0's own body: `withLLMSessionForLlm(backend, s => internal.searchVec(q, backend.embedModelName, limit, collection, s, undefined, filter))` + `parseMetadataFilter` for the `filter` option.
- `store.close` teardown still disposes the closure's pre-swap instance → our close wrapper stays.
- LLM surface store.js calls: `session.embed(text, {model, isQuery})`, `session.embedBatch`, `session.rerank`, `llm.embedBatch`, `llm.rerank`, `llm.expandQuery`, `llm.tokenize`, `llm.detokenize`, `llm.embedModelName`, `llm.rerankModelName` — all covered by our duck-typed backend. Session layer (`lifecycleFor()`) tolerates non-registered duck-typed instances (axel-agent verified llm.js:656).
- Special-case in 2.9.0 chunking: `llm.embedModelName?.startsWith("remote-openai:")` → char-based chunking w/o tokenizer. Our `api:*` names go through `llm.tokenize` → our lossless UTF-16 tokenizer. Works unchanged.
- Native features (context, NOT adopted): `models.embed` URI → `RemoteEmbedder` inside `new LlamaCpp(config)` (built inside `createStore` before we can intervene — the reason native embed is awkward for this package); rerank native = `typesafe:<model>` only; no native expand.
- MCP 2.9.0: `query` tool input = `query`, `searches` (array ≤10 of {type: lex|vec|hyde, text, limit?…}), `limit`, `minScore`, `candidateLimit`, `collections`, `filter` (record → `validateFilterArgument`), `intent`, `rerank`; new `metadata` tool. `store.search` accepts `opts.queries` → `structuredSearch`; `store.listMetadata` is a new public method.
- `node-llama-cpp` 3.20.0 → 3.22.3 (package `allowScripts`).
- One-way index migration (collection-partitioned vector index; first command converts in place) — user-facing README note.

## Phases (each ends green + committed)

### P1 — version bump + seam update
- `package.json`: `@tobilu/qmd` → `2.9.0` exact; allowScripts node-llama-cpp 3.22.3; `npm install`.
- `src/store-remote.ts`: drop the `setDefaultLlamaCpp` global-seam step (D-D); re-wire `searchVector` to the 2.9.0 internal signature (session + filter); update header comments (2.8.3 → 2.9.0 facts).
- `src/backend/*`: surface delta check vs 2.9.0 (`isQuery` option etc.) — fix only what's broken.
- Tests: `store-remote.test.ts`, `e2e-seam.test.ts`, cli clean-machine test updated to assert the hack is gone; run full suite.
- Green checkpoint: `npm run check`.

### P2 — MCP re-sync (drift check green again)
- `src/mcp.ts`: re-sync the copy from 2.9.0 `dist/mcp/server.js` — restructured `query` tool schema (verify every key against upstream), `metadata` tool, instructions text, `COPIED_FROM_QMD_VERSION = "2.9.0"`.
- Handlers: `query` → `store.search({query|queries, filter, …})`; `metadata` → `store.listMetadata`. Keep the same handler routing over the remote-wired store.
- `src/mcp-http.ts`: no surface change expected (transport only) — verify.
- `scripts/check-mcp-drift.mjs`: should pass unchanged (verify its regexes handle the new schema shapes; extend if the coarse scan mis-fires).
- Tests: mcp.test.ts (tools/list, query with `searches`, filter, metadata call) + mcp-http.test.ts.
- Green checkpoint: `npm run check`.

### P3 — CLI parity
- `query --filter <json>` (pass through `store.search({filter})`), help text.
- `collections metadata` subcommand (report via `store.listMetadata`; table + `--json`).
- `status`: metadata hint line (key count / docs with metadata, "explore with collections metadata") mirroring qmd's own status.
- Tests: cli.test.ts additions.
- Green checkpoint: `npm run check`.

### P4 — docs + consumer gate
- Spec `docs/specs/qmd-remote.md`: D14 sunset trigger amended (partial upstream remote support exists as of 2.9.0; package still covers all three jobs generically — pitch intact); seam-decision references updated (D2 amendment note → ADR-0003 superseded); 2.9.0 decision table recorded (see ADR).
- ADR-0004 (or next number): "qmd 2.9.0 — keep the full remote backend; retire global-default hack; adopt metadata surface" + index.
- README: **"Migrating existing data" section** (D-E, user request): what survives (same index files, BM25 content, collections), what the one-way collection-partitioned conversion does, re-embed semantics (space identity per model → `qmd-remote embed -f` after model flips; `-f` caveat from 2.9.0: after an aborted remote batch, plain embed reports "all hashes embedded" while old-space rows remain), restart a running `qmd-remote mcp --http` server.
- `npm run test:consumer` (pack → fresh consumer) — publish gate stays met.
- Green checkpoint: `npm run check` + `npm run test:consumer` → commit.

## Recovery notes

- Files touched: `package.json`, `src/store-remote.ts`, `src/mcp.ts`, `src/mcp-http.ts`, `src/cli.ts`, `src/backend/*` (maybe), `scripts/check-mcp-drift.mjs`, tests, spec/ADR/README.
- Reference dist: installed `node_modules/@tobilu/qmd` after bump (or axel-agent's `node_modules/@tobilu/qmd` 2.9.0 for cross-checking — it carries the axel patch only in `axel-backend-bridge.js` + two `createAxelLlm`/`patchAxelLlm` call sites; store.js/mcp untouched).
- axel-agent upgrade writeup (context, different architecture): `../axel-agent/docs/tmp/qmd-2.9.0-upgrade.md`, ADR-0018.
