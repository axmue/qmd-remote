/**
 * MCP-over-HTTP e2e — starts the built `startQmdRemoteMcpHttpServer` in-process
 * against a pre-indexed temp store + loopback mock provider, and drives it with
 * a real `StreamableHTTPClientTransport` client (exactly how a networked agent
 * would). Also covers `/health`, the Host-header DNS-rebind guard, and the
 * optional bearer token. Offline + GPU-free (all jobs are remote mocks).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startQmdRemoteMcpHttpServer } from "../src/index.js";
import { startMockServer, type MockServer } from "./helpers/mock-server.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

before(() => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js missing — run `npm run build` (pretest should have done it)");
});

const DIMS = 16;
function vecFor(text: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let x = h >>> 0;
  const out: number[] = [];
  for (let i = 0; i < DIMS; i++) {
    x = Math.imul(x ^ (x >>> 13), 0x5bd1e995) >>> 0;
    out.push((x % 1000) / 1000);
  }
  if (out.reduce((s, v) => s + v, 0) === 0) out[0] = 0.1;
  return out;
}

async function mockProvider(): Promise<MockServer> {
  return startMockServer({
    "/v1/embeddings": (body) =>
      Array.isArray(body.input)
        ? { data: (body.input as string[]).map((t, i) => ({ embedding: vecFor(t), index: i })) }
        : { data: [{ embedding: vecFor(String(body.input)) }] },
    "/v1/rerank": (body) => {
      const words = String(body.query).toLowerCase().split(/\s+/).filter(Boolean);
      const docs = (body.documents as string[]) ?? [];
      return { results: docs.map((d, i) => ({ index: i, relevance_score: words.length ? words.filter((w) => d.toLowerCase().includes(w)).length / words.length : 0 })) };
    },
    "/v1/chat/completions": () => ({ choices: [{ message: { content: "lex: banana smoothie\nvec: banana smoothie recipe" } }] }),
  });
}

interface Fixture {
  dbPath: string;
  configPath: string;
  jobs: unknown;
}

/** temp docs + index.yml + jobs; index populated via the CLI (update+embed). */
async function makeIndexedFixture(mockUrl: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "qmd-remote-http-"));
  const docsDir = join(root, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "banana.md"), "# Banana smoothie\n\nBlend 2 bananas, yogurt and honey for a banana smoothie.\n");
  writeFileSync(join(docsDir, "apple.md"), "# Apple pie\n\nApple pie recipe with a lattice crust and cinnamon.\n");
  const cfgDir = join(root, "qmd-config");
  mkdirSync(cfgDir, { recursive: true });
  const configPath = join(cfgDir, "index.yml");
  writeFileSync(configPath, `collections:\n  mcp:\n    path: ${docsDir}\n`);
  const jobs = {
    embed: { provider: "openai-compat", baseUrl: `${mockUrl}/v1`, model: "mock-embed" },
    rerank: { provider: "openai-compat", baseUrl: `${mockUrl}/v1`, model: "mock-rerank" },
    expand: { provider: "openai-compat", baseUrl: `${mockUrl}/v1`, model: "mock-expand" },
  };
  const jobsFile = join(root, "qmd-remote-config.json");
  writeFileSync(jobsFile, JSON.stringify({ jobs }));
  const dbPath = join(root, "index.sqlite");
  const env = { INDEX_PATH: dbPath, QMD_CONFIG_DIR: cfgDir, QMD_REMOTE_CONFIG: jobsFile };
  const run = (args: string[]) =>
    new Promise<{ code: number; err: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, cwd: root });
      let err = "";
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (code) => resolve({ code: code ?? -1, err }));
    });
  const u = await run(["update"]);
  assert.equal(u.code, 0, u.err);
  const e = await run(["embed"]);
  assert.equal(e.code, 0, e.err);
  return { dbPath, configPath, jobs };
}

/** Raw request with explicit headers (fetch forbids setting Host). */
function rawPost(port: number, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const INIT_BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });

test("mcp-http: Streamable HTTP client → initialize → tools/list → tools/call query, remote provider hits", async () => {
  const mock = await mockProvider();
  const fx = await makeIndexedFixture(mock.url);
  const server = await startQmdRemoteMcpHttpServer({ dbPath: fx.dbPath, configPath: fx.configPath, jobs: fx.jobs, host: "127.0.0.1", port: 0, quiet: true });
  try {
    const client = new Client({ name: "qmd-remote-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    await client.connect(transport);
    try {
      const info = await client.getServerVersion();
      assert.equal(info?.name, "qmd-remote");

      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["get", "multi_get", "query", "status"]);

      const hitsBefore = mock.hits["/v1/embeddings"]?.length ?? 0;
      const q = await client.callTool({ name: "query", arguments: { query: "banana smoothie" } });
      assert.match(JSON.stringify(q), /banana\.md/);
      assert.ok((mock.hits["/v1/embeddings"]?.length ?? 0) > hitsBefore, "query must embed via the remote provider");
      assert.ok((mock.hits["/v1/rerank"]?.length ?? 0) > 0, "query must rerank via the remote provider");
    } finally {
      await client.close();
    }

    // /health is an unauthenticated 200.
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(health.status, 200);
    assert.match(await health.text(), /"status":"ok"/);

    // DNS-rebind guard: a Host outside the allowlist → 403 (before any MCP work).
    const bad = await rawPost(server.port, "/mcp", { host: "evil.example" }, INIT_BODY);
    assert.equal(bad.status, 403, bad.text);
  } finally {
    await server.stop();
    await mock.close();
  }
});

test("mcp-http: optional bearer token — missing/garbage → 401, correct → 200", async () => {
  const mock = await mockProvider();
  const fx = await makeIndexedFixture(mock.url);
  const token = "s3cr3t-token";
  const server = await startQmdRemoteMcpHttpServer({ dbPath: fx.dbPath, configPath: fx.configPath, jobs: fx.jobs, host: "127.0.0.1", port: 0, token, quiet: true });
  try {
    // no Authorization → 401
    const noAuth = await rawPost(server.port, "/mcp", {}, INIT_BODY);
    assert.equal(noAuth.status, 401, noAuth.text);
    // wrong token → 401
    const wrong = await rawPost(server.port, "/mcp", { authorization: "Bearer nope" }, INIT_BODY);
    assert.equal(wrong.status, 401, wrong.text);

    // correct token via the real client's requestInit headers → full handshake works
    const client = new Client({ name: "qmd-remote-http-auth", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.length === 4);
    } finally {
      await client.close();
    }

    // health stays open even with a token set (liveness probes carry no auth).
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(health.status, 200);
  } finally {
    await server.stop();
    await mock.close();
  }
});
