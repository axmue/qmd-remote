# ADR-0004 — qmd 2.9.0: keep the full remote backend, retire the global-default seam, adopt the metadata surface

**Date:** 2026-11-21 · **Status:** accepted · Supersedes ADR-0003's workaround
(the historical hole it describes remains accurate for 2.8.3).
**Plan:** [`docs/tmp/qmd-2.9.0-upgrade.md`](../tmp/qmd-2.9.0-upgrade.md) —
decisions table D-A…D-E agreed with the user in an interview.

## Context

Upstream `@tobilu/qmd` moved 2.8.3 → 2.9.0 and shipped *partial* official
remote-model support: native remote **embed** (an `http[s]://…#model-id`
API-base URI under `models.embed` in qmd's own `index.yml`, credential via an
env-var name in `embedOptions.apiKeyEnv`), native **rerank** via the TypeSafe
service only, and **no** remote expand. The same release closed our ADR-0003
hole (the embed chunking tokenizer now resolves through the store's llm, not
the global default), added the metadata engine (typed `qmd.metadata`
frontmatter, a recursive filter AST applied before fusion/rerank,
`store.search({filter})`, `store.listMetadata()`, CLI `collection metadata`,
an MCP `metadata` tool and a `filter` input on `query`), restructured the MCP
`query` tool around typed sub-queries, made the vector index
collection-partitioned (one-way in-place conversion on first use), and bumped
node-llama-cpp to 3.22.3.

Reference: axel-agent's own 2.9.0 upgrade (`docs/tmp/qmd-2.9.0-upgrade.md` +
ADR-0018 there) went the *opposite* direction on embed — native embed, app
bridge reduced to rerank/expand. That choice is specific to their
architecture: a dist-patch bridge already injected into qmd, an app-owned
index dir, and an `auth.json` key store feeding `apiKeyEnv`.

Verified seam facts (stock 2.9.0 dist, read 2026-11-21):

- `getLlm(store)` = `store.llm ?? getDefaultLlamaCpp()` unchanged
  (`dist/store.js:135`) — the patch-free slot swap still covers search AND
  reindex. The LLM surface store.js calls (`session.embed` incl. the `isQuery`
  flag, `session.embedBatch`, `session.rerank`, `llm.embedBatch`,
  `llm.expandQuery`, `llm.tokenize`/`detokenize`, `llm.embedModelName`,
  `llm.rerankModelName`) is fully covered by our duck-typed composite; the
  session layer tolerates non-registered instances.
- **ADR-0003 hole closed upstream**: `generateEmbeddings` chunks via
  `chunkDocumentByTokensWithLlm(llm, …)` with the store's llm
  (`dist/store.js:2262/2658`).
- `store.searchVector` still captures the pre-swap LlamaCpp from the
  `createStore` closure; its internal `searchVec` signature gained
  `session` / `precomputedEmbedding` / `filter`.
- `store.close` teardown still disposes the closure's pre-swap instance.
- Our `api:<provider>:<model>` names do NOT match 2.9.0's
  `remote-openai:` special-case (char-based chunking); they route through
  `llm.tokenize` → our lossless UTF-16 code-unit tokenizer. Works unchanged.

## Decision

1. **Embed stays on our own adapter** (D-A). We do not adopt native remote
   embed. For a patch-free package, native embed would split the config
   across two files (qmd's `index.yml` + an env-var key name), impose a hard
   30 s per-request timeout (not configurable; `qmd embed
   --max-docs-per-batch 4` workaround on slow gateways), and drop Ollama
   embed. One config file, per-job `timeoutMs` (default 60 s), openai-compat
   + Ollama is this package's pitch and still works unchanged through the
   seam.
2. **Rerank/expand stay on our adapters** (D-B) — native rerank would mean a
   TypeSafe lock-in; there is no native remote expand.
3. **ADR-0003's `setDefaultLlamaCpp` workaround is retired** (D-D): the
   global-default seam step in `createStoreRemote` is deleted; the CLI
   clean-machine test remains the regression proof for the no-download
   promise.
4. **Full metadata-surface adoption** (D-C): SDK pass-through is free; the
   MCP copy was re-synced (new `metadata` tool, `filter` input on `query`
   with upstream's validation flow, 2.9.0 `status`/instructions wording);
   the CLI gained `query --filter <json>`, `collections metadata [name]`
   (table + `--json`), and a `status` metadata hint line. **Verbatim scope:**
   tool names, descriptions and input schemas are verbatim copies of
   upstream; the `metadata` tool's *text rendering* is our own compact
   formatter — upstream's `formatMetadataKeySummaries` lives in
   unexported `dist/metadata-format.js` (the `structuredContent` field still
   carries the verbatim `ListMetadataResult`); the CLI count wording is
   ours where noted below. **Count semantics:** the public SDK exposes no
   "documents with metadata" count (upstream's status line uses the
   unexported `countDocumentsWithMetadata`), so our status hint and
   `collections metadata` header say **"indexed files/documents"**
   (`ListMetadataResult.documents` = documents in scope) rather than
   claiming files *with* metadata; pending-extraction count likewise
   omitted (not public).
5. **Pin moves to `2.9.0` exactly** (D-E), node-llama-cpp 3.22.3 in
   allowScripts. The MCP copy marker and the `check:mcp-drift` script move
   with it; the drift check's coarse schema scan now strips string literals
   first — the new `filter` description contains nested `{…}` braces that
   made the lazy regex truncate both sides identically (a false pass).
6. **Seam re-work** (mechanical): the `searchVector` re-wire mirrors 2.9.0's
   own body (session-scoped through the backend, metadata-filter aware);
   the `close()` wrapper is unchanged.

## Consequences

- The package keeps its exact pitch (one config file, three remote jobs,
  patch-free) — 2.9.0's partial native remote support does not overlap what
  we deliver, and D14 is amended accordingly.
- Users upgrading from the 2.8.3 pin get the one-way index conversion (see
  README "Migrating existing data") and the metadata engine for free; a
  provider/model switch re-embeds via the same `api:*` fingerprint
  semantics as before.
- Weekly compat CI (D11) continues to gate any future pin move.

## Verification

- Full offline suite green (66 tests) on the 2.9.0 pin, incl. the e2e seam
  proof (update + embed + search routed through a mock provider on a real,
  unpatched store) and the CLI clean-machine proof (fresh `HOME`, no model
  cache, all-remote — no download, without the global-seam hack).
- `check:mcp-drift` green: `src/mcp.ts` in sync with 2.9.0
  (tools: get, metadata, multi_get, query, status).
- New behavior covered by tests that fail on the 2.8.3 tree: `searchVector`
  filter pass-through + malformed-filter rejection before any search (P1);
  MCP `metadata` tool, `query` filter + typed `searches` branch +
  malformed filter (P2); CLI `--filter` / `collections metadata` (incl.
  unknown-collection usage error) / status hint (P3).
