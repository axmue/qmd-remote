/**
 * THE patch-free proof (spec D2) — and the future CI compat test (spec D11):
 * a REAL qmd store (stock createStore, unpatched) whose in-process update(),
 * embed() and search() ALL route through the injected remote backend.
 *
 * Setup: temp docs + temp index.yml + temp sqlite + loopback mock provider.
 * Zero network, zero local models (all jobs remote ⇒ the factory never
 * touches node-llama-cpp).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreRemote } from "../src/store-remote.js";
import { startMockServer } from "./helpers/mock-server.js";

const DIMS = 16;

/** Deterministic non-zero pseudo-vector (quality irrelevant: the mock rerank decides ordering). */
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

test("e2e seam proof (D2 / D11): in-process update + embed + search all route through the remote backend, no patch", async () => {
  // --- fixtures -------------------------------------------------------------
  const root = mkdtempSync(join(tmpdir(), "qmd-remote-e2e-"));
  const docsDir = join(root, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "banana.md"), "# Banana smoothie\n\nBlend 2 bananas, yogurt and honey for a banana smoothie.\n");
  writeFileSync(join(docsDir, "apple.md"), "# Apple pie\n\nApple pie recipe with a lattice crust and cinnamon.\n");
  writeFileSync(join(docsDir, "zebra.md"), "# Zebra crossings\n\nNotes on zebra crossings in city planning.\n");
  const dbPath = join(root, "index.sqlite");
  const configPath = join(root, "index.yml");
  writeFileSync(configPath, `collections:\n  e2e:\n    path: ${docsDir}\n`);

  // --- mock provider ---------------------------------------------------------
  const mock = await startMockServer({
    "/v1/embeddings": (body) => {
      const input = body.input;
      if (Array.isArray(input)) return { data: (input as string[]).map((t, i) => ({ embedding: vecFor(t), index: i })) };
      return { data: [{ embedding: vecFor(String(input)) }] };
    },
    "/v1/rerank": (body) => {
      const words = String(body.query).toLowerCase().split(/\s+/).filter(Boolean);
      const docs = (body.documents as string[]) ?? [];
      return { results: docs.map((d, i) => ({ index: i, relevance_score: words.length ? words.filter((w) => d.toLowerCase().includes(w)).length / words.length : 0 })) };
    },
    "/v1/chat/completions": () => ({ choices: [{ message: { content: "lex: banana smoothie\nvec: banana smoothie recipe" } }] }),
  });

  const store = await createStoreRemote({
    dbPath,
    configPath,
    jobs: {
      embed: { provider: "openai-compat", baseUrl: `${mock.url}/v1`, model: "mock-embed" },
      rerank: { provider: "openai-compat", baseUrl: `${mock.url}/v1`, model: "mock-rerank" },
      expand: { provider: "openai-compat", baseUrl: `${mock.url}/v1`, model: "mock-expand" },
    },
  });
  try {
    // --- WRITE PATH: update() indexes, embed() hits the mock -------------------
    const u = await store.update();
    assert.ok(u.indexed >= 3, `expected >=3 indexed, got ${JSON.stringify(u)}`);
    assert.equal(mock.hits["/v1/embeddings"]?.length ?? 0, 0, "update() must not embed (index-only step)");

    const e = await store.embed();
    assert.ok((mock.hits["/v1/embeddings"]?.length ?? 0) > 0, "WRITE PATH: embed() must route document embeddings through the remote provider");

    // --- SEARCH PATH: search() uses remote expand + embed + rerank ------------
    const results = await store.search({ query: "banana smoothie" });
    assert.ok(results.length > 0, "search returned no results");
    const top = results[0]!;
    assert.ok(top.displayPath.includes("banana") || top.file.includes("banana"), `top result should be banana.md, got ${top.displayPath}`);
    assert.ok((mock.hits["/v1/rerank"]?.length ?? 0) > 0, "SEARCH PATH: rerank must hit the remote provider");
    assert.ok((mock.hits["/v1/chat/completions"]?.length ?? 0) > 0, "SEARCH PATH: query expansion must hit the remote provider");

    // --- index health agrees (local sqlite read, no network) -------------------
    const status = await store.getStatus();
    assert.ok(status.totalDocuments >= 3, `status totalDocuments=${status.totalDocuments}`);
  } finally {
    await store.close();
    await mock.close();
  }
});
