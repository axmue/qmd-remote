/**
 * normalizeJobs — validation + normalization (port of the qmdKb-block
 * semantics from axel-agent's config tests, standalone).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REMOTE_JOBS, normalizeJobs } from "../src/backend/config.js";

test("absent input → all-local defaults", () => {
  for (const raw of [undefined, null]) {
    const jobs = normalizeJobs(raw);
    assert.equal(jobs.embed.provider, "local");
    assert.equal(jobs.rerank.provider, "local");
    assert.equal(jobs.expand.provider, "local");
  }
});

test("partial jobs block → missing jobs default to local", () => {
  const jobs = normalizeJobs({
    embed: { provider: "openai-compat", baseUrl: "https://api.jina.ai/v1", model: "jina-embeddings-v3", apiKey: "k" },
    rerank: { provider: "ollama", model: "nomic-embed" },
  });
  assert.equal(jobs.embed.model, "jina-embeddings-v3");
  assert.equal(jobs.embed.apiKey, "k");
  assert.equal(jobs.rerank.provider, "ollama");
  assert.equal(jobs.expand.provider, "local"); // the unlisted job
});

test("job defaults + passthrough fields", () => {
  const jobs = normalizeJobs({
    embed: { provider: "openai-compat", baseUrl: "https://x.dev/v1", model: "m", headers: { "X-Title": "t" }, timeoutMs: 12_000, embedQueryPrefix: "query:" },
  });
  assert.deepEqual(jobs.embed.headers, { "X-Title": "t" });
  assert.equal(jobs.embed.timeoutMs, 12_000);
  assert.equal(jobs.embed.embedQueryPrefix, "query:");
  // numeric-typed optionals
  const jobs2 = normalizeJobs({ rerank: { provider: "openai-compat", baseUrl: "https://x.dev/v1", model: "m", rerankMaxChars: 100, expandMaxTokens: 50 } });
  assert.equal(jobs2.rerank.rerankMaxChars, 100);
  assert.equal(jobs2.rerank.expandMaxTokens, 50);
});

test("DEFAULT_REMOTE_JOBS is not mutated by normalization", () => {
  const a = normalizeJobs(undefined);
  a.embed.provider = "ollama";
  assert.equal(DEFAULT_REMOTE_JOBS.embed.provider, "local");
});

test("malformations throw, naming the exact path", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ embed: { provider: "telepathy" } }, /jobs\.embed\.provider must be one of: local, openai-compat, ollama/],
    [{ embed: { provider: 5 } }, /jobs\.embed\.provider must be one of/],
    [{ embed: "local" }, /jobs\.embed must be an object/],
    [{ embed: { provider: "openai-compat", model: "m" } }, /jobs\.embed with provider "openai-compat" requires a "baseUrl"/],
    [{ embed: { provider: "openai-compat", baseUrl: "ftp://x", model: "m" } }, /jobs\.embed\.baseUrl must be an http\(s\) URL/],
    [{ embed: { provider: "openai-compat", baseUrl: "https://x.dev/v1" } }, /jobs\.embed with provider "openai-compat" requires a "model"/],
    [{ rerank: { provider: "ollama" } }, /jobs\.rerank with provider "ollama" requires a "model"/],
    [{ embed: { provider: "local", timeoutMs: 10 } }, /jobs\.embed\.timeoutMs must be a number >= 1000/],
    [{ embed: { provider: "local", headers: { a: 1 } } }, /jobs\.embed\.headers\["a"\] must be a string/],
    [{ embed: { provider: "local", rerankMaxChars: 0 } }, /jobs\.embed\.rerankMaxChars must be a number >= 1/],
    [{ embed: { provider: "local", model: "" } }, /jobs\.embed\.model must be a non-empty string/],
    ["nope", /jobs must be an object/],
    [[{ embed: {} }], /jobs must be an object/],
    [{ embed: {}, bogus: 1 }, /jobs has unknown key "bogus"/],
    [{ embed: { provider: "local", secret: "x" } }, /jobs\.embed has unknown key "secret"/],
  ];
  for (const [raw, re] of cases) {
    assert.throws(() => normalizeJobs(raw), re, `expected throw for ${JSON.stringify(raw)}`);
  }
});

test("local job with remote fields → fields stripped, no silent shape", () => {
  const jobs = normalizeJobs({
    embed: { provider: "local", model: "leftover.gguf", baseUrl: "https://x.dev/v1", apiKey: "k", headers: { a: "b" } },
  });
  assert.deepEqual(jobs.embed, { provider: "local" });
});
