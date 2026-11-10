/**
 * qmd-remote — secret resolution + redaction.
 *
 * A config file is a plain JSON file on disk; writing a provider key into it
 * is the path of least resistance and the worst option (it gets committed,
 * synced, and copied into agent configs). So `apiKey` accepts three forms:
 *
 *   "sk-or-v1-…"              literal (works, warned about on loose file modes)
 *   "env:OPENROUTER_API_KEY"  read from the environment at load time
 *   "file:~/.secrets/jina"    read from a file (first line, trimmed)
 *
 * Resolution happens during config normalization, so a missing env var or an
 * unreadable secret file fails loudly at startup — never as a 401 in the
 * middle of a 30-minute embed run.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** True for values that are an indirection rather than the secret itself. */
export function isSecretReference(value: string): boolean {
  return value.startsWith("env:") || value.startsWith("file:");
}

/**
 * Resolve an `apiKey` value. `what` is the config path (e.g. `jobs.embed.apiKey`)
 * and is named in every error.
 */
export function resolveSecret(value: string, what: string, env: NodeJS.ProcessEnv = process.env): string {
  if (value.startsWith("env:")) {
    const name = value.slice(4).trim();
    if (!name) throw new Error(`config: ${what} is "env:" without a variable name`);
    const resolved = env[name];
    if (resolved === undefined || resolved.trim() === "") {
      throw new Error(`config: ${what} refers to environment variable "${name}", which is not set (or empty)`);
    }
    return resolved.trim();
  }
  if (value.startsWith("file:")) {
    const raw = value.slice(5).trim();
    if (!raw) throw new Error(`config: ${what} is "file:" without a path`);
    const path = raw.startsWith("~/") ? join(env.HOME || env.USERPROFILE || homedir(), raw.slice(2)) : raw;
    let contents: string;
    try {
      contents = readFileSync(path, "utf-8");
    } catch (err) {
      throw new Error(`config: ${what} cannot read secret file ${path}: ${err instanceof Error ? err.message : err}`);
    }
    const secret = contents.split("\n", 1)[0]!.trim();
    if (secret === "") throw new Error(`config: ${what} secret file ${path} is empty`);
    return secret;
  }
  return value;
}

const BEARER_RE = /\b(Bearer|Basic)\s+[\w\-._~+/=]+/gi;
const KEYISH_RE = /\b(sk|sk-or-v1|sk-ant|jina|hf|gsk)[-_][A-Za-z0-9\-._]{8,}/g;
const JSON_KEY_RE = /("(?:api_?key|authorization|token|secret)"\s*:\s*")[^"]+(")/gi;

/**
 * Scrub credential-looking substrings from text that is about to be printed.
 * Provider error bodies are echoed to the user (that is the point of fail-loud
 * errors) and some gateways echo the request — including its Authorization
 * header — back in a 4xx payload.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ***`)
    .replace(JSON_KEY_RE, (_m, head: string, tail: string) => `${head}***${tail}`)
    .replace(KEYISH_RE, (m) => `${m.slice(0, 6)}***`);
}
