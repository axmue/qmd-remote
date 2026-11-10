/**
 * qmd-remote — config file loading (spec D9).
 *
 * One file, one source of truth: the `jobs` block. Path: $QMD_REMOTE_CONFIG
 * if set, else $XDG_CONFIG_HOME/qmd-remote/config.json (default
 * ~/.config/qmd-remote/config.json). An absent file is NOT an error — it
 * means all-local defaults (D6: default is always local).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeJobs } from "./backend/config.js";
import type { RemoteJobs } from "./backend/types.js";

/** Remote env var overriding the config file path. */
export const QMD_REMOTE_CONFIG_ENV = "QMD_REMOTE_CONFIG";

/** Resolved config file path (may not exist — that means all-local defaults). */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[QMD_REMOTE_CONFIG_ENV]?.trim();
  if (override) return override;
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "qmd-remote", "config.json");
}

export interface RemoteConfig {
  /** normalized jobs (always complete: all three jobs present). */
  jobs: RemoteJobs;
  /** where the jobs came from: "default (all local)" or the resolved file path. */
  source: string;
}

/**
 * Load + normalize the package config from `path` (default: defaultConfigPath()).
 * Absent file → all-local defaults. Malformed file → throws, naming the path.
 */
export function loadRemoteConfig(path?: string, env: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const resolved = path ?? defaultConfigPath(env);
  if (!existsSync(resolved)) {
    return { jobs: normalizeJobs(undefined), source: "default (all local)" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf-8"));
  } catch (err) {
    throw new Error(`qmd-remote: config file ${resolved} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`qmd-remote: config file ${resolved} must contain a JSON object with a "jobs" key`);
  }
  const o = parsed as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "jobs") {
      throw new Error(`qmd-remote: config file ${resolved} has unknown top-level key "${key}" (expected: "jobs")`);
    }
  }
  return { jobs: normalizeJobs(o.jobs, "jobs (in " + resolved + ")"), source: resolved };
}
