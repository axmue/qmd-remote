# ADR-0003 — Close the second seam: qmd's global default LlamaCpp

**Date:** 2026-11-19 · **Status:** superseded by [ADR-0004](0004-qmd-2-9-0-upgrade.md)
(qmd 2.9.0 closed the hole upstream; the workaround was retired 2026-11-21).
The historical record below stays accurate for the 2.8.3 pin.

## Context

`createStoreRemote` swapped the store's LLM slot (`store.internal.llm`), which
D2 proved covers `update()` / `embed()` / `search()` because stock dist 2.8.3
resolves those via `getLlm(store)` = `store.llm ?? getDefaultLlamaCpp()`.

The GitHub CI "test step runs forever" incident (fresh runner, empty model
cache) exposed the hole: stock 2.8.3's `chunkDocumentByTokens`
(`dist/store.js:2448`, called per-document by `generateEmbeddings`, i.e.
`store.embed()`) resolves its **tokenizer** via the global
`getDefaultLlamaCpp()` — not `store.llm`. `tokenize()` →
`ensureEmbedContext()` → resolves the default embedding model
(`hf:ggml-org/embeddinggemma-300M-GGUF/…`, 318 MB) → **download + load** on any
machine without `~/.cache/qmd/models`. Consequences:

- CI: 4 test files each trigger an `embed`; concurrent 318 MB HuggingFace
  downloads on 2 free-runner cores, progress hidden in child stderr →
  "runs forever" until the 6 h job timeout.
- Product: any all-remote `qmd-remote embed` on a clean machine silently
  fetched 318 MB of GGUF — contradicting the "no GGUF downloads" promise.

Local development masked it: a dev machine's model cache is warm from prior
qmd usage.

## Decision

`createStoreRemote` now also sets qmd's **global** default to the composite
backend, using `setDefaultLlamaCpp` from the same `dist/llm.js` the factory
already loads for `LlamaCpp` (not re-exported from the package entry — loaded
by file URL, same as `importLlamaCppCtor`).

- All-remote mode: the global tokenizer path hits the composite's lossless
  UTF-16 code-unit tokenizer — no download, no native lib, no GPU.
- Mixed mode: it hits the shared local `LlamaCpp` the composite already owns
  (same instance `store.llm` routes to).

The global assignment is process-wide and sticks after `store.close()`
(disposed backend). In practice every consumer (CLI, MCP stdio/HTTP, SDK)
re-calls `createStoreRemote` before use, which re-points the global; no test
or product path reads the global default from a disposed backend. If that
ever changes, prefer resetting the global in the `close()` wrapper.

## Verification (done-when rule: test fails without the change)

`tests/cli.test.ts` "clean-machine proof": `update` + `embed` in a child CLI
with a **fresh `HOME`** (empty model cache) and `QMD_EMBED_MODEL` pointed at a
nonexistent file. Without the global-seam fix the tokenizer step fails fast
with "No model file found at …definitely-missing.gguf" (or, env var unset,
would download the 318 MB default — the CI hang). With the fix: embed succeeds
against the loopback mock and the bogus URI is never touched. Deterministic,
offline, no network dependency.

## CI hardening

`timeout-minutes: 15` on the workflow job: a future seam leak (or any
accidental download) now fails in minutes instead of eating the 6 h default.
