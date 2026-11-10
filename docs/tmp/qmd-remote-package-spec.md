# qmd-remote — standalone npm package: remote model backend for qmd

**Status:** design agreed (interview complete 2026-10-31). Ready to plan implementation.
**Supersedes:** `docs/tmp/idea-qmd-remote-backend.md` (the idea; this file is the decided spec).
**Reference implementation:** `../axel-agent` (ADR-0010, `src/qmd-backend/`, `patches/@tobilu+qmd+2.8.3.patch`, `src/qmd-kb.ts`, `src/qmd-cli.ts`).

## What it is

A public npm package. Pitch: *qmd's indexer + hybrid search + chunker, but you choose
the embed / rerank / query-expansion models.* Stock qmd (pinned, unmodified dependency)
+ provider-agnostic remote backend + thin front door (SDK + own CLI). Users on
GPU-less machines point any of the three jobs at OpenRouter / Jina / Ollama / any
OpenAI-compatible endpoint, or keep them local. No GGUF downloads needed for remote jobs.

## Decisions (all confirmed with user)

| # | Decision |
|---|----------|
| D1 | **Public npm package**, standalone **public GitHub repo**, **MIT**. README: "unofficial, not affiliated with tobit/qmd; depends on stock, unmodified `@tobilu/qmd`; adapters are original code." |
| D2 | **Injection = patch-free** (idea-doc option 3). Set `store.internal.llm` after `createStore`, before any call. **Proven by code reading** of stock dist 2.8.3: `store.update()` → `reindexCollection(internal,…)`, `store.embed()` → `generateEmbeddings(internal,…)` (dist/store.js:1505 `getLlm(store)` = `store.llm ?? getDefaultLlamaCpp()`), and stock `createStore` assigns that same slot (the line is untouched by axel-agent's patch). No spike needed beyond a one-off e2e smoke. |
| D3 | **v1 front door = SDK + own CLI + own MCP server** — all three done and locally tested BEFORE publishing. MCP = own thin server on the MCP SDK; tool definitions (names/descriptions/schemas) copied once from qmd's internal `createMcpServer(store, inflight)` (dist/mcp/server.js:122, not exported; its exported `startMcpServer`/`startMcpHttpServer` build their own store with no injection point, so they can't be reused). Copy, not patch: lives in our code, stable across qmd upgrades. Handlers call the remote-wired store (same `store.internal.llm` seam). The opt-in dist-patch layer (make *stock* `qmd`/`qmd mcp` honor config — axel-agent's `AXEL_QMD_BACKEND` bridge generalized) is **deliberately deferred**, only if real users ask. |
| D4 | **Package name:** `qmd-remote` recommended (free on npm); user's fallback `qmd-remote-wrapper` also free. Decide at publish time. Bin = package name (never `qmd`). |
| D5 | **Dependency model:** `qmd` in `dependencies`, **pinned exactly `2.8.3`** (which is also the current latest tag). Package re-exports qmd's public API/types → one physical qmd copy. |
| D6 | **Index location = stock qmd's**: `~/.config/qmd/index.yml` + `~/.cache/qmd/index.sqlite` by default, overridable via CLI flags. Same files, same format (we only swap models) → instant migration for existing qmd users. |
| D7 | **Error semantics (ported from ADR-0010 D6):** a job configured remote NEVER silently falls back to local. Failure = non-zero exit + stderr naming job/provider/model/URL/reason. Per-request timeout per job (`timeoutMs`, default 60 000 ms) — a hung provider can't hang a reindex. |
| D8 | **CLI v1 surface:** `update [-c <col>]`, `embed [-c <col>]`, `query`, `status`, `doctor`, `collections list|add|remove`. `status` = offline sqlite counts only. `doctor` = config check + three live probes (one short embed → report dims; one rerank; one expand) → table + exit 1 on any failure. |
| D9 | **Config file** (single source of truth; no per-field env overrides in v1): path = `$QMD_REMOTE_CONFIG` else `~/.config/qmd-remote/config.json`. Shape = the proven axel-agent `jobs` block (per-job `provider: local|openai-compat|ollama`, `baseUrl`, `model`, `apiKey`, `timeoutMs`, `headers`; embed-only `embedQueryPrefix`/`embedDocPrefix`; rerank-only `rerankMaxChars`; expand-only `expandMaxTokens`). Malformed/missing-required field → startup error. |
| D10 | **SDK surface (two doors):** `createStoreRemote({ dbPath?, configPath?, jobs? })` → ready qmd store (backend set on `store.internal.llm` before use) + `createBackend(jobs)` → the duck-typed LLM object for advanced users. `createBackend` accepts a RAW `jobs` block (normalizes internally — typos fail with a config-path error). Re-export qmd's public types. |
| D11 | **Cadence:** weekly CI job checks npm for a new `@tobilu/qmd` tag; if new → runs compat suite in scratch workspace (seam exists? duck-typed surface contract test? e2e mock-provider smoke: update+embed+search assert remote hits?). Green ⇒ CI opens bump-pin PR (never auto-merges; human merges → minor release). Red ⇒ CI opens issue. |
| D13 | **Publishing (GitHub repo + npm) happens LAST**, after all features are locally tested. Local test path: `npm pack` → install the tarball into a scratch project (`npm i ./qmd-remote-x.y.z.tgz`) → consumer test incl. MCP via a real agent config. Only residual risk of deferring: npm-name squatting (small; name is obscure). Optional cheap mitigation: create the npm account during P1 (5 min) + publish 0.0.1 same day to lock the name. |
| D14 | **Sunset trigger:** if upstream qmd ever ships an official remote-provider config, deprecate the package; README points to upstream. Not expected soon (upstream is local-only). |

## What we port from axel-agent (≈1 540 lines, already tested)

`src/qmd-backend/`: `types.ts` (config + duck-typed LLM surface mirror), `adapters/`
(openai-compat: `/embeddings`, Jina-style `/rerank`, `/chat/completions`; ollama:
`/api/embed`, `/api/rerank`, `/api/chat`; shared HTTP + expansion parse), `factory.ts`
(composite per-job backend; local jobs keep ONE shared real LlamaCpp; stable
`api:<provider>:<model>` name getters feeding qmd's cache keys; all-remote ⇒ lossless
UTF-16 code-unit tokenize), `config.ts` (normalization). All original code; axel-agent
is unlicensed-private, porting is a clean rewrite-with-same-behavior, license is MIT.
Port the 19 offline adapter tests + config tests. **Drop** axel-agent-specific bits:
auth.json key resolution, bridge env mechanics, `AXEL_*` naming, the dist patch.

## Known fine print (accepted / noted)

- Stock `createStore` eagerly constructs the local `LlamaCpp` object (node-llama-cpp
  native dep imports at module load; GGUF download stays lazy). The native dep is
  unavoidable in `node_modules`; what we avoid is the model downloads and CPU usage.
- `store.searchVector` / `store.close()` capture the `createStore`-closure `llm`, not
  the overwritten slot ⇒ overwrite must happen before any call (we do, inside
  `createStoreRemote`); `searchVector`'s model *name* would be stale after a swap —
  document or avoid in v1.
- axel-agent's env-var/spawn machinery (`AXEL_QMD_BACKEND`, `INDEX_PATH`, `QMD_CONFIG_DIR`,
  `AXEL_QMD_JOBS`) exists only because *its* reindex must be a spawned process.
  `qmd-remote` does reindex **in-process** → none of that is needed.
