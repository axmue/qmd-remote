/**
 * Loopback mock HTTP server for tests (tests stay offline — repo policy).
 * Route functions may return `{ _status: 401, ... }` for error responses.
 * `hits` records every request body per URL for assertions.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RouteResult {
  /** non-2xx status to respond with (200 when absent). */
  _status?: number;
  [key: string]: unknown;
}
export type RouteFn = (body: Record<string, unknown>) => RouteResult;

export interface MockServer {
  url: string;
  hits: Record<string, Record<string, unknown>[]>;
  close: () => Promise<void>;
}

export async function startMockServer(routes: Record<string, RouteFn>): Promise<MockServer> {
  const hits: Record<string, Record<string, unknown>[]> = {};
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const route = routes[req.url ?? ""];
      if (!route) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no mock route for ${req.url}` }));
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* keep {} */
      }
      hits[req.url ?? ""] ??= [];
      hits[req.url ?? ""].push(body);
      const out = route(body);
      const status = out._status ?? 200;
      const { _status: _drop, ...payload } = out;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
