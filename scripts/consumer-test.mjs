#!/usr/bin/env node
/**
 * P5 consumer test — the publish gate (spec D13; plan:
 * docs/tmp/qmd-remote-p5-plan.md). Proves the packed tarball works the way a
 * consumer gets it: fresh temp project, clean node_modules, drive CLI + SDK +
 * MCP from there. Doubles as D11's future CI compat job (same script, new pin).
 *
 * Usage: node scripts/consumer-test.mjs   (exit 0 = all checks OK)
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

// ---------------------------------------------------------------------------
// checklist
// ---------------------------------------------------------------------------
const results = [];
async function check(name, fn) {
  process.stdout.write(`- ${name} … `);
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("OK");
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL\n    ${err instanceof Error ? err.message : err}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---------------------------------------------------------------------------
// mock provider (same routes as the in-repo tests)
// ---------------------------------------------------------------------------
const DIMS = 16;
function vecFor(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let x = h >>> 0;
  const out = [];
  for (let i = 0; i < DIMS; i++) {
    x = Math.imul(x ^ (x >>> 13), 0x5bd1e995) >>> 0;
    out.push((x % 1000) / 1000);
  }
  if (out.reduce((s, v) => s + v, 0) === 0) out[0] = 0.1;
  return out;
}
function startMock(fail = false) {
  const hits = {};
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits[req.url] = (hits[req.url] ?? 0) + 1;
      const j = JSON.parse(raw || "{}");
      const json = (body, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (fail) return json({ error: { message: "bad key" } }, 401);
      if (req.url === "/v1/embeddings") {
        return json(
          Array.isArray(j.input)
            ? { data: j.input.map((t, i) => ({ embedding: vecFor(t), index: i })) }
            : { data: [{ embedding: vecFor(String(j.input)) }] },
        );
      }
      if (req.url === "/v1/rerank") {
        const words = String(j.query).toLowerCase().split(/\s+/).filter(Boolean);
        const docs = j.documents ?? [];
        return json({
          results: docs.map((d, i) => ({ index: i, relevance_score: words.length ? words.filter((w) => d.toLowerCase().includes(w)).length / words.length : 0 })),
        });
      }
      if (req.url === "/v1/chat/completions") {
        return json({ choices: [{ message: { content: "lex: banana smoothie\nvec: banana smoothie recipe" } }] });
      }
      json({ error: `no route ${req.url}` }, 404);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        hits,
        close: () => new Promise((r) => server.close(r)),
      });
    }),
  );
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, cwd: opts.cwd });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "qmd-remote-consumer-"));
let mock;
try {
  // 1. pack
  const tarball = (() => {
    execSync(`npm pack --pack-destination "${tmp}"`, { cwd: PKG_ROOT, stdio: "pipe" });
    const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    assert(tgz, "npm pack produced no tarball");
    return join(tmp, tgz);
  })();
  console.log(`packed: ${tarball.split("/").pop()}\n`);

  // 2. fresh consumer
  const consumer = join(tmp, "consumer");
  mkdirSync(consumer, { recursive: true });
  execSync("npm init -y", { cwd: consumer, stdio: "pipe" });
  const install = execSync(`npm install --no-audit --no-fund "${tarball}" @modelcontextprotocol/client@2.0.0`, {
    cwd: consumer,
    stdio: "pipe",
  });
  void install;

  const cliPath = join(consumer, "node_modules", "qmd-remote", "dist", "cli.js");
  const binPath = join(consumer, "node_modules", ".bin", "qmd-remote");

  await check("single physical copy of @tobilu/qmd (D5)", () => {
    // qmd's exports map is ESM-only ("import"+"types", no "require", no subpaths),
    // so resolve through ESM: import.meta.resolve applies the "import" condition.
    const resolved = execSync(
      `node --input-type=module -e "console.log(import.meta.resolve('@tobilu/qmd'))"`,
      { cwd: consumer },
    )
      .toString()
      .trim();
    const realConsumer = realpathSync(consumer);
    assert(resolved.startsWith(`file://${realConsumer}/`), `qmd resolved outside the consumer: ${resolved}`);
  });

  await check("bin installed + --help", async () => {
    assert(existsSync(binPath), `bin missing at ${binPath}`);
    const r = await run(NODE, [cliPath, "--help"]);
    assert(r.code === 0, `--help exit ${r.code}: ${r.err}`);
    assert(r.out.includes("Usage: qmd-remote"), "usage text missing");
  });

  // fixture: docs + index.yml + jobs config (mock provider)
  mock = await startMock(false);
  const docsDir = join(tmp, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "banana.md"), "---\nqmd:\n  metadata:\n    kind: fruit\n---\n# Banana smoothie\n\nBlend 2 bananas, yogurt and honey for a banana smoothie.\n");
  writeFileSync(join(docsDir, "apple.md"), "# Apple pie\n\nApple pie recipe with a lattice crust and cinnamon.\n");
  const cfgDir = join(tmp, "qmd-config");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "index.yml"), `collections:\n  consumer:\n    path: ${docsDir}\n`);
  const jobsFile = join(tmp, "jobs.json");
  const env = {
    INDEX_PATH: join(tmp, "index.sqlite"),
    QMD_CONFIG_DIR: cfgDir,
    QMD_REMOTE_CONFIG: jobsFile,
  };
  const writeJobs = (url) =>
    writeFileSync(
      jobsFile,
      JSON.stringify({
        jobs: {
          embed: { provider: "openai-compat", baseUrl: `${url}/v1`, model: "mock-embed" },
          rerank: { provider: "openai-compat", baseUrl: `${url}/v1`, model: "mock-rerank" },
          expand: { provider: "openai-compat", baseUrl: `${url}/v1`, model: "mock-expand" },
        },
      }),
    );

  // 5. SDK from the consumer
  const sdkTest = join(consumer, "sdk-test.mjs");
  writeFileSync(
    sdkTest,
    `
import { createStoreRemote } from "qmd-remote";
const store = await createStoreRemote(); // env: INDEX_PATH / QMD_CONFIG_DIR / QMD_REMOTE_CONFIG
const u = await store.update();
if (u.indexed < 2) throw new Error("update: expected >=2 indexed, got " + JSON.stringify(u));
await store.embed();
const hits = await store.search({ query: "banana smoothie" });
const top = hits[0];
if (!top || !(top.displayPath.includes("banana") || top.file.includes("banana"))) throw new Error("search: top is not banana.md: " + JSON.stringify(top));
await store.close();
console.log("sdk-ok");
`,
  );
  writeJobs(mock.url);
  await check("SDK: createStoreRemote + update + embed + search (from consumer)", async () => {
    const r = await run(NODE, [sdkTest], { cwd: consumer, env });
    assert(r.code === 0, `sdk exit ${r.code}: ${r.err}`);
    assert(r.out.includes("sdk-ok"), "sdk-ok missing");
    assert((mock.hits["/v1/embeddings"] ?? 0) > 0, "mock provider never hit");
  });

  // 6. CLI from the consumer (fresh index so the counts are predictable)
  rmSync(env.INDEX_PATH, { force: true });
  await check("CLI: update + embed + query + status + doctor", async () => {
    let r = await run(NODE, [cliPath, "update"], { cwd: consumer, env });
    assert(r.code === 0, `update exit ${r.code}: ${r.err}`);
    assert(r.out.includes("Indexed: 2"), `update out: ${r.out}`);
    r = await run(NODE, [cliPath, "embed"], { cwd: consumer, env });
    assert(r.code === 0, `embed exit ${r.code}: ${r.err}`);
    r = await run(NODE, [cliPath, "query", "banana", "smoothie"], { cwd: consumer, env });
    assert(r.code === 0, `query exit ${r.code}: ${r.err}`);
    assert(r.out.includes("banana.md"), `query out: ${r.out}`);
    r = await run(NODE, [cliPath, "status"], { cwd: consumer, env });
    assert(r.code === 0 && r.out.includes("Documents:  2"), `status out: ${r.out}`);
    r = await run(NODE, [cliPath, "doctor"], { cwd: consumer, env });
    assert(r.code === 0, `doctor exit ${r.code}: ${r.err} ${r.out}`);
    assert(r.out.includes("dims"), `doctor out: ${r.out}`);
  });

  await check("CLI: doctor red on 401 provider (exit 1, D7)", async () => {
    const badMock = await startMock(true);
    try {
      writeJobs(badMock.url);
      const r = await run(NODE, [cliPath, "doctor"], { cwd: consumer, env });
      assert(r.code === 1, `expected exit 1, got ${r.code}`);
      assert((r.out + r.err).includes("HTTP 401"), `no HTTP 401 in output: ${r.out} ${r.err}`);
    } finally {
      await badMock.close();
    }
    writeJobs(mock.url);
  });

  // 7. MCP from the consumer
  const mcpTest = join(consumer, "mcp-test.mjs");
  writeFileSync(
    mcpTest,
    `
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [process.argv[2], "mcp"],
  env: { ...getDefaultEnvironment(), ...process.env },
  stderr: "ignore",
});
const client = new Client({ name: "consumer-mcp-test", version: "0.0.0" });
const exited = new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 10000);
  transport.onclose = () => { clearTimeout(t); resolve(true); };
});
await client.connect(transport);
const info = await client.getServerVersion();
if (!info || info.name !== "qmd-remote") throw new Error("server name: " + JSON.stringify(info));
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
if (JSON.stringify(tools) !== JSON.stringify(["get", "metadata", "multi_get", "query", "status"])) throw new Error("tools: " + JSON.stringify(tools));
const meta = await client.callTool({ name: "metadata", arguments: {} });
if (!JSON.stringify(meta).includes("kind")) throw new Error("metadata result: " + JSON.stringify(meta).slice(0, 200));
const q = await client.callTool({ name: "query", arguments: { query: "banana smoothie" } });
if (!JSON.stringify(q).includes("banana.md")) throw new Error("query result: " + JSON.stringify(q).slice(0, 200));
const qf = await client.callTool({ name: "query", arguments: { query: "banana smoothie", filter: { field: "kind", operator: "eq", value: "fruit" } } });
if (!JSON.stringify(qf).includes("banana.md")) throw new Error("filtered query result: " + JSON.stringify(qf).slice(0, 200));
const qbad = await client.callTool({ name: "query", arguments: { query: "banana", filter: { nonsense: true } } });
if (!qbad.isError || !JSON.stringify(qbad).includes("Error")) throw new Error("malformed filter should error: " + JSON.stringify(qbad).slice(0, 200));
await client.close();
if (!(await exited)) throw new Error("server did not exit after client close");
console.log("mcp-ok");
`,
  );
  await check("MCP: client over stdio (initialize/tools/metadata/query+filter/exit) from consumer", async () => {
    const r = await run(NODE, [mcpTest, cliPath], { cwd: consumer, env });
    assert(r.code === 0, `mcp exit ${r.code}: ${r.err}`);
    assert(r.out.includes("mcp-ok"), "mcp-ok missing");
  });
} finally {
  if (mock) await mock.close();
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : " — PUBLISH GATE MET"}`);
process.exit(failed.length > 0 ? 1 : 0);
