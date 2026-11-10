/**
 * Provider adapter tests (port of axel-agent's qmd-backend tests, standalone).
 * All HTTP goes to a local mock server (loopback, ephemeral port) — tests
 * stay offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RemoteJobs } from "../src/backend/types.js";
import { createBackend } from "../src/backend/factory.js";
import { REMOTE_JOB_NAMES } from "../src/backend/config.js";
import { startMockServer } from "./helpers/mock-server.js";
import { FakeLlamaCpp } from "./helpers/fake-llamacpp.js";

const JOBS: RemoteJobs = {
  embed: { provider: "local" },
  rerank: { provider: "local" },
  expand: { provider: "local" },
};

// =============================================================================
// openai-compat adapter
// =============================================================================

test("openai-compat: embed (single, query prefix, model identity)", async () => {
  const mock = await startMockServer({
    "/v1/embeddings": (body) => ({ data: [{ embedding: [0.1, 0.2] }], model: "echo" }),
  });
  try {
    const jobs: RemoteJobs = {
      ...JOBS,
      embed: { provider: "openai-compat", baseUrl: `${mock.url}/v1/`, model: "jina-embeddings-v3", apiKey: "k", embedQueryPrefix: "query: " },
    };
    const backend = await createBackend(jobs);
    const r = await backend.embed("what is qmd?", { isQuery: true });
    assert.deepEqual(mock.hits["/v1/embeddings"]![0], { model: "jina-embeddings-v3", input: "query: what is qmd?" });
    assert.deepEqual(r, { embedding: [0.1, 0.2], model: "api:openai-compat:jina-embeddings-v3" });
    assert.equal(backend.embedModelName, "api:openai-compat:jina-embeddings-v3");
  } finally {
    await mock.close();
  }
});

test("openai-compat: embedBatch (single request, index reordering, auth header)", async () => {
  const mock = await startMockServer({
    "/v1/embeddings": (body) => ({
      data: [
        { embedding: [2, 2], index: 1 },
        { embedding: [1, 1], index: 0 },
      ],
    }),
  });
  try {
    const jobs: RemoteJobs = { ...JOBS, embed: { provider: "openai-compat", baseUrl: `${mock.url}/v1`, model: "m", apiKey: "secret" } };
    const backend = await createBackend(jobs);
    const res = await backend.embedBatch(["a", "b"]);
    assert.equal(mock.hits["/v1/embeddings"]!.length, 1);
    assert.deepEqual(mock.hits["/v1/embeddings"]![0].input, ["a", "b"]);
    assert.deepEqual(res.map((r) => r!.embedding), [[1, 1], [2, 2]]); // input order restored via index
    assert.equal(res[0]!.model, "api:openai-compat:m");
  } finally {
    await mock.close();
  }
});

test("openai-compat: embed failure is a HARD error, with status + detail", async () => {
  const mock = await startMockServer({
    "/v1/embeddings": () => ({ _status: 401, error: { message: "bad key" } }),
  });
  try {
    const jobs: RemoteJobs = { ...JOBS, embed: { provider: "openai-compat", baseUrl: `${mock.url}/v1`, model: "m" } };
    const backend = await createBackend(jobs);
    await assert.rejects(() => backend.embed("x"), /qmd-remote: embed \(openai-compat m\).*HTTP 401.*bad key/);
    await assert.rejects(() => backend.embedBatch(["x"]), /qmd-remote: embed \(openai-compat m\)/);
  } finally {
    await mock.close();
  }
});

test("openai-compat: rerank (Jina style, truncation, score sort, index map)", async () => {
  const mock = await startMockServer({
    "/v1/rerank": (body) => {
      const docs = body.documents as string[];
      // give the longest document the best score to verify sort + mapping
      const scores = docs.map((d) => d.length / 100);
      return {
        results: docs.map((_d, index) => ({ index, relevance_score: scores[index]! })).sort((a, b) => a.index - b.index).reverse(),
      };
    },
  });
  try {
    const jobs: RemoteJobs = { ...JOBS, rerank: { provider: "openai-compat", baseUrl: `${mock.url}/v1`, model: "jina-reranker-v2", rerankMaxChars: 5 } };
    const backend = await createBackend(jobs);
    const docs = [
      { file: "a.md", text: "short" },
      { file: "b.md", text: "much longer document text that exceeds five chars" },
      { file: "c.md", text: "mid" },
    ];
    const r = await backend.rerank("q", docs);
    const sent = mock.hits["/v1/rerank"]![0];
    assert.deepEqual((sent!.documents as string[])[1], "much "); // truncated to 5 chars
    assert.equal(r.results[0].file, "b.md"); // best score first
    assert.equal(r.results[0].index, 1);
    assert.equal(r.results.length, 3);
    assert.equal(r.model, "api:openai-compat:jina-reranker-v2");
  } finally {
    await mock.close();
  }
});

test("openai-compat: expandQuery parses type:text lines; provider error → original-query fallback", async () => {
  const good = (body: Record<string, unknown>) => ({
    choices: [
      {
        message: {
          content: "lex: qmd keyword\nvec: semantic twin of qmd\nbogus: nope\nlex: unrelated gibberish\nhyde: A passage about qmd",
        },
      },
    ],
  });
  let mode: "ok" | "fail" = "ok";
  const mock = await startMockServer({
    "/v1/chat/completions": (body) => (mode === "ok" ? good(body) : { _status: 500, error: { message: "boom" } }),
  });
  try {
    const jobs: RemoteJobs = { ...JOBS, expand: { provider: "openai-compat", baseUrl: `${mock.url}/v1`, model: "openrouter-llm" } };
    const backend = await createBackend(jobs);

    const ok = await backend.expandQuery("qmd search");
    assert.deepEqual(
      ok.map((q) => [q.type, q.text]),
      [
        ["lex", "qmd keyword"],
        ["vec", "semantic twin of qmd"],
        ["hyde", "A passage about qmd"],
      ],
    ); // "bogus" type + term-less line filtered, like qmd local

    const noLex = await backend.expandQuery("qmd search", { includeLexical: false });
    assert.ok(noLex.every((q) => q.type !== "lex"));

    mode = "fail";
    const fallback = await backend.expandQuery("qmd search");
    assert.deepEqual(fallback, [
      { type: "lex", text: "qmd search" },
      { type: "vec", text: "qmd search" },
    ]); // qmd's exception-fallback — no local model involved

    assert.equal(backend.generateModelName, "api:openai-compat:openrouter-llm");
    mode = "ok";
    const gen = await backend.generate("expand me");
    assert.equal(gen!.done, true);
  } finally {
    await mock.close();
  }
});

// =============================================================================
// ollama adapter
// =============================================================================

test("ollama: embed single + batch via /api/embed", async () => {
  const mock = await startMockServer({
    "/api/embed": (body) => {
      const input = body.input as string | string[];
      if (Array.isArray(input)) return { embeddings: input.map((t) => [t.length, t.length]) };
      return { embedding: [9, 9] };
    },
  });
  try {
    const jobs: RemoteJobs = { ...JOBS, embed: { provider: "ollama", model: "nomic-embed" } };
    jobs.embed.baseUrl = mock.url; // default would be http://127.0.0.1:11434
    const backend = await createBackend(jobs);
    const single = await backend.embed("hello");
    assert.deepEqual(single, { embedding: [9, 9], model: "api:ollama:nomic-embed" });
    const batch = await backend.embedBatch(["ab", "cde"]);
    assert.deepEqual(batch.map((r) => r!.embedding), [[2, 2], [3, 3]]);
    assert.deepEqual(mock.hits["/api/embed"]![1].input, ["ab", "cde"]);
  } finally {
    await mock.close();
  }
});

test("ollama: rerank via /api/rerank + expand via /api/chat", async () => {
  const mock = await startMockServer({
    "/api/rerank": (body) => ({ results: (body.documents as string[]).map((_d, index) => ({ index, score: 1 / (index + 1) })) }),
    "/api/chat": () => ({ message: { content: "vec: hello world rephrased\nhyde: a passage about hello world" } }),
  });
  try {
    const jobs: RemoteJobs = {
      ...JOBS,
      rerank: { provider: "ollama", baseUrl: mock.url, model: "rerank-m" },
      expand: { provider: "ollama", baseUrl: mock.url, model: "gen-m" },
    };
    const backend = await createBackend(jobs);
    const r = await backend.rerank("q", [
      { file: "a.md", text: "one" },
      { file: "b.md", text: "two" },
    ]);
    assert.equal(r.results[0].file, "a.md"); // 1/1 > 1/2
    assert.equal(backend.rerankModelName, "api:ollama:rerank-m");

    const e = await backend.expandQuery("hello world");
    assert.deepEqual(e.map((q) => q.type), ["vec", "hyde"]);
    assert.equal(mock.hits["/api/chat"]![0].stream, false);
  } finally {
    await mock.close();
  }
});

test("ollama: server error body surfaces as a hard error", async () => {
  const mock = await startMockServer({
    "/api/rerank": () => ({ error: "model not found" }),
  });
  try {
    const jobs: RemoteJobs = { ...JOBS, rerank: { provider: "ollama", baseUrl: mock.url, model: "nope" } };
    const backend = await createBackend(jobs);
    await assert.rejects(() => backend.rerank("q", [{ file: "a", text: "t" }]), /ollama nope.*model not found/);
  } finally {
    await mock.close();
  }
});

// =============================================================================
// Composite factory: routing, names, tokenization, device info
// =============================================================================

test("factory: all-remote → no LlamaCpp; stable api:* names; code-unit tokenize round-trip", async () => {
  const mock = await startMockServer({ "/v1/embeddings": () => ({ data: [{ embedding: [1] }] }) });
  try {
    const jobs: RemoteJobs = {
      embed: { provider: "openai-compat", baseUrl: `${mock.url}/v1`, model: "e" },
      rerank: { provider: "openai-compat", baseUrl: `${mock.url}/v1`, model: "r" },
      expand: { provider: "ollama", baseUrl: mock.url, model: "g" },
    };
    const backend = await createBackend(jobs); // real LlamaCpp import would happen if any job were local
    assert.equal(backend.embedModelName, "api:openai-compat:e");
    assert.equal(backend.rerankModelName, "api:openai-compat:r");
    assert.equal(backend.generateModelName, "api:ollama:g");

    // Lossless code-unit round-trip: ASCII + CJK + emoji (surrogate pair)
    const sample = "hello qmd 中文 🚀 naïve";
    const tokens = await backend.tokenize(sample);
    assert.equal(tokens.length, sample.length);
    assert.equal(await backend.detokenize(tokens), sample);
    assert.equal(await backend.countTokens(sample), sample.length);

    const info = await backend.getDeviceInfo();
    assert.equal(info.gpu, false);
    assert.ok(info.cpuCores >= 1);

    const exists = await backend.modelExists("api:openai-compat:e");
    assert.equal(exists.exists, true);
  } finally {
    await mock.close();
  }
});

test("factory: mixed jobs — local rerank routes to LlamaCpp, remote embed stays remote", async () => {
  const mock = await startMockServer({ "/v1/embeddings": () => ({ data: [{ embedding: [0.5] }] }) });
  try {
    const jobs: RemoteJobs = {
      embed: { provider: "openai-compat", baseUrl: `${mock.url}/v1`, model: "e" },
      rerank: { provider: "local" },
      expand: { provider: "local" },
    };
    const backend = await createBackend(jobs, { llamaCtor: FakeLlamaCpp });
    const llama = FakeLlamaCpp.instances[FakeLlamaCpp.instances.length - 1]!; // the instance the factory built
    // remote embed keeps its api: name; local jobs report the LlamaCpp names
    assert.equal(backend.embedModelName, "api:openai-compat:e");
    assert.equal(backend.rerankModelName, "fake:rerank-model");
    assert.equal(backend.generateModelName, "fake:generate-model");

    await backend.embed("doc text");
    assert.equal(mock.hits["/v1/embeddings"]!.length, 1);
    await backend.rerank("q", [{ file: "a.md", text: "t" }]);
    assert.ok(llama.calls.includes("rerank")); // rerank hit the (fake) local model
    assert.ok(!llama.calls.includes("embed")); // embed never touched it
    // local tokenizer in play (not code-units)
    assert.deepEqual(await backend.tokenize("abc"), [42]);
    await backend.dispose();
    assert.ok(llama.calls.includes("dispose"));
  } finally {
    await mock.close();
  }
});

test("factory: unknown provider rejects loudly (normalization catches it first)", async () => {
  assert.deepEqual(REMOTE_JOB_NAMES, ["embed", "rerank", "expand"]);
  const bad = { ...JOBS, embed: { provider: "bogus" } };
  await assert.rejects(createBackend(bad), /jobs\.embed\.provider must be one of/);
  const allLocal = await createBackend(JOBS, { llamaCtor: FakeLlamaCpp });
  assert.equal(allLocal.embedModelName, "fake:embed-model"); // all-local → everything routed to (fake) LlamaCpp
  await allLocal.dispose();
});
