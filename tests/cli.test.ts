/**
 * CLI tests — spawn the BUILT dist/cli.js exactly as a published user would
 * (pretest runs `npm run build`). Temp index + temp configs via qmd's own
 * override envs (INDEX_PATH / QMD_CONFIG_DIR) + QMD_REMOTE_CONFIG.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { startMockServer, type MockServer } from "./helpers/mock-server.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

before(() => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js missing — run `npm run build` (pretest should have done it)");
});

interface Fixture {
  root: string;
  dbPath: string;
  env: Record<string, string>;
  /** rewrite the jobs config file (same path, new content). */
  setJobs: (jobs: unknown) => void;
}

/** banana/apple/zebra docs + index.yml + all-local jobs config; env points qmd + qmd-remote at the temp dir. */
function makeFixture(jobs: unknown): Fixture {
  const root = mkdtempSync(join(tmpdir(), "qmd-remote-cli-"));
  const docsDir = join(root, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "banana.md"), "# Banana smoothie\n\nBlend 2 bananas, yogurt and honey for a banana smoothie.\n");
  writeFileSync(join(docsDir, "apple.md"), "# Apple pie\n\nApple pie recipe with a lattice crust and cinnamon.\n");
  writeFileSync(join(docsDir, "zebra.md"), "# Zebra crossings\n\nNotes on zebra crossings in city planning.\n");
  const cfgDir = join(root, "qmd-config");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "index.yml"), `collections:\n  cli:\n    path: ${docsDir}\n`);
  const jobsFile = join(root, "qmd-remote-config.json");
  const dbPath = join(root, "index.sqlite");
  const fixture: Fixture = {
    root,
    dbPath,
    env: { INDEX_PATH: dbPath, QMD_CONFIG_DIR: cfgDir, QMD_REMOTE_CONFIG: jobsFile },
    setJobs: (j) => writeFileSync(jobsFile, JSON.stringify({ jobs: j })),
  };
  fixture.setJobs(jobs);
  return fixture;
}

function runCli(f: Fixture, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...f.env }, cwd: f.root });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const ALL_LOCAL = { embed: { provider: "local" }, rerank: { provider: "local" }, expand: { provider: "local" } };

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

