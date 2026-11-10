/**
 * Retry semantics for provider HTTP (review §5.1): metered providers
 * rate-limit long embed runs, so 429/5xx/network get another attempt while
 * auth/bad-request failures stay fast and loud.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackend } from "../src/backend/factory.js";
import type { RemoteJobs } from "../src/backend/types.js";
import { startMockServer } from "./helpers/mock-server.js";

const localJobs: Pick<RemoteJobs, "rerank" | "expand"> = { rerank: { provider: "local" }, expand: { provider: "local" } };

function embedJobs(url: string, extra: Record<string, unknown> = {}): RemoteJobs {
  return {
    ...localJobs,
    embed: { provider: "openai-compat", baseUrl: `${url}/v1`, model: "mock-embed", ...extra },
  } as RemoteJobs;
}

test("429 with Retry-After is retried and then succeeds", async () => {
  let calls = 0;
  const mock = await startMockServer({
    "/v1/embeddings": () => {
      calls += 1;
      if (calls <= 2) return { _status: 429, _headers: { "retry-after": "0" }, error: "slow down" };
      return { data: [{ embedding: [1, 2, 3] }] };
    },
  });
  try {
    const backend = await createBackend(embedJobs(mock.url), { llamaCtor: class {} as never });
    const r = await backend.embed("hello");
    assert.deepEqual(r?.embedding, [1, 2, 3]);
    assert.equal(calls, 3, "two 429s then success = three attempts");
  } finally {
    await mock.close();
  }
});

test("retries are exhausted → throws, naming the job, provider, URL and status", async () => {
  const mock = await startMockServer({
    "/v1/embeddings": () => ({ _status: 503, _headers: { "retry-after": "0" }, error: "upstream down" }),
  });
  try {
    const backend = await createBackend(embedJobs(mock.url, { maxRetries: 1 }), { llamaCtor: class {} as never });
    await assert.rejects(backend.embed("hello"), (err: Error) => {
      assert.match(err.message, /embed \(openai-compat mock-embed\)/);
      assert.match(err.message, /\/v1\/embeddings/);
      assert.match(err.message, /HTTP 503/);
      assert.match(err.message, /after 2 attempts/);
      return true;
    });
  } finally {
    await mock.close();
  }
});

test("4xx (auth/bad request) is NOT retried — configuration errors fail fast", async () => {
  let calls = 0;
  const mock = await startMockServer({
    "/v1/embeddings": () => {
      calls += 1;
      return { _status: 401, error: "bad key" };
    },
  });
  try {
    const backend = await createBackend(embedJobs(mock.url), { llamaCtor: class {} as never });
    await assert.rejects(backend.embed("hello"), /HTTP 401/);
    assert.equal(calls, 1, "401 must not be retried");
  } finally {
    await mock.close();
  }
});

test("maxRetries: 0 disables retries for retryable statuses too", async () => {
  let calls = 0;
  const mock = await startMockServer({
    "/v1/embeddings": () => {
      calls += 1;
      return { _status: 429, error: "slow down" };
    },
  });
  try {
    const backend = await createBackend(embedJobs(mock.url, { maxRetries: 0 }), { llamaCtor: class {} as never });
    await assert.rejects(backend.embed("hello"), /HTTP 429/);
    assert.equal(calls, 1);
  } finally {
    await mock.close();
  }
});

test("error details are redacted (gateways that echo the Authorization header)", async () => {
  const mock = await startMockServer({
    "/v1/embeddings": () => ({ _status: 400, error: 'bad request: headers={"authorization":"Bearer sk-or-v1-supersecret"}' }),
  });
  try {
    const backend = await createBackend(embedJobs(mock.url, { apiKey: "sk-or-v1-supersecret" }), { llamaCtor: class {} as never });
    await assert.rejects(backend.embed("hello"), (err: Error) => {
      assert.doesNotMatch(err.message, /supersecret/, "the key must never reach the user's terminal or logs");
      assert.match(err.message, /HTTP 400/);
      return true;
    });
  } finally {
    await mock.close();
  }
});
