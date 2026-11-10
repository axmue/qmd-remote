/**
 * Secret resolution (`env:` / `file:` apiKey indirection) + redaction of
 * credential-looking text in printed errors.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSecretReference, redactSecrets, resolveSecret } from "../src/backend/secrets.js";
import { normalizeJobs } from "../src/backend/config.js";

test("resolveSecret: literal values pass through", () => {
  assert.equal(resolveSecret("sk-literal", "jobs.embed.apiKey", {}), "sk-literal");
  assert.equal(isSecretReference("sk-literal"), false);
  assert.equal(isSecretReference("env:X"), true);
  assert.equal(isSecretReference("file:/x"), true);
});

test("resolveSecret: env: reads the environment, loudly when unset", () => {
  assert.equal(resolveSecret("env:MY_KEY", "jobs.embed.apiKey", { MY_KEY: " sk-from-env " }), "sk-from-env");
  assert.throws(() => resolveSecret("env:MISSING", "jobs.embed.apiKey", {}), /jobs\.embed\.apiKey.*"MISSING".*not set/);
  assert.throws(() => resolveSecret("env:EMPTY", "jobs.embed.apiKey", { EMPTY: "  " }), /not set/);
  assert.throws(() => resolveSecret("env:", "jobs.embed.apiKey", {}), /without a variable name/);
});

test("resolveSecret: file: reads the first line, loudly when unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "qmd-remote-secret-"));
  const path = join(dir, "key");
  writeFileSync(path, "sk-from-file\nignored second line\n");
  assert.equal(resolveSecret(`file:${path}`, "jobs.embed.apiKey"), "sk-from-file");

  const empty = join(dir, "empty");
  writeFileSync(empty, "\n");
  assert.throws(() => resolveSecret(`file:${empty}`, "jobs.embed.apiKey"), /is empty/);
  assert.throws(() => resolveSecret(`file:${join(dir, "nope")}`, "jobs.embed.apiKey"), /cannot read secret file/);
  assert.throws(() => resolveSecret("file:", "jobs.embed.apiKey"), /without a path/);

  // "~/" expands against HOME
  writeFileSync(join(dir, "home-key"), "sk-home\n");
  assert.equal(resolveSecret("file:~/home-key", "jobs.embed.apiKey", { HOME: dir }), "sk-home");
});

test("normalizeJobs resolves apiKey indirections at load time", () => {
  process.env.QMD_TEST_KEY = "resolved-key";
  const jobs = normalizeJobs(
    { embed: { provider: "openai-compat", baseUrl: "https://api.jina.ai/v1", model: "m", apiKey: "env:QMD_TEST_KEY" } },
    "jobs",
  );
  assert.equal(jobs.embed.apiKey, "resolved-key");
  delete process.env.QMD_TEST_KEY;
});

test("normalizeJobs: unresolvable apiKey fails with the config path", () => {
  assert.throws(
    () => normalizeJobs({ embed: { provider: "ollama", model: "m", apiKey: "env:QMD_TEST_ABSENT" } }),
    /jobs\.embed\.apiKey.*QMD_TEST_ABSENT/,
  );
});

test("normalizeJobs: maxRetries is validated", () => {
  assert.equal(normalizeJobs({ embed: { provider: "ollama", model: "m", maxRetries: 0 } }).embed.maxRetries, 0);
  assert.throws(() => normalizeJobs({ embed: { provider: "ollama", model: "m", maxRetries: -1 } }), /maxRetries must be an integer/);
  assert.throws(() => normalizeJobs({ embed: { provider: "ollama", model: "m", maxRetries: 99 } }), /maxRetries must be an integer/);
});

test("redactSecrets: scrubs bearer tokens, key-ish strings and JSON credential fields", () => {
  assert.equal(redactSecrets("Authorization: Bearer sk-or-v1-abcdef123456"), "Authorization: Bearer ***");
  assert.equal(redactSecrets('{"api_key":"sk-12345678","model":"m"}'), '{"api_key":"***","model":"m"}');
  assert.match(redactSecrets("key sk-abcdefgh12345 leaked"), /sk-abc\*\*\*/);
  assert.equal(redactSecrets("no secrets here"), "no secrets here");
});
