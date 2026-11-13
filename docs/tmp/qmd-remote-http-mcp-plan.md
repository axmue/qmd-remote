# HTTP MCP transport for qmd-remote (the "HTTP later" from P4/D3)

Spec P4 shipped the MCP server as **stdio only** with "HTTP later if asked".
This is that follow-up: a native Streamable-HTTP transport for the `mcp`
command, so a remote agent can reach a collection over the (tail)net — no
external bridge (supergateway/mcp-proxy).

## Why native, not a bridge

- The pinned MCP SDK (`@modelcontextprotocol/server` 2.0.0) already exports the
  HTTP primitives: `createMcpHandler` (web-standard `{ fetch }`),
  `validateHostHeader` / `hostHeaderValidationResponse` /
  `localhostAllowedHostnames` (DNS-rebinding guard), `verifyBearerToken`.
- **qmd itself does exactly this** in `dist/mcp/server.js::startMcpHttpServer`:
  `createMcpHandler(() => createMcpServer(store), { responseMode: "json" })`
  behind a plain `node:http` server with an origin/host guard, `/mcp` +
  `/health`, host binding, SIGINT/SIGTERM teardown. We mirror that pattern over
  **our remote-wired store** and **our** `createQmdRemoteMcpServer` factory.
- No new dependency: qmd hand-rolls the `node:http ↔ web Request/Response`
  bridge (it does **not** use `@modelcontextprotocol/node`), so we do too.

## Design

New file `src/mcp-http.ts`:

```
startQmdRemoteMcpHttpServer({
  dbPath?, configPath?, jobs,          // same store wiring as cmdMcp (stdio)
  host,                                // bind address (e.g. the tailnet IP)
  port,                                // 8771 vci / 8772 agv
  allowedHosts?,                       // Host-header allowlist (DNS-rebind guard)
  token?,                              // optional bearer; undefined = no auth
  quiet?,
}) => { httpServer, port, stop }
```

Internals (copied shape from qmd's `startMcpHttpServer`, adapted):
1. `store = await createStoreRemote({ dbPath, configPath, jobs })` — the remote
   backend (local embed + remote rerank/expand) set on `store.internal.llm`.
2. `handler = createMcpHandler(() => createQmdRemoteMcpServer(store, { inflight }), { responseMode: "json" })`.
3. `node:http` `createServer`:
   - **Host-header guard** via SDK `validateHostHeader(host, allowedHosts)` →
     403 on mismatch (DNS-rebinding protection). Default allowlist = the bind
     host + `localhost` entries.
   - **Optional bearer**: when `token` set, `verifyBearerToken(authz, …)` →
     401 `WWW-Authenticate` on miss. When unset, no auth (tailnet is the
     boundary) — logged as a warning at startup.
   - `GET /health` → `{status:"ok",uptime}`.
   - `POST /mcp` → collect body, build web `Request`, `handler.fetch(req,{parsedBody})`,
     write status/headers/body back. (MCP is sessionless/JSON, 2026-07-28.)
   - else 404.
4. `listen(port, host)`, report `actualPort`.
5. `stop()` = `handler.close()` → `httpServer.close()` → `store.close()`;
   wired to SIGINT/SIGTERM.

Scope cut vs qmd: **no** REST `/query` `/search` aliases — MCP `/mcp` + `/health`
only. (Add later if a non-MCP client needs it.)

`src/cli.ts` — extend the existing `mcp` command (stdio stays the default):

```
qmd-remote mcp                       # stdio (unchanged)
qmd-remote mcp --http --port 8771    # Streamable HTTP
             [--host <addr>]          # default 127.0.0.1; set tailnet IP to expose
             [--allowed-host <h>]...  # repeatable Host allowlist
             [--token env:VAR|file:…] # optional bearer (resolveSecret)
             [-d <db>] [--config <y>] [--jobs <j>]   # already accepted
```

- parseArgs: add value flags `--host`, `--port`, `--allowed-host` (repeatable),
  `--token`; bool flag `--http`.
- COMMAND_FLAGS.mcp += http, host, port, allowed-host, token.
- `--http` requires `--port`; the HTTP-only flags are a usage error without
  `--http` (fail-loud, matches the existing validateFlags discipline).
- cmdMcp: if `p.http` → `startQmdRemoteMcpHttpServer(...)` and await a shutdown
  promise; else the current stdio path.

`src/index.ts`: export `startQmdRemoteMcpHttpServer` (SDK door) → packaged
surface change → `npm run test:consumer` must pass.

## Security posture (PoC, over tailnet)

- Default bind `127.0.0.1`. To expose on the tailnet, run with
  `--host <tailscale-ip|100.x.y.z>` (or the MagicDNS name resolved to the TS
  interface). Never `0.0.0.0` in the PoC docs.
- Host-header validation ON by default (bind host auto-allowed). WireGuard
  already authenticates peers; bearer `--token` is **optional** hardening.

## Tests (offline, GPU-free, per AGENTS.md "Done When")

`tests/mcp-http.test.ts`:
- Start `startQmdRemoteMcpHttpServer` on `127.0.0.1:0` with a **mock jobs**
  backend (loopback mock-server; embed/rerank/expand all mocked) over a tiny
  temp index (reuse the existing e2e store fixture used by the stdio MCP test).
- Connect `@modelcontextprotocol/client` `StreamableHTTPClientTransport` to
  `http://127.0.0.1:<port>/mcp`: handshake → `tools/list` (4 tools) →
  `tools/call query` returns a result. **Fails without the new server.**
- `GET /health` → 200. Host-guard: a bad `Host` header → 403. With `token`
  set: missing/garbage bearer → 401; correct bearer → 200.
- `npm run check` (typecheck + check:mcp-drift + tests) green;
  `npm run test:consumer` green (new export).

mcp-drift: tool surface unchanged → unaffected.

## Docs on disk

- Update `docs/specs/qmd-remote.md` P4/D3: "HTTP: DONE — Streamable HTTP in
  `src/mcp-http.ts`, mirrors qmd's `startMcpHttpServer`; stdio still default."
- New ADR: `docs/adr/0002-http-mcp-transport.md` (why native, scope cut, auth).
- README: a "Network (HTTP) MCP" subsection + the two-collection tailnet example
  (vci:8771 / agv:8772).

## Open decisions (confirm before coding)

1. **Auth**: tailnet-bind + Host-guard, bearer **optional** (my recommendation),
   vs. require a bearer token always?
2. **Surface**: `/mcp` + `/health` only (recommended) vs. also port qmd's REST
   `/query`?
3. **Flag names** as above (`--http`, `--host`, `--port`, `--allowed-host`,
   `--token`)?
4. **responseMode**: `json` (like qmd; simplest) — ok?
