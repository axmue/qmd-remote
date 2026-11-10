# P4 plan — own MCP server (spec D3, v1 scope)

**Status:** ✅ **DONE 2026-10-31** — green gate met: MCP e2e (real client over stdio: initialize → tools/list = 4 tools → query/get/status → provider hits → server exits on client close) passes; full suite 35/35. Next: P5 (local consumer test, the publish gate).
**Parent spec:** `docs/tmp/qmd-remote-package-spec.md`.
**Source to copy from:** `node_modules/@tobilu/qmd/dist/mcp/server.js`
(`createMcpServer(store, inflight)` at :122 — **not exported** by qmd; its
exported entries build their own store with no injection point, so we build
our own thin server and COPY the tool definitions).

## What qmd's server looks like (verified in dist 2.8.3)

- **4 tools:** `query` (rich: typed sub-queries lex/vec/hyde, auto-expand,
  rerank; long description), `get` (file + line range), `multi_get`
  (glob/batch with byte caps), `status`
- **1 resource:** `qmd://{+path}` document read (line numbers, context header)
- **server `instructions`:** built by `buildInstructions(store)` (collection
  list + query-syntax guidance)
- **deps:** `@modelcontextprotocol/server` (McpServer, serveStdio,
  createMcpHandler) + `zod` (input schemas)
- pattern: per-request `McpServer` factory + inflight gate + stdio-EOF
  shutdown that waits for in-flight work before disposing store/llm

## Goal / definition of done

`qmd-remote mcp` serves the same tool surface over **stdio** against the
remote-wired store, so an agent config gains one entry and the user's
GPU-less box searches through remote models. No patch, no extra qmd process.

**Green gate (commit when met):** typecheck + full suite green, including a
MCP e2e that drives the **built** server with a real MCP client (SDK) over
stdio: initialize → `tools/list` shows 4 tools → `tools/call query` finds the
banana doc with mock-provider hits.

## Components

### P4.1 — deps + `src/mcp.ts`

- New **runtime** deps (they are now OUR direct imports):
  `@modelcontextprotocol/server` + `zod` at the **same versions qmd 2.8.3
  uses** (read qmd's package.json; pin exactly — one physical copy, no
  duplicate SDKs in a consumer tree).
- `createQmdRemoteMcpServer(store: QmdStore): McpServer` — copies qmd's
  `createMcpServer` registrations:
  - `query`, `get`, `multi_get`, `status` — **descriptions + zod schemas
    copied VERBATIM** from dist/mcp/server.js (a copy in OUR code — stable
    across qmd upgrades; if upstream wording changes we re-sync deliberately,
    never silently). Header comment names the source file + qmd version.
  - `qmd://{+path}` resource — same template + behavior.
  - `instructions` — qmd's `buildInstructions` copied, adapted to say the
    models are remote (provider names from the jobs config).
  - handlers call the same store methods the CLI uses (`store.search`,
    `store.get`, `store.multiGet`, `store.getStatus`) with the same
    result shaping qmd uses (line fields, snippets, byte caps —
    `DEFAULT_MULTI_GET_MAX_BYTES` etc. re-exported from qmd).
  - server name: `qmd-remote`, version = our package version.
  - inflight tracking: reuse qmd's exported `createInflightGate`
    (`dist/mcp/server.js` — IS exported) for clean stdio-EOF shutdown.

### P4.2 — CLI wiring: `qmd-remote mcp`

- New subcommand `mcp`: `loadRemoteConfig` → `createStoreRemote` →
  `serveStdio(() => createQmdRemoteMcpServer(store))` + stdio-EOF shutdown
  (close gate → `store.close()`) — mirrors qmd's `startMcpServer` lifecycle.
- Usage text updated; `mcp` takes the same global flags (`-d`, `--config`).
- Note for users (README, P6): stdio transport; one server process per agent;
  the server hosts sqlite + the backend (no local models when all jobs
  remote).

### P4.3 — MCP e2e test: `tests/mcp.test.ts`

Drive the built server the way a real agent would:
- spawn `node dist/cli.js mcp` (fixture env from cli.test.ts pattern: temp
  index.yml/docs, `QMD_REMOTE_CONFIG` → mock provider jobs, `INDEX_PATH`,
  `QMD_CONFIG_DIR`); pre-populate the index via the CLI (`update` + `embed`)
  so the MCP test focuses on the protocol.
- client: `@modelcontextprotocol/client` (new **dev** dep, same version as
  the server SDK) + `StdioClientTransport`.
- asserts:
  1. initialize handshake OK; server name `qmd-remote`
  2. `tools/list` → exactly `query`, `get`, `multi_get`, `status`
  3. `tools/call query {query: "banana smoothie"}` → result text mentions
     `banana.md`; mock hits grew (embed + rerank + expand)
  4. `tools/call get {file: <banana>}` → body with line numbers
  5. `tools/call status` → doc counts
  6. close client → server process exits (EOF shutdown), no orphan

### P4.4 — public entry + docs

- `src/index.ts`: export `createQmdRemoteMcpServer` (+ its options type).
- README stub: one line about `qmd-remote mcp`.
- Plan/spec ticks.

## Checkpoint/commit sequence — ACTUAL (2026-10-31)

- All of P4.1–P4.4 landed in one commit `0652860` (mcp.ts + CLI `mcp` +
  exports + e2e), since the server, wiring, and test are one interlocked unit.
- Deviations from the drafted plan:
  - **own InflightGate** (curried `track(cb) → wrapped cb`, mirroring qmd's
    exported gate's observable behavior) instead of importing qmd's
    `createInflightGate` — it lives in a subpath the exports map blocks, and a
    30-line gate is less coupling than another file-URL import.
  - instructions' collection list uses `listCollections()` (qmd's used
    `status.collections`, which we verified comes back empty after a YAML sync —
    same bug as in the CLI, P3).
  - `mcp` keeps stdout pure: load errors from `loadRemoteConfig`/`createStore`
    still print to stderr via main()'s catch — protocol-safe.
  - the one deliberate wording delta in the verbatim copy: `qmd embed` →
    `qmd-remote embed` in instructions (documented in the source header).

## Known risks / notes

- **SDK version match is load-bearing:** MCP SDK is fast-moving; pinning
  qmd's exact versions keeps protocol-era behavior identical to what qmd users
  already experience (the dist comments talk about "2026-07-28 vs 2025-era
  clients" — same SDK = same dual-speak behavior).
- **`serveStdio` must come from the SERVER package** (qmd's comment: a
  hand-wired `StdioServerTransport` would stay 2025-only) — copy the import
  paths exactly as dist/mcp/server.js does.
- **Copy drift:** the verbatim description copy is the price of patch-free;
  the P4 e2e asserts tool NAMES but not wording — wording drift is cosmetic,
  behavior drift would show in e2e. Re-sync on qmd bumps via the D11 flow.
- **stdio purity:** the MCP server must never write to stdout except protocol
  frames — our CLI's `console.error` usage is safe (stderr); the embed
  progress writer in `cmdEmbed` is CLI-only, not in the MCP path. Double-check
  no stray `console.log` in the server path.
- The `qmd://` resource uses `decodeURIComponent` + `store.get` — copied as-is.
- Server is HTTP-free (stdio only) in v1; an `--http <port>` mode can ride on
  qmd's exported `createMcpHandler` later if asked (out of scope).
