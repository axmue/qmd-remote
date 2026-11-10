/**
 * qmd-remote — `jobs` config normalization + validation.
 *
 * One JSON shape, one normalizer: the package's config file (P2) and any
 * SDK caller pass `jobs` through `normalizeJobs` before the factory sees it.
 * Malformation throws — a misconfigured remote job must fail loudly, never
 * silently fall back to local models.
 */
import type { RemoteJobConfig, RemoteJobs, RemoteProvider } from "./types.js";

/** All-local jobs — qmd's exact upstream behavior (default is always local). */
export const DEFAULT_REMOTE_JOBS: RemoteJobs = {
  embed: { provider: "local" },
  rerank: { provider: "local" },
  expand: { provider: "local" },
};

export const REMOTE_JOB_NAMES: (keyof RemoteJobs)[] = ["embed", "rerank", "expand"];
const PROVIDERS: RemoteProvider[] = ["local", "openai-compat", "ollama"];

/** Allowed keys per job (unknown keys are a configuration error, not a typo to swallow). */
const JOB_FIELDS = new Set([
  "provider",
  "model",
  "baseUrl",
  "apiKey",
  "timeoutMs",
  "headers",
  "embedQueryPrefix",
  "embedDocPrefix",
  "rerankMaxChars",
  "expandMaxTokens",
]);

/**
 * Validate + normalize a `jobs` block (absent/null input → all-local
 * defaults). Throws on any malformation with a message that names the exact
 * path (e.g. `jobs.embed.baseUrl`).
 */
export function normalizeJobs(raw: unknown, blockName = "jobs"): RemoteJobs {
  if (raw === undefined || raw === null) {
    return cloneJobs(DEFAULT_REMOTE_JOBS);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config: ${blockName} must be an object { embed?, rerank?, expand? }`);
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!REMOTE_JOB_NAMES.includes(key as keyof RemoteJobs)) {
      throw new Error(`config: ${blockName} has unknown key "${key}" (expected: ${REMOTE_JOB_NAMES.join(", ")})`);
    }
  }
  return {
    embed: normalizeJob(o.embed, `${blockName}.embed`),
    rerank: normalizeJob(o.rerank, `${blockName}.rerank`),
    expand: normalizeJob(o.expand, `${blockName}.expand`),
  };
}

function cloneJobs(jobs: RemoteJobs): RemoteJobs {
  return { embed: { ...jobs.embed }, rerank: { ...jobs.rerank }, expand: { ...jobs.expand } };
}

function normalizeJob(raw: unknown, what: string): RemoteJobConfig {
  if (raw === undefined || raw === null) return { provider: "local" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config: ${what} must be an object with a "provider"`);
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!JOB_FIELDS.has(key)) {
      throw new Error(`config: ${what} has unknown key "${key}" (expected: ${[...JOB_FIELDS].join(", ")})`);
    }
  }
  const provider = o.provider;
  if (typeof provider !== "string" || !PROVIDERS.includes(provider as RemoteProvider)) {
    throw new Error(`config: ${what}.provider must be one of: ${PROVIDERS.join(", ")}`);
  }

  const job: RemoteJobConfig = { provider: provider as RemoteProvider };

  if (o.model !== undefined) {
    if (typeof o.model !== "string" || o.model.trim() === "") throw new Error(`config: ${what}.model must be a non-empty string`);
    job.model = o.model;
  }
  if (o.baseUrl !== undefined) {
    if (typeof o.baseUrl !== "string" || o.baseUrl.trim() === "") throw new Error(`config: ${what}.baseUrl must be a non-empty URL`);
    if (!isValidHttpUrl(o.baseUrl)) throw new Error(`config: ${what}.baseUrl must be an http(s) URL`);
    job.baseUrl = o.baseUrl;
  }
  if (o.apiKey !== undefined) {
    if (typeof o.apiKey !== "string" || o.apiKey.trim() === "") throw new Error(`config: ${what}.apiKey must be a non-empty string`);
    job.apiKey = o.apiKey;
  }
  if (o.timeoutMs !== undefined) {
    if (!Number.isFinite(o.timeoutMs) || (o.timeoutMs as number) < 1_000) {
      throw new Error(`config: ${what}.timeoutMs must be a number >= 1000 (ms)`);
    }
    job.timeoutMs = o.timeoutMs as number;
  }
  if (o.headers !== undefined) {
    if (typeof o.headers !== "object" || o.headers === null || Array.isArray(o.headers)) {
      throw new Error(`config: ${what}.headers must be an object of header name → value`);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.headers)) {
      if (typeof v !== "string") throw new Error(`config: ${what}.headers["${k}"] must be a string`);
      headers[k] = v;
    }
    job.headers = headers;
  }
  for (const f of ["embedQueryPrefix", "embedDocPrefix", "rerankMaxChars", "expandMaxTokens"] as const) {
    const v = o[f];
    if (v === undefined) continue;
    if (f === "rerankMaxChars" || f === "expandMaxTokens") {
      if (!Number.isFinite(v) || (v as number) < 1) throw new Error(`config: ${what}.${f} must be a number >= 1`);
      job[f] = v as number;
    } else {
      if (typeof v !== "string") throw new Error(`config: ${what}.${f} must be a string`);
      job[f] = v;
    }
  }

  if (job.provider !== "local") {
    if (!job.model || job.model.trim() === "") {
      throw new Error(`config: ${what} with provider "${job.provider}" requires a "model"`);
    }
    if (job.provider === "openai-compat" && !job.baseUrl) {
      throw new Error(`config: ${what} with provider "openai-compat" requires a "baseUrl" (e.g. "https://api.jina.ai/v1")`);
    }
  } else {
    // A local job is served by qmd's bundled GGUF models — the remote fields
    // are DEAD for provider "local" (the factory makes no adapter for it).
    // Strip them so the normalized config never carries the misleading shape
    // "local job with remote fields" (they were silently ignored anyway).
    // Validation above still runs, so a malformed value fails loudly.
    delete job.model;
    delete job.baseUrl;
    delete job.apiKey;
    delete job.headers;
  }
  return job;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
