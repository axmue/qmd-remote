# Idea: a standalone npm package that gives qmd a remote model backend

**Status:** idea / exploration — NOT decided to build, NOT for axel-agent.
A separate, independent project. Captured 2026-10-18 from a design discussion.
It is *informed by* (but does not depend on or modify) the qmd remote-backend work
already done in `axel-agent` (ADR-0010, `docs/tmp/qmd-remote-models.md`).

## TL;DR

A drop-in package for the qmd ecosystem: **"qmd's excellent indexer / hybrid
search / chunker, but with your own embed / rerank / query-expansion models."**
qmd stays stock (pinned dependency, no fork); the package adds a provider-agnostic
remote backend and a thin front door (own CLI / own MCP / SDK helper) so a qmd
user on a GPU-less box can point all three model jobs at an OpenAI-compatible,
Ollama, or custom endpoint instead of downloading gigabytes of GGUF.

## Motivation / the gap

- qmd (tobit/qmd) runs all its model jobs — **embed**, **rerank**, **expand**
  (query expansion) — through local node-llama-cpp GGUF models.
- Upstream **removed** the old Ollama/remote-HTTP support in favor of local GGUF
  (CHANGELOG: "Replaced Ollama HTTP API with node-llama-cpp for all LLM
  operations"). There is **no config knob** for a remote model today.
- Forks are far behind upstream. So GPU-less laptops / small vhosts that want a
  cloud or a local Ollama model for these jobs have no first-class path.
- That "the remote backend they removed" is a real, defensible niche.

## What is already proven (the reference basis, in axel-agent)

We built and ran this for our own app, which de-risks the *backend* part:

- **Backend adapters** (provider-agnostic, plain `fetch`): objects implementing
  qmd's duck-typed LLM surface — `embed`, `embedBatch`, `rerank`, `expandQuery`,
  `generate`, `tokenize`/`detokenize`, `getDeviceInfo`, `modelExists`, plus the
  **stable-string** `*ModelName` getters (they feed qmd's embedding-fingerprint
  / cache keys). Providers: `openai-compat` (OpenRouter, Jina, …) + `ollama`.
  - Verified live: OpenRouter `qwen/qwen3-embedding-4b` (embed) +
    `qwen/qwen3-reranker-8b` (rerank) work; Jina works. qmd only needs *consistent
    dims* per embed model, so a provider/model switch just triggers a re-embed.
  - Remote `tokenize`: no standard HTTP tokenizer ⇒ lossless UTF-16 code-unit
    round-trip (qmd's chunker self-corrects; the model-name change on
    local↔remote re-embeds anyway, so the index never mixes granularities).
- **In-process search via the `store.llm` seam**: setting `store.llm` (or
  `store.internal.llm`) to a custom object makes qmd resolve **every** search path
  (`getLlm(store) = store.llm ?? getDefaultLlamaCpp()`) through it. Proven for the
  *search* path (query-time embed + rerank + expand) in axel-agent's QmdKb.
- **The patch** (axel-agent P1): a `patch-package` diff over the pinned qmd dist
  injecting a backend factory at the three `new LlamaCpp(...)` sites
  (`dist/index.js` SDK, `dist/cli/qmd.js` CLI/MCP, `dist/llm.js` default-singleton
  fallback). Works on 2.8.3; it's the *fragile* part.

## The core decision for a standalone package: how to inject

qmd has no remote knob, so "make qmd use external models" must be one of:

1. **Patch the pinned qmd dist** (what axel-agent does for its CLI reindex path).
   - Pros: stock `qmd` CLI + `qmd mcp` just work with a config. Zero UX change.
   - Cons: a **textual diff over `dist`** — the most brittle form; every qmd
     release risks moving/renaming the anchor sites ⇒ a manual rebase each release.

2. **Fork qmd** — rejected: means re-implementing *all* of qmd (indexer, hybrid
   search, sqlite, MCP server, CLI) to track every upstream commit. The expensive path.

3. **Patch-free: drive the qmd SDK in-process via the `store.llm` seam** ✅ (lean here)
   - The package = **qmd (stock, pinned) + a backend module + a thin front door of
     its own** (a `qmd-remote` CLI that runs `update`/`embed`/`query` via the SDK;
     an MCP server of its own; an SDK helper `createRemoteBackend(cfg)`).
   - qmd is **unmodified**; the only qmd-internal coupling is "set `store.llm` to a
     duck-typed LLM object" + the method shapes qmd calls. That's a runtime object
     property — far more stable than a textual `dist` diff.
   - Trade: consumers run *your* bin / *your* MCP instead of bare `qmd` (a small UX
     change), and reindex is in-process (a wedged embed can hang the process —
     trivial to bound with a timeout/subprocess in a tool you own).

**Recommendation: start patch-free (3).** It makes the maintenance cadence nearly
free and keeps qmd stock. (2) is out. (1) can be a later opt-in "make stock `qmd`
honor a config" layer, but ship (3) first.

### The one thing to prove before committing to patch-free

axel-agent punted **reindex to a spawned CLI**, so we never exercised **in-process
`store.update()` / `store.embed()`** through the `store.llm` seam. The patch-free
story ("no GGUF, all remote") requires reindex to be remote too, which hinges on the
seam covering the **write** path, not just search.

**Make-or-break spike:** build a qmd store → set `store.llm` = a mock backend →
call `store.update()` + `store.embed()` → assert the mock endpoint was hit (and that
`store.search()` also routed through it). If it holds, patch-free is viable. If some
write path still reaches `getDefaultLlamaCpp()`, the CLI/patch (option 1) is needed
for the reindex leg.

## Packaging shape (for a standalone package)

- **qmd is a pinned, exactly-`2.8.3`-style dependency** of the package (stock,
  unmodified in the patch-free design).
- **Single front door:** the package should **re-export qmd's public SDK** so a
  consumer uses *one* module (the package) and there is never a second qmd copy
  resolving differently. (The "two physical copies of qmd" divergence is the trap
  to avoid — decide dependencies-and-re-export vs. peer-deps deliberately.)
- **Config:** a small, own config surface — env vars and/or a file — for
  per-job provider (`local` / `openai-compat` / `ollama` / `custom`), `baseUrl`,
  `model`, `apiKey`. Default `local` everywhere; a misconfigured remote should fail
  **loud**, never silently fall back to local models.
- **Cadence:** qmd is actively developed but tags infrequently. So: bump the pin +
  run a **CI compat matrix against the last few qmd tags** each time a tag lands;
  green ⇒ new package minor; red ⇒ adapt the backend/seam. Turns "manually test the
  new tag monthly" into "an occasional red-CI ping." In the patch-free design the
  compat check is tiny (does `store.llm` + the duck-typed surface still line up?).

## Risks (honest)

- **You depend on qmd's internal, removed, unversioned LLM surface.** The pin +
  no-fork + `store.llm` seam is the *softest* version of that bet (a runtime
  property, not a text patch); a compat CI is what keeps it from rotting. It is
  still a bet on upstream stability, not a guarantee.
- **Upstream is moving the opposite way** (local-only). The package's whole pitch is
  "re-adding what they removed," so it is a standing, if small, maintenance
  commitment, not a one-shot.
- **License/attribution:** a patch/fork of tobit/qmd must respect its license and be
  clearly a derivative. The backend adapters are original code (ours to license).
  (The patch-free design's coupling is thinner, but the re-exported qmd is still
  upstream's — state the relationship clearly in the README.)

## Positioning / value prop

> Run qmd on any machine — no GPU, no GGUF downloads. Point embed / rerank /
> query-expansion at OpenRouter, Jina, a local Ollama, or any OpenAI-compatible
> endpoint, per job. Keep qmd's indexing + hybrid search + chunking; swap only the
> models.

Audience: qmd users on GPU-less / constrained installs who want a cloud or a local
Ollama model for the three LLM jobs.

## Open questions

1. Does in-process `store.update()`/`store.embed()` route through `store.llm`?
   (The make-or-break spike above.) → decides patch-free vs. patch-for-reindex.
2. Front-door dependency model: package `dependencies` qmd + re-exports its SDK,
   vs. `peerDependencies` qmd and ships a patch? (Patch-free ⇒ the re-export model;
   keep it one physical qmd copy.)
3. Which front doors to ship at v1: just the SDK helper, or SDK + CLI + MCP?
4. Package name: something crisp like `qmd-remote-backend` / `qmd-external-llm`
   ("qmd-externalisator" is fun but opaque).
5. License for the adapters + how the qmd dependency/relationship is stated.

## Next step (if pursued)

The 20-minute make-or-break spike in "the one thing to prove" — it resolves the
single load-bearing technical unknown and tells us whether the maintenance floor is
"confirm one seam still exists" (patch-free) or "rebase a dist patch" (CLI path).
