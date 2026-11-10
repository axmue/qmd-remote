/**
 * createStoreRemote — the patch-free seam (spec D2/D10): the backend lands in
 * store.internal.llm BEFORE any call; searchVector re-wired; close() disposes
 * the backend; stock config/db path defaults.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreRemote } from "../src/store-remote.js";
import { FakeLlamaCpp } from "./helpers/fake-llamacpp.js";
import type { QmdLlmBackend } from "../src/backend/types.js";

const ALL_LOCAL = { embed: { provider: "local" }, rerank: { provider: "local" }, expand: { provider: "local" } };

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "qmd-remote-store-")), "index.sqlite");
}

function seamLlm(store: Awaited<ReturnType<typeof createStoreRemote>>): QmdLlmBackend | undefined {
  return (store.internal as unknown as { llm?: QmdLlmBackend }).llm;
}

test("store is a qmd store and the backend sits in the seam before any call", async () => {
  const store = await createStoreRemote({ dbPath: tempDb(), jobs: ALL_LOCAL, configPath: null, llamaCtor: FakeLlamaCpp });
  try {
    for (const m of ["search", "searchLex", "searchVector", "update", "embed", "get", "multiGet", "getStatus", "listCollections", "close"]) {
      assert.equal(typeof (store as unknown as Record<string, unknown>)[m], "function", `store.${m} missing`);
    }
    const llm = seamLlm(store);
    assert.ok(llm, "internal.llm not set");
    assert.equal(llm!.embedModelName, "fake:embed-model"); // OUR backend, not the pre-swap LlamaCpp
  } finally {
    await store.close();
  }
});

test("searchVector is re-wired to the backend's embedModelName", async () => {
  const store = await createStoreRemote({ dbPath: tempDb(), jobs: ALL_LOCAL, configPath: null, llamaCtor: FakeLlamaCpp });
  try {
    const rec: unknown[] = [];
    const internal = store.internal as unknown as { searchVec: (...args: unknown[]) => Promise<unknown[]> };
    const original = internal.searchVec;
    internal.searchVec = async (...args: unknown[]) => {
      rec.push(...args);
      return [];
    };
    try {
      await store.searchVector("anything", { limit: 7 });
    } finally {
      internal.searchVec = original;
    }
    assert.equal(rec[0], "anything");
    assert.equal(rec[1], "fake:embed-model", "searchVector must name the BACKEND's embed model");
    assert.equal(rec[2], 7);
  } finally {
    await store.close();
  }
});

test("close() disposes the backend AND the store", async () => {
  const store = await createStoreRemote({ dbPath: tempDb(), jobs: ALL_LOCAL, configPath: null, llamaCtor: FakeLlamaCpp });
  assert.ok(seamLlm(store), "backend not in seam");
  const fake = FakeLlamaCpp.instances[FakeLlamaCpp.instances.length - 1]!; // the instance INSIDE our backend
  await store.close();
  assert.ok(fake.calls.includes("dispose"), "backend not disposed on close");
});

test("default configPath: stock qmd yaml is picked up; null forces DB-only", async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), "qmd-remote-cfgdir-"));
  writeFileSync(
    join(cfgDir, "index.yml"),
    "collections:\n  testcol:\n    path: /tmp/qmd-remote-testcol\n",
  );
  const saved = process.env.QMD_CONFIG_DIR;
  process.env.QMD_CONFIG_DIR = cfgDir;
  try {
    // auto default: yaml exists → its collections sync into the store
    const store = await createStoreRemote({ dbPath: tempDb(), jobs: ALL_LOCAL, llamaCtor: FakeLlamaCpp });
    try {
      const cols = await store.listCollections();
      assert.ok(cols.some((c) => c.name === "testcol"), `expected testcol in ${JSON.stringify(cols)}`);
    } finally {
      await store.close();
    }
    // forced DB-only: fresh db, no collections
    const store2 = await createStoreRemote({ dbPath: tempDb(), jobs: ALL_LOCAL, configPath: null, llamaCtor: FakeLlamaCpp });
    try {
      assert.equal((await store2.listCollections()).length, 0);
    } finally {
      await store2.close();
    }
    // auto default with NO yaml present → DB-only, no crash
    process.env.QMD_CONFIG_DIR = mkdtempSync(join(tmpdir(), "qmd-remote-empty-"));
    const store3 = await createStoreRemote({ dbPath: tempDb(), jobs: ALL_LOCAL, llamaCtor: FakeLlamaCpp });
    try {
      assert.equal((await store3.listCollections()).length, 0);
    } finally {
      await store3.close();
    }
  } finally {
    if (saved === undefined) delete process.env.QMD_CONFIG_DIR;
    else process.env.QMD_CONFIG_DIR = saved;
  }
});