async function mockProvider(fail: boolean): Promise<MockServer> {
  return startMockServer({
    "/v1/embeddings": (body) =>
      fail
        ? { _status: 401, error: { message: "bad key" } }
        : Array.isArray(body.input)
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

const REMOTE_JOBS = (url: string) => ({
  embed: { provider: "openai-compat", baseUrl: `${url}/v1`, model: "mock-embed" },
  rerank: { provider: "openai-compat", baseUrl: `${url}/v1`, model: "mock-rerank" },
  expand: { provider: "openai-compat", baseUrl: `${url}/v1`, model: "mock-expand" },
});

test("status: empty temp index → counts, exit 0 (offline)", async () => {
  const f = makeFixture(ALL_LOCAL);
  const r = await runCli(f, ["status"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Documents:\s+0/);
  assert.match(r.out, /cli\s+.*docs/); // the fixture collection is listed
});

test("collections: add / list / remove round-trip", async () => {
  const f = makeFixture(ALL_LOCAL);
  const docs = join(f.root, "more-docs");
  mkdirSync(docs, { recursive: true });
  let r = await runCli(f, ["collections", "add", "extra", docs]);
  assert.equal(r.code, 0, r.err);
  r = await runCli(f, ["collections", "list"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /extra/);
  r = await runCli(f, ["collections", "remove", "extra"]);
  assert.equal(r.code, 0, r.err);
  r = await runCli(f, ["collections", "list"]);
  assert.doesNotMatch(r.out, /extra/);
  r = await runCli(f, ["collections", "remove", "nope"]);
  assert.equal(r.code, 1, "removing a missing collection must fail");
  assert.match(r.err, /not found/);
});

test("usage: unknown command → exit 2 + usage text", async () => {
  const f = makeFixture(ALL_LOCAL);
  const r = await runCli(f, ["frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command: frobnicate/);
  assert.match(r.err, /Usage: qmd-remote/);
});

test("update + embed + query through the mock provider (CLI write+search path)", async () => {
  const mock = await mockProvider(false);
  const f = makeFixture(ALL_LOCAL);
  f.setJobs(REMOTE_JOBS(mock.url));
  try {
    let r = await runCli(f, ["update"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Indexed: 3/);
    assert.match(r.out, /run 'qmd-remote embed'/);
    assert.equal(mock.hits["/v1/embeddings"]?.length ?? 0, 0, "update must not embed");

    r = await runCli(f, ["embed"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Embedded \d+ chunks from 3 docs/);
    assert.ok((mock.hits["/v1/embeddings"]?.length ?? 0) > 0, "embed must hit the provider");

    r = await runCli(f, ["query", "banana", "smoothie", "-n", "3"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /banana\.md/);
    assert.ok((mock.hits["/v1/rerank"]?.length ?? 0) > 0, "query must rerank via the provider");
    assert.ok((mock.hits["/v1/chat/completions"]?.length ?? 0) > 0, "query must expand via the provider");
  } finally {
    await mock.close();
  }
});

test("query --lex-only: finds the doc with ZERO provider hits", async () => {
  const mock = await mockProvider(false);
  const f = makeFixture(ALL_LOCAL);
  f.setJobs(REMOTE_JOBS(mock.url));
  try {
    let r = await runCli(f, ["update"]);
    assert.equal(r.code, 0, r.err);
    r = await runCli(f, ["query", "banana", "smoothie", "--lex-only"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /banana\.md/);
    assert.equal(mock.hits["/v1/embeddings"]?.length ?? 0, 0);
    assert.equal(mock.hits["/v1/rerank"]?.length ?? 0, 0);
    assert.equal(mock.hits["/v1/chat/completions"]?.length ?? 0, 0);
  } finally {
    await mock.close();
  }
});

test("doctor: green on a working provider, reports dims", async () => {
  const mock = await mockProvider(false);
  const f = makeFixture(ALL_LOCAL);
  f.setJobs(REMOTE_JOBS(mock.url));
  try {
    const r = await runCli(f, ["doctor"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /embed\s+openai-compat\s+OK \d+ dims/);
    assert.match(r.out, /rerank\s+openai-compat\s+OK/);
    assert.match(r.out, /expand\s+openai-compat\s+OK \d+ variants/);
  } finally {
    await mock.close();
  }
});

test("doctor: 401 provider → exit 1, stderr/stdout names the job + HTTP 401", async () => {
  const mock = await mockProvider(true);
  const f = makeFixture(ALL_LOCAL);
  f.setJobs(REMOTE_JOBS(mock.url));
  try {
    const r = await runCli(f, ["doctor"]);
    assert.equal(r.code, 1);
    assert.match(r.out + r.err, /embed.*HTTP 401/s);
  } finally {
    await mock.close();
  }
});

test("embed against a 401 provider → exit 1, provider error surfaces (D7, no local fallback)", async () => {
  const mock = await mockProvider(true);
  const f = makeFixture(ALL_LOCAL);
  f.setJobs(REMOTE_JOBS(mock.url));
  try {
    let r = await runCli(f, ["update"]);
    assert.equal(r.code, 0, r.err);
    r = await runCli(f, ["embed"]);
    assert.equal(r.code, 1, "provider failure must fail the command");
    assert.match(r.err, /HTTP 401/);
    assert.doesNotMatch(r.out + r.err, /local/); // no "falling back to local" wording
  } finally {
    await mock.close();
  }
});

test("--version prints the package version", async () => {
  const f = makeFixture(ALL_LOCAL);
  const r = await runCli(f, ["--version"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.trim(), /^\d+\.\d+\.\d+/);
});

test("usage: a flag the command does not use is rejected, not ignored", async () => {
  const f = makeFixture(ALL_LOCAL);
  const r = await runCli(f, ["status", "--force"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--force is not valid for 'status'/);
});

test("doctor: a dead EXPAND provider is reported red (expandQuery's soft fallback must not hide it)", async () => {
  // Only the expand job is remote, and it points at a closed port: the search
  // path degrades softly by design (qmd's own semantics), so this is exactly
  // the failure doctor exists to surface.
  const f = makeFixture({
    embed: { provider: "local" },
    rerank: { provider: "local" },
    expand: { provider: "openai-compat", baseUrl: "http://127.0.0.1:9/v1", model: "dead-model", timeoutMs: 2000 },
  });
  const r = await runCli(f, ["doctor"]);
  assert.equal(r.code, 1, "a dead provider must exit 1");
  assert.match(r.out + r.err, /expand.*dead-model/s);
  assert.doesNotMatch(r.out, /expand\s+openai-compat\s+OK/, "must not be reported green");
});

test("--jobs <path> selects the models config (overriding $QMD_REMOTE_CONFIG)", async () => {
  const mock = await mockProvider(false);
  const f = makeFixture(ALL_LOCAL); // $QMD_REMOTE_CONFIG → all-local
  const alt = join(f.root, "remote-jobs.json");
  writeFileSync(alt, JSON.stringify({ jobs: REMOTE_JOBS(mock.url) }));
  try {
    const r = await runCli(f, ["doctor", "--jobs", alt]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`config\\s+${alt.replace(/[/\\]/g, "\\$&")}`));
    assert.match(r.out, /embed\s+openai-compat\s+OK \d+ dims/);
  } finally {
    await mock.close();
  }
});

test("query: `--` ends option parsing so search text may start with a dash", async () => {
  const f = makeFixture(ALL_LOCAL);
  let r = await runCli(f, ["update"]);
  assert.equal(r.code, 0, r.err);
  r = await runCli(f, ["query", "--lex-only", "--", "-banana"]);
  assert.equal(r.code, 0, r.err);
  r = await runCli(f, ["query", "--lex-only", "-banana"]);
  assert.equal(r.code, 2, "without `--` a leading dash is still an unknown option");
});

test("status --json: getStatus().collections IS populated (settles the P3/P4 'comes back empty' claim)", async () => {
  // P3 and P4 both worked around an allegedly empty `getStatus().collections`
  // by using listCollections(). It is not empty — this test pins that so the
  // two idioms in the codebase (CLI table vs. MCP status tool) stay valid.
  const f = makeFixture(ALL_LOCAL);
  let r = await runCli(f, ["update"]);
  assert.equal(r.code, 0, r.err);
  r = await runCli(f, ["status", "--json"]);
  assert.equal(r.code, 0, r.err);
  const status = JSON.parse(r.out) as { totalDocuments: number; collections: { name: string; documents: number }[] };
  assert.equal(status.totalDocuments, 3);
  assert.deepEqual(status.collections.map((c) => c.name), ["cli"]);
  assert.equal(status.collections[0]!.documents, 3);
});