- qmd CLI has official index-location env overrides (`INDEX_PATH`, `QMD_CONFIG_DIR`) —
  we may reuse them for flag implementation or pass paths directly via the SDK.

## Open (administrative, not design)

1. **Publishing is deliberately last (D13).** User has no npm account and no GitHub repo for this yet. Tasks, in order, after P5 consumer test: create GitHub repo (public), create npm account, `npm login`, publish, wire CI. Optional earlier: npm account during P1 to lock the name.
2. Final name: `qmd-remote` vs `qmd-remote-wrapper` (D4).

## Suggested implementation phases (each ends green + committed; publishing LAST)

- **P1 port:** ✅ DONE 2026-10-31 (package scaffold (TS, tsc→dist, ESM, **Node ≥22** — qmd's own engines
  requirement; corrects the earlier "≥20"), MIT); ported
  `qmd-backend` + tests; `createBackend` door. Green: offline suite (17) + smoke.
  `qmd-backend` + tests; `createBackend` door. Green: offline suite.
- **P2 seam:** ✅ DONE 2026-10-31 — `createStoreRemote` + `~/.config/qmd-remote/config.json` loading;
  e2e smoke: temp store + mock provider → `update`+`embed`+`search` assert remote
  hits (this doubles as the D11 compat test). Green: e2e passes (26/26 total).
- **P3 CLI:** ✅ DONE 2026-10-31 — the six v1 subcommands + `doctor` probes +
  fail-loud errors. Green: CLI e2e via child_process against mock provider (8 tests; 34/34 total).
- **P4 MCP server:** ✅ DONE 2026-10-31 — own thin MCP server (stdio; HTTP later if asked);
  tool definitions copied once from dist/mcp/server.js; handlers → remote-wired store.
  Green: MCP e2e (client handshake, tools/list, tools/call query) against mock provider
  + EOF shutdown. 35/35 total.
- **P5 consumer test (still local):** ✅ DONE 2026-10-31 — `npm pack` → scratch project installs the
  tarball → CLI + SDK + MCP exercised as an external consumer would. **6/6 = publish gate met.**
- **P6 publish (admin, D13):** GitHub repo (public), npm account, `npm publish`,
  CI compat job (D11) live.
