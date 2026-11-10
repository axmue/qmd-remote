# P5 plan — local consumer test (the publish gate, spec D13)

**Status:** drafted 2026-10-31. Ready to start.
**Parent spec:** `docs/tmp/qmd-remote-package-spec.md` (D5, D13).
**Predecessor:** P1–P4 done — 35/35 tests; SDK + CLI + MCP all proven in-repo.

## Goal / definition of done

Prove the package works **the way a consumer gets it**: install the packed
tarball into a clean project and drive CLI + SDK + MCP from there — before any
GitHub/npm step. This is the gate for P6 (publish).

**Green gate (commit when met):** the consumer script exits 0 with all
checklist items printed OK, in a **fresh temp dir with a clean node_modules**
(no shared hoisting with the dev repo).

## Why a fresh temp consumer (not the repo itself)

The whole "one physical qmd copy" promise (D5) and the bin/exports wiring are
only observable from OUTSIDE the package. In-repo tests run from `src/` via
tsx and never see the published surface.

## The test: `scripts/consumer-test.mjs` (committed — D11's CI reuses it)

Self-contained Node script (no tsx; runs against the packed artifacts). Steps:

1. **Pack**: `npm pack` in the package root → `qmd-remote-0.1.0.tgz`.
2. **Fresh consumer**: temp dir; `npm init -y`;
   `npm i <tarball> @modelcontextprotocol/client@2.0.0` (the client is what an
   agent-side test harness would install; version pinned same as the server).
3. **Single-copy check**: `node -e "console.log(require.resolve('@tobilu/qmd/package.json'))"`
   in the consumer → exactly one path, under the consumer's `node_modules`
   (assert it's NOT under the dev repo).
4. **Bin check**: `node_modules/.bin/qmd-remote --help` → exit 0, usage text.
5. **SDK check** (consumer script): import `qmd-remote` →
   `createStoreRemote({ dbPath, configPath, jobs })` against a temp index +
   loopback mock provider (inline http server, same routes as the in-repo
   tests) → `update()` + `embed()` + `search()` finds the banana doc →
   `close()`. Asserts the consumer's one qmd copy is what runs
   (`store.constructor`-independent: just behavior).
6. **CLI check** (spawned from the consumer): fixture index.yml + docs +
   `QMD_REMOTE_CONFIG` mock jobs → `update`, `embed`, `query "banana smoothie"`,
   `status`, `doctor` (expect exit 0 + dims line). Assert `doctor` red case:
   401 mock → exit 1.
7. **MCP check** (consumer script): StdioClientTransport →
   `node_modules/.bin/qmd-remote mcp` → initialize (name `qmd-remote`) →
   `tools/list` = 4 tools → `query` finds banana → close → server exits.
8. **Print a checklist** (OK/FAIL per item); exit non-zero on any FAIL; clean
   up the temp dir.

Env for all spawned steps: `INDEX_PATH`, `QMD_CONFIG_DIR`, `QMD_REMOTE_CONFIG`
pointed at the temp fixture (qmd's + our override envs — the same seams the
in-repo tests use).

## Out of scope

- Real providers / real API keys (D13 gate is about packaging, not network).
- `npm publish`, GitHub, CI wiring — that's P6.
- HTTP MCP mode — not in v1.

## Checkpoint/commit sequence

1. `scripts/consumer-test.mjs` (steps 1–4 + 8 skeleton) → runs green for pack/bin/single-copy → commit
2. SDK + CLI steps (5–6) → commit
3. MCP step (7) → commit (P5 done → green gate = the whole script green)

## Known risks / notes

- **npm install of a local tarball** triggers our `dependencies` install —
  qmd's native deps (node-llama-cpp postinstall etc.) install in the CONSUMER
  under the user's allow-scripts policy. On this machine that's proven (P1),
  but the consumer npm may not share the package's `allowScripts` block (it
  lives in OUR package.json, not enforced transitively) — if the native deps
  fail to initialize, the all-remote path still works (no model loading);
  the script should treat "local provider unavailable" as a WARN, not FAIL
  (documented), while any CLI/MCP/SDK step failing is a FAIL.
- **Version bump discipline**: the script reads the version from package.json
  (no hardcoded 0.1.0 in paths beyond the pack artifact name check).
- The consumer script is the **first draft of D11's CI compat job** — when the
  pin bumps, CI runs the same script against the new qmd and we're done.
