/**
 * qmd-remote — config file loading (spec D9).
 *
 * One file, one source of truth: the `jobs` block. Path: $QMD_REMOTE_CONFIG
 * if set, else $XDG_CONFIG_HOME/qmd-remote/config.json (default
 * ~/.config/qmd-remote/config.json). An absent file is NOT an error — it
 * means all-local defaults (D6: default is always local).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeJobs } from "./backend/config.js";
import { isSecretReference } from "./backend/secrets.js";
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
  const jobs = normalizeJobs(o.jobs, "jobs (in " + resolved + ")");
  warnOnLooseFileMode(resolved, o.jobs);
  return { jobs, source: resolved };
}

/**
 * A literal provider key in a group/world-readable file is the most common way
 * these credentials leak. We do not refuse to run (that would strand users
 * mid-task) but we say it once, on stderr, and only when the file actually
 * holds a literal secret (`env:`/`file:` indirections are fine).
 */
function warnOnLooseFileMode(path: string, rawJobs: unknown): void {
  if (process.platform === "win32") return;
  if (!containsLiteralSecret(rawJobs)) return;
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return;
  }
  if ((mode & 0o077) === 0) return;
  console.error(
    `qmd-remote: WARNING ${path} contains a literal apiKey and is readable by others (mode ${(mode & 0o777).toString(8)}) — ` +
      `run 'chmod 600 ${path}', or use an "env:YOUR_VAR" / "file:/path/to/secret" apiKey instead`,
  );
}

function containsLiteralSecret(rawJobs: unknown): boolean {
  if (typeof rawJobs !== "object" || rawJobs === null) return false;
  return Object.values(rawJobs as Record<string, unknown>).some((job) => {
    if (typeof job !== "object" || job === null) return false;
    const key = (job as { apiKey?: unknown }).apiKey;
    return typeof key === "string" && !isSecretReference(key);
  });
}
