/**
 * MCP e2e — drives the BUILT `qmd-remote mcp` server with a real MCP client
 * over stdio (exactly how an agent would), against a pre-indexed temp store
 * and a loopback mock provider. Covers the full tool surface: query
 * (incl. metadata `filter`), get, status, and the metadata discovery tool.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
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

/** temp docs + index.yml + remote jobs config; index populated via the CLI. */
async function makeIndexedFixture(mockUrl: string): Promise<{ root: string; env: Record<string, string> }> {
  const root = mkdtempSync(join(tmpdir(), "qmd-remote-mcp-"));
  const docsDir = join(root, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    join(docsDir, "banana.md"),
    "---\nqmd:\n  metadata:\n    type: bug\n---\n# Banana smoothie\n\nBlend 2 bananas, yogurt and honey for a banana smoothie.\n",
  );
  writeFileSync(
    join(docsDir, "apple.md"),
    "---\nqmd:\n  metadata:\n    type: feature\n---\n# Apple pie\n\nApple pie recipe with a lattice crust and cinnamon.\n",
  );
  const cfgDir = join(root, "qmd-config");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "index.yml"), `collections:\n  mcp:\n    path: ${docsDir}\n`);
  const jobsFile = join(root, "qmd-remote-config.json");
  writeFileSync(
    jobsFile,
    JSON.stringify({
      jobs: {
        embed: { provider: "openai-compat", baseUrl: `${mockUrl}/v1`, model: "mock-embed" },
        rerank: { provider: "openai-compat", baseUrl: `${mockUrl}/v1`, model: "mock-rerank" },
        expand: { provider: "openai-compat", baseUrl: `${mockUrl}/v1`, model: "mock-expand" },
      },
    }),
  );
  const env = { INDEX_PATH: join(root, "index.sqlite"), QMD_CONFIG_DIR: cfgDir, QMD_REMOTE_CONFIG: jobsFile };
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, cwd: root });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    });
  const u = await run(["update"]);
  assert.equal(u.code, 0, u.err);
  const e = await run(["embed"]);
  assert.equal(e.code, 0, e.err);
  return { root, env };
}

test("mcp: initialize → tools/list → tools/call (query/get/status) over stdio, remote provider hits", async () => {
  const mock = await mockProvider();
  const { root, env } = await makeIndexedFixture(mock.url);
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp"],
      cwd: root,
      env: { ...getDefaultEnvironment(), ...env },
      stderr: "ignore",
    });
    const client = new Client({ name: "qmd-remote-test", version: "0.0.0" });

    // 6 (registered before close): client close → stdin EOF → server process exits (no orphan)
    const serverExited = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      transport.onclose = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });

    await client.connect(transport);

    try {
      // 1. initialize: server identity
      const info = await client.getServerVersion();
      assert.ok(info, "server version missing");
      assert.equal(info.name, "qmd-remote");

      // 2. tools/list: exactly the five qmd tools
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ["get", "metadata", "multi_get", "query", "status"]);

      // 3. tools/call query → banana doc, remote provider hit
      const hitsBefore = mock.hits["/v1/embeddings"]?.length ?? 0;
      const q = await client.callTool({ name: "query", arguments: { query: "banana smoothie" } });
      const qText = JSON.stringify(q);
      assert.match(qText, /banana\.md/);
      assert.ok((mock.hits["/v1/embeddings"]?.length ?? 0) > hitsBefore, "query must embed via the remote provider");
      assert.ok((mock.hits["/v1/rerank"]?.length ?? 0) > 0, "query must rerank via the remote provider");

      // 4. tools/call get → body with line numbers
      const g = await client.callTool({ name: "get", arguments: { file: "banana.md" } });
      const gText = JSON.stringify(g);
      assert.match(gText, /banana/i);
      assert.match(gText, /1:/); // line numbers on

      // 5. tools/call status → counts
      const s = await client.callTool({ name: "status", arguments: {} });
      assert.match(JSON.stringify(s), /Total documents: 2/);

      // 6. tools/call metadata → typed key summaries from qmd.metadata frontmatter
      const md = await client.callTool({ name: "metadata", arguments: {} });
      assert.equal(md.isError, undefined);
      const mdSc = (md.structuredContent ?? {}) as {
        totalKeys: number;
        keys: Array<{
          key: string;
          types: Array<{ type: string; values: Array<{ value: unknown; documents: number }> }>;
        }>;
      };
      assert.equal(mdSc.totalKeys, 1);
      assert.equal(mdSc.keys[0].key, "type");
      assert.equal(mdSc.keys[0].types[0].type, "string");
      assert.deepEqual(mdSc.keys[0].types[0].values.map((v) => v.value).sort(), ["bug", "feature"]);
      assert.match(JSON.stringify(md), /type/);

      // 7. query accepts a metadata `filter`: with the fixture docs' metadata
      //    (banana: type=bug, apple: type=feature) and a query that both docs
      //    can match, each filter admits exactly its own doc.
      const fq = await client.callTool({
        name: "query",
        arguments: { query: "banana smoothie", filter: { field: "type", operator: "eq", value: "bug" } },
      });
      const fqText = JSON.stringify(fq);
      assert.match(fqText, /banana\.md/);
      assert.doesNotMatch(fqText, /apple\.md/);
      const fnq = await client.callTool({
        name: "query",
        arguments: { query: "banana smoothie", filter: { field: "type", operator: "eq", value: "feature" } },
      });
      const fnqText = JSON.stringify(fnq);
      assert.match(fnqText, /apple\.md/);
      assert.doesNotMatch(fnqText, /banana\.md/);
      // A malformed filter (missing operator) comes back as a validation-error
      // tool result, not a crash — the server keeps serving.
      const ff = await client.callTool({
        name: "query",
        arguments: { query: "banana smoothie", filter: { field: "type" } },
      });
      assert.equal(ff.isError, true);
      assert.match(JSON.stringify(ff), /Error:/);
      const s2 = await client.callTool({ name: "status", arguments: {} });
      assert.match(JSON.stringify(s2), /Total documents: 2/);
    } finally {
      await client.close();
    }
    assert.ok(await serverExited, "server should exit after client close (EOF shutdown)");
  } finally {
    await mock.close();
  }
});
