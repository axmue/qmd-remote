/**
 * Config file loading (spec D9): path resolution, absent-file default, malformation errors.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QMD_REMOTE_CONFIG_ENV, defaultConfigPath, loadRemoteConfig } from "../src/config-file.js";

const ENV_KEYS = [QMD_REMOTE_CONFIG_ENV, "XDG_CONFIG_HOME"] as const;

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function tempConfigFile(content: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "qmd-remote-cfg-")), "config.json");
  writeFileSync(file, content);
  return file;
}

test("defaultConfigPath: env override wins, else XDG_CONFIG_HOME, else ~/.config", () => {
  withEnv({ [QMD_REMOTE_CONFIG_ENV]: "/tmp/override.json", XDG_CONFIG_HOME: "/xdg" }, () =>
    assert.equal(defaultConfigPath(), "/tmp/override.json"),
  );
  withEnv({ [QMD_REMOTE_CONFIG_ENV]: undefined, XDG_CONFIG_HOME: "/xdg" }, () =>
    assert.equal(defaultConfigPath(), join("/xdg", "qmd-remote", "config.json")),
  );
});

test("absent file → all-local defaults, source says so", () => {
  const cfg = loadRemoteConfig(join(tmpdir(), "does-not-exist-qmd-remote.json"));
  for (const job of Object.values(cfg.jobs)) assert.equal(job.provider, "local");
  assert.equal(cfg.source, "default (all local)");
});

test("valid file → normalized jobs, source is the path", () => {
  const file = tempConfigFile(
    JSON.stringify({ jobs: { embed: { provider: "openai-compat", baseUrl: "https://api.example.com/v1", model: "m" } } }),
  );
  const cfg = loadRemoteConfig(file);
  assert.equal(cfg.jobs.embed.model, "m");
  assert.equal(cfg.jobs.rerank.provider, "local"); // unlisted → local default
  assert.equal(cfg.source, file);
});

test("malformations throw, naming the path", () => {
  const badJson = tempConfigFile("{ nope");
  assert.throws(() => loadRemoteConfig(badJson), badJson + " is not valid JSON");

  const topArray = tempConfigFile("[]");
  assert.throws(() => loadRemoteConfig(topArray), /must contain a JSON object/);

  const unknownKey = tempConfigFile(JSON.stringify({ jobz: {} }));
  assert.throws(() => loadRemoteConfig(unknownKey), /unknown top-level key "jobz"/);

  const badJob = tempConfigFile(JSON.stringify({ jobs: { embed: { provider: "telepathy" } } }));
  assert.throws(() => loadRemoteConfig(badJob), /embed\.provider must be one of/);
});
