# P3 plan — the `qmd-remote` CLI (spec D7, D8)

**Status:** ✅ **DONE 2026-10-31** — green gate met: all 8 CLI spawn-tests pass against the built dist (status/collections/usage offline; update+embed+query via mock; --lex-only zero-hits; doctor green + 401 red; embed 401 fail-loud). Full suite 34/34. Next: P4 (MCP server).
**Parent spec:** `docs/tmp/qmd-remote-package-spec.md`.
**Predecessor:** P2 done — `createStoreRemote` + config file, 26/26 tests, seam proven.

## Goal / definition of done

A `qmd-remote` binary covering the v1 command surface, with fail-loud error
semantics and the 5-second `doctor`. A user on a GPU-less box runs:

```
qmd-remote doctor              # everything green in ~5 s, or exit 1 with reasons
qmd-remote update              # index the collections (stock index locations)
qmd-remote embed               # remote-embed what update left
qmd-remote query "banana smoothie" -n 5
qmd-remote status
qmd-remote collections list|add|remove
```

**Green gate (commit when met):** typecheck clean + full suite green, including
CLI e2e tests that spawn the **built** `dist/cli.js` against a temp index +
mock provider: `update` → `embed` → `query` finds the banana doc; `doctor`
green on mock, red (exit 1) on a 401 provider; errors carry job/provider/URL.

## Command surface (D8) + flags

Global flags (any command): `-d <path>` / `--db <path>` (index.sqlite),
`--config <path>` (index.yml), `--json` (machine-readable output where it makes
sense: status, collections, doctor).

| command | behavior |
|---|---|
| `update [-c <col> ...]` | `store.update({ collections? })` → print summary (indexed/updated/removed/needsEmbedding). No embeddings. |
| `embed [-c <col>] [--force]` | `store.embed({ collection?, force? })` → print EmbedResult (docs/chunks/errors/durationMs). Provider failure → hard fail (D7). |
| `query <text> [-c <col>] [-n <n>] [--no-rerank] [--lex-only]` | `store.search(...)` / `searchLex` → print top-n lines: `score  displayPath — title`. `--lex-only` bypasses all LLM legs (works offline). |
| `status` | `store.getStatus()` → totalDocuments / needsEmbedding / hasVectorIndex + per-collection counts. No network. |
| `doctor` | see below |
| `collections list` | `store.listCollections()` → name + path table |
| `collections add <name> <path> [--pattern <glob>]` | `store.addCollection` |
| `collections remove <name>` | `store.removeCollection` |

Every command: `loadRemoteConfig()` → `createStoreRemote({dbPath, configPath,
jobs})` → work → `store.close()` in `finally`. Unknown command/flag → usage to
stderr, exit 2. Provider/network/config errors → message to stderr, exit 1
(D7: message names job, provider, model, URL, reason — the adapters already
emit that shape; the CLI must not swallow or rewrap it).

### doctor (the 5-second health check)

1. Print config source (`loadRemoteConfig().source`) — absent file =
   "default (all local)".
2. For each REMOTE job, one tiny live call through a `createBackend` composite
   (NOT through a store — no index needed):
   - embed: `embed("qmd-remote doctor probe")` → `OK <dims> dims, <ms> ms`
   - rerank: `rerank("probe", [2 tiny docs])` → `OK <ms> ms`
   - expand: `expandQuery("doctor probe")` → `OK <n> variants, <ms> ms`
3. Each LOCAL job → `local (no remote call)`.
4. If an index exists at the resolved dbPath: one local sqlite line from
   `getStatus()` (`<docs> docs, <n> awaiting embedding`).
5. Dims drift check: if the index has a vector index and the embed probe dims
   differ from the stored vec dims (available via `getIndexHealth()` — verify
   exact field during implementation), print a specific warning:
   `embed: model returns N dims, index was built with M → run 'qmd-remote embed' to rebuild`.
6. Exit 1 if any probe threw (message per D7), else 0.

## Implementation

- **`src/cli.ts`** with `#!/usr/bin/env node` shebang (tsc preserves it).
  Hand-rolled argv parsing (small table-driven helper; NO new runtime deps —
  the adapters are plain fetch, the CLI stays that way). `main(argv)` is a
  pure-ish export for tests; the bin entry calls `main(process.argv.slice(2))`
  and maps thrown errors to exit codes.
- `package.json`: `"bin": { "qmd-remote": "dist/cli.js" }`; ensure the built
  file is executable (tsc keeps the shebang; npm sets +x on install).
