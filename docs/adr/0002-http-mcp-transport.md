# ADR-0002 — Native Streamable-HTTP MCP transport

**Date:** 2026-11-13 · **Status:** accepted · Supersedes the "HTTP later if
asked" deferral in spec P4.

## Context

The `mcp` command shipped stdio-only. A consumer needs to reach a collection's
MCP server **over the network** (independent indexes per collection, each on its
own port, served from a terminal as a proof of concept). stdio cannot cross
machines.

## Decision

Add a native Streamable-HTTP transport instead of an external bridge
(supergateway / mcp-proxy).

- **Reuse qmd's own pattern.** qmd's `dist/mcp/server.js::startMcpHttpServer`
  serves `createMcpHandler(factory, { responseMode: "json" })` behind a plain
  `node:http` server, hand-rolling the `node:http ↔ web Request/Response`
  bridge. We mirror it in `src/mcp-http.ts::startQmdRemoteMcpHttpServer` over
  **our** remote-wired store (`createStoreRemote`) and **our**
  `createQmdRemoteMcpServer` factory. "The same way the mcp server inside qmd is
  built."
- **No new dependency.** The pinned `@modelcontextprotocol/server` 2.0.0 already
  exports every primitive needed (`createMcpHandler`, `validateHostHeader`,
  `localhostAllowedHostnames`). We deliberately do **not** add
  `@modelcontextprotocol/node` / `toNodeHandler` — qmd avoids it too, and the
  bridge is ~40 lines. Keeps the "one physical copy of qmd, minimal surface"
  posture (D5).
- **Surface:** `POST /mcp` (sessionless JSON, 2026-07-28) + `GET /health`.
  **No** REST `/query` /`/search` aliases (qmd has them; we add only if a
  non-MCP client needs them).
- **Security:** a `Host`-header allowlist (DNS-rebinding guard, via the SDK's
  `validateHostHeader`) runs first; an **optional** static bearer token
  (constant-time compare, resolved through `resolveSecret` so `env:`/`file:`
  work) runs next. Default bind `127.0.0.1`; exposing is an explicit
  `--host <addr>`. The network is the trust boundary (tailnet); when no token is
  set a startup warning says so. We did **not** wire the SDK's OAuth
  `verifyBearerToken` — overkill for a static shared token.
- **CLI:** `mcp --http --port <n> [--host <addr>] [--allowed-host <h>]...
  [--token <ref>]`. **stdio stays the default** (`mcp` with no `--http`).
  `--http` requires `--port`; the HTTP-only flags without `--http` are a usage
  error (no silent-ignore, matching the existing `validateFlags` discipline).
- **Signals:** SIGINT/SIGTERM teardown lives in the CLI, not in
  `startQmdRemoteMcpHttpServer` — so tests start/`stop()` a server without
  installing global handlers.
- **SDK door:** `startQmdRemoteMcpHttpServer` is exported from `index.ts`
  (packaged-surface change → `test:consumer` re-run; still 6/6).

## Consequences

- Each collection = one `qmd-remote mcp --http --port N --db … --jobs …` process
  (e.g. vci:8771, agv:8772), reachable at `http://<host>:N/mcp`.
- Local-embed servers load embeddinggemma resident (required for vector-space
  correctness); two collections = two model instances.
- `responseMode: "json"` drops mid-call notifications — fine for request/response
  search (no progress streaming needed). Revisit if a tool needs streaming.
- Tool surface unchanged → `check:mcp-drift` unaffected.

## Alternatives rejected

- **External bridge (supergateway/mcp-proxy):** another moving part and process
  per collection, and an extra protocol hop; the SDK already ships HTTP.
- **`@modelcontextprotocol/node` `toNodeHandler`:** a new dependency for a
  ~40-line bridge qmd itself doesn't use.
- **Mandatory bearer / OAuth:** heavier than a tailnet PoC needs; kept optional.
