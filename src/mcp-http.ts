/**
 * qmd-remote — MCP server over Streamable HTTP (the "HTTP later" from spec P4).
 *
 * Mirrors qmd 2.8.3's `dist/mcp/server.js::startMcpHttpServer`: the official
 * 2026-07-28 HTTP entry `createMcpHandler(factory, { responseMode: "json" })`
 * behind a plain `node:http` server. The one deliberate difference is the
 * store — ours is the remote-wired store from `createStoreRemote` (local embed
 * + remote rerank/expand on `store.internal.llm`) and the factory is our own
 * `createQmdRemoteMcpServer`. No `@modelcontextprotocol/node`: like qmd, we
 * hand-roll the `node:http ↔ web Request/Response` bridge.
 *
 * Surface: `POST /mcp` (sessionless JSON) + `GET /health`. No REST
 * `/query` /`/search` aliases (added only if a non-MCP client needs them).
 *
 * Security: a `Host`-header allowlist (DNS-rebinding guard, via the SDK's
 * `validateHostHeader`) runs first; an OPTIONAL static bearer token runs next.
 * The process-signal wiring lives in the CLI, not here, so tests can start and
 * `stop()` a server without installing global handlers.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler, localhostAllowedHostnames, validateHostHeader } from "@modelcontextprotocol/server";
import { createStoreRemote } from "./store-remote.js";
import { createQmdRemoteMcpServer } from "./mcp.js";

export interface StartHttpServerOptions {
  /** default: defaultQmdDbPath() (stock qmd location) — same as the stdio path. */
  dbPath?: string;
  /** index.yml path; null forces DB-only mode (mirrors createStoreRemote). */
  configPath?: string | null;
  /** raw or normalized jobs block (passed straight to createStoreRemote). */
  jobs: unknown;
  /** bind address. Default "127.0.0.1". Set a tailnet IP/name to expose. */
  host?: string;
  /** TCP port. 0 binds an ephemeral port (tests). */
  port: number;
  /**
   * `Host`-header allowlist (hostnames only, no ports; IPv6 in brackets).
   * Default: localhost set + the bind host. A `Host` outside it → 403.
   */
  allowedHosts?: string[];
  /** optional static bearer token; when set, `/mcp` requires `Authorization: Bearer <token>`. */
  token?: string;
  /** suppress the per-request / startup stderr log lines. */
  quiet?: boolean;
}

export interface HttpServerHandle {
  httpServer: Server;
  host: string;
  /** the actually-bound port (meaningful when `port: 0` was requested). */
  port: number;
  /** `http://host:port/mcp` */
  url: string;
  /** closes the MCP handler, the HTTP server, and the store. Idempotent. */
  stop: () => Promise<void>;
}

/** Default Host allowlist: the localhost set, plus the concrete bind host. */
function defaultAllowedHosts(host: string): string[] {
  const base = localhostAllowedHostnames();
  return base.includes(host) ? base : [...base, host];
}

function nodeHeadersToWeb(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
  }
  return headers;
}

async function collectBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

/** Constant-time `Authorization: Bearer <token>` check. */
function bearerOk(authHeader: string | undefined, token: string): boolean {
  if (!authHeader) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!m) return false;
  const provided = Buffer.from(m[1]!.trim());
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Start the qmd-remote MCP server over Streamable HTTP. Returns a handle for
 * port discovery and shutdown. HTTP is sessionless (MCP 2026-07-28): no
 * `Mcp-Session-Id`, no initialize handshake state; 2025-era clients are served
 * per-request by the SDK's stateless legacy fallback.
 */
export async function startQmdRemoteMcpHttpServer(options: StartHttpServerOptions): Promise<HttpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const allowedHosts = options.allowedHosts && options.allowedHosts.length > 0 ? options.allowedHosts : defaultAllowedHosts(host);
  const quiet = options.quiet ?? false;
  const log = (msg: string) => {
    if (!quiet) console.error(msg);
  };

  const store = await createStoreRemote({
    dbPath: options.dbPath,
    configPath: options.configPath,
    jobs: options.jobs,
  });

  // Official 2026-07-28 HTTP entry: one factory, a fresh instance per request,
  // JSON responses. Dual-speaks 2025-era traffic statelessly by default.
  const mcpHandler = createMcpHandler(() => createQmdRemoteMcpServer(store), { responseMode: "json" });

  const httpServer = createServer(async (nodeReq, nodeRes) => {
    const pathname = (nodeReq.url || "/").split("?")[0];
    try {
      // 1. DNS-rebinding guard (Host allowlist), ahead of everything else.
      const verdict = validateHostHeader(nodeReq.headers.host, allowedHosts);
      if (!verdict.ok) {
        nodeRes.writeHead(403, { "content-type": "application/json" });
        nodeRes.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32003, message: `Forbidden: ${verdict.message}` }, id: null }));
        return;
      }

      // 2. health — unauthenticated liveness probe.
      if (pathname === "/health" && nodeReq.method === "GET") {
        nodeRes.writeHead(200, { "content-type": "application/json" });
        nodeRes.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (pathname === "/mcp") {
        // 3. optional bearer auth.
        if (options.token !== undefined && !bearerOk(nodeReq.headers.authorization, options.token)) {
          nodeRes.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="qmd-remote"' });
          nodeRes.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
          return;
        }
        const rawBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD" ? await collectBody(nodeReq) : undefined;
        let parsedBody: unknown;
        if (rawBody) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            parsedBody = undefined;
          }
        }
        const hostHeader = typeof nodeReq.headers.host === "string" ? nodeReq.headers.host : `${host}:${options.port}`;
        const request = new Request(`http://${hostHeader}${pathname}`, {
          method: nodeReq.method || "GET",
          headers: nodeHeadersToWeb(nodeReq),
          ...(rawBody !== undefined ? { body: rawBody } : {}),
        });
        const response = await mcpHandler.fetch(request, parsedBody !== undefined ? { parsedBody } : undefined);
        nodeRes.writeHead(response.status, Object.fromEntries(response.headers));
        nodeRes.end(Buffer.from(await response.arrayBuffer()));
        return;
      }

      nodeRes.writeHead(404, { "content-type": "application/json" });
      nodeRes.end(JSON.stringify({ error: "Not Found" }));
    } catch (err) {
      console.error(`qmd-remote: HTTP handler error: ${err instanceof Error ? err.message : err}`);
      if (!nodeRes.headersSent) nodeRes.writeHead(500);
      nodeRes.end("Internal Server Error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const port = (httpServer.address() as AddressInfo).port;

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await mcpHandler.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await store.close();
  };

  log(`qmd-remote: MCP server listening on http://${host}:${port}/mcp`);
  if (options.token === undefined) {
    log(`qmd-remote: WARNING no --token — anyone who can reach ${host}:${port} can query this index (bind to a trusted network; the Host guard is not authentication).`);
  }

  return { httpServer, host, port, url: `http://${host}:${port}/mcp`, stop };
}