- Exit codes: `0` ok · `1` runtime/provider/config error · `2` usage error.

## Tests (`tests/cli.test.ts`, spawn the BUILT dist)

- `"pretest": "npm run build"` in package.json — tests exercise `dist/cli.js`
  exactly as published users would (build is ~2 s).
- Shared fixture: temp docs (banana/apple/zebra, same as e2e-seam) + index.yml
  + mock provider (routes reused from `tests/helpers/mock-server.ts`; consider
  extracting the routes to `tests/fixtures/e2e.ts` shared with e2e-seam.test.ts).
- Cases (each spawns `node dist/cli.js …`, asserts stdout + exit code):
  1. `status` on empty temp index → 0 docs, exit 0 (offline; all-local jobs via
     env `QMD_REMOTE_CONFIG` pointing at a temp all-local config file)
  2. `update` + `embed` + `query "banana smoothie" -n 3` against mock provider
     → exit 0, banana in output; mock hits > 0 (CLI write+search path)
  3. `query --lex-only` → finds banana with ZERO mock hits
  4. `doctor` with mock provider → exit 0, table has 3 job lines + dims
  5. `doctor` with a 401 provider (mock `_status: 401`) → exit 1, stderr names
     the job + `HTTP 401`
  6. `embed` against 401 provider → exit 1, stderr carries provider error
     (D7 fail-loud, no local fallback)
  7. usage: unknown command → exit 2 + usage text
  8. `collections add/list/remove` round-trip on temp index
- Env hygiene per test: `QMD_REMOTE_CONFIG` → temp config file;
  `QMD_CONFIG_DIR` + `INDEX_PATH` → temp index locations (qmd's own override
  envs — `defaultQmdConfigPath`/`defaultQmdDbPath` already honor them).

## Checkpoint/commit sequence — ACTUAL (2026-10-31)

- Whole CLI implemented in one pass (all six commands), then all 8 tests at
  once; single commit `a194730`. Deviations from the drafted sequence:
  - `status`'s per-collection table uses `listCollections()` (`Collection`:
    `pwd`/`doc_count`) — `getStatus().collections` (CollectionInfo) came back
    EMPTY after a YAML sync (verified empirically); the global counts still
    come from `getStatus()`.
  - the expand probe originally went through `expandQuery()`, which swallows
    provider errors by design — a dead expand provider was reported GREEN with
    exit 0. Fixed on 2026-11-10 (review §2.1): the probe now uses `generate()`.
  - dims-drift line dropped: `IndexHealthInfo` has no dims field and the vec
    table's dims are not reachable via the public API; the doctor reports the
    probe dims instead, and a real mismatch surfaces via qmd's own
    embedding-fingerprint bookkeeping on the next `embed` (loud, not silent).
  - unknown command now prints usage AND the error (test 7 required both).
  - doctor probe shape: `ok` flag per line; JSON mode emits `{configSource, jobs[], index}`.

## Known risks / notes

- **Spawned CLI + native deps:** `dist/cli.js` imports qmd → node-llama-cpp
  native module loads in the child; P2's in-process tests prove it loads, the
  first spawned test proves it in a child (watch for PATH/PWD quirks like the
  stale-PWD foot-gun axel-agent hit — spawn with explicit `cwd` + `env`).
- **First-run index absent:** `createStore` on a non-existent sqlite path
  creates the DB; with no collections, `update` does 0 docs — print a hint
  ("no collections — use `qmd-remote collections add`") instead of failing.
- **Long embed runs:** no artificial cap (unlike axel-agent's 120 s hook —
  that cap served its reindex-hook; an interactive CLI should run and show
  progress). `store.embed({ onProgress })` → print a one-line progress update
  (throttled) so a 30-min re-embed doesn't look hung.
- doctor's expand probe costs one chat completion per run — acceptable (that's
  the point: pay 5 s now, not 30 min later).
- Keep CLI output plain-text and greppable (no colors in v1; `--json` covers
  machine consumption).

## Correction (2026-11-10, code review)

The claim above that `getStatus().collections` "came back EMPTY after a YAML
sync" could NOT be reproduced on review: on a fresh temp index `status --json`
returns a fully populated `collections[]` (now pinned by a regression test in
`tests/cli.test.ts`). Both idioms in the codebase are therefore valid; the
workarounds were unnecessary, not wrong. See `docs/tmp/review-2026-11-10.md` §1.
