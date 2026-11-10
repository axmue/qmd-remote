/**
 * qmd-remote CLI (spec D7/D8) — the thin front door.
 *
 * Commands: update / embed / query / status / doctor / collections
 * Fail-loud (D7): provider/config errors → stderr + exit 1 (never a silent
 * local fallback); usage errors → exit 2. No colors, greppable plain text,
 * `--json` for machine output where it makes sense.
 */
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { SearchOptions } from "@tobilu/qmd";
import { loadRemoteConfig } from "./config-file.js";
import { createBackend } from "./backend/factory.js";
import { createStoreRemote, defaultQmdDbPath, defaultQmdConfigPath } from "./store-remote.js";
import { createQmdRemoteMcpServer, InflightGate } from "./mcp.js";
import { EXPAND_PROMPT, parseExpansion } from "./backend/adapters/shared.js";
import { redactSecrets } from "./backend/secrets.js";
import { packageVersion } from "./version.js";
import type { QmdStore } from "./store-remote.js";
import type { RemoteJobs } from "./backend/types.js";

const USAGE = `qmd-remote — qmd with remote models (embed / rerank / expand)

Usage: qmd-remote <command> [options]

Commands:
  update      [-c <col> ...]                    index the collections (no embeddings)
  embed       [-c <col>] [--force]              embed what update left, via the configured providers
  query       <text> [-c <col>] [-n <n>]        hybrid search (remote expand + embed + rerank)
              [--no-rerank] [--lex-only]
  status      [index counts; offline]
  doctor      [config check + live probe of every remote job]
  mcp         [serve the MCP server over stdio — for agent configs]
  collections list | add <name> <path> [--pattern <glob>] | remove <name>

Options:
  -d, --db <path>     index.sqlite (default: stock qmd location, or .qmd/index.sqlite)
      --config <path> index.yml   (default: stock qmd location, or .qmd/index.yml)
      --jobs <path>   models config JSON (default: $QMD_REMOTE_CONFIG or ~/.config/qmd-remote/config.json)
      --json          machine-readable output (status, collections, doctor, query)
  -h, --help          usage
  -V, --version       print the version

Use \`--\` to end option parsing: qmd-remote query -- -not-an-option
Config: $QMD_REMOTE_CONFIG or ~/.config/qmd-remote/config.json — see README.`;

interface Parsed {
  positionals: string[];
  collections: string[];
  db?: string;
  config?: string;
  /** path to the models (jobs) config file — --jobs, overrides $QMD_REMOTE_CONFIG. */
  jobs?: string;
  json: boolean;
  force: boolean;
  noRerank: boolean;
  lexOnly: boolean;
  limit?: number;
  pattern?: string;
  help: boolean;
  version: boolean;
  /** canonical names of the options actually given (for per-command validation). */
  seen: Set<string>;
}

const VALUE_FLAGS = new Map<string, string>([
  ["-d", "db"],
  ["--db", "db"],
  ["--config", "config"],
  ["--jobs", "jobs"],
  ["-n", "limit"],
  ["--limit", "limit"],
  ["-c", "collection"],
  ["--collection", "collection"],
  ["--pattern", "pattern"],
]);
const BOOL_FLAGS = new Map<string, string>([
  ["--json", "json"],
  ["--force", "force"],
  ["--no-rerank", "no-rerank"],
  ["--lex-only", "lex-only"],
]);

/**
 * Which options each command accepts. A flag that a command ignores is a
 * silent lie (`status --force` used to be accepted and discarded), so the
 * table is enforced — unknown-for-this-command is a usage error.
 */
const COMMAND_FLAGS: Record<string, string[]> = {
  update: ["db", "config", "jobs", "json", "collection"],
  embed: ["db", "config", "jobs", "json", "collection", "force"],
  query: ["db", "config", "jobs", "json", "collection", "limit", "no-rerank", "lex-only"],
  status: ["db", "config", "jobs", "json"],
  doctor: ["db", "config", "jobs", "json"],
  mcp: ["db", "config", "jobs"],
  collections: ["db", "config", "jobs", "json", "pattern"],
};

function parseArgs(argv: string[]): Parsed {
  const p: Parsed = { positionals: [], collections: [], json: false, force: false, noRerank: false, lexOnly: false, help: false, version: false, seen: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      // everything after `--` is literal (search text starting with "-", …)
      p.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") {
      p.help = true;
      continue;
    }
    if (a === "-V" || a === "--version") {
      p.version = true;
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      let key = a;
      let inlineValue: string | undefined;
      const eq = a.indexOf("=");
      if (a.startsWith("--") && eq !== -1) {
        key = a.slice(0, eq);
        inlineValue = a.slice(eq + 1);
      }
      const boolName = BOOL_FLAGS.get(key);
      const valueName = VALUE_FLAGS.get(key);
      if (!boolName && !valueName) {
        throw new UsageError(`unknown option: ${a}`);
      }
      if (boolName) {
        if (inlineValue !== undefined) throw new UsageError(`option ${key} takes no value`);
        p.seen.add(boolName);
        if (boolName === "json") p.json = true;
        else if (boolName === "force") p.force = true;
        else if (boolName === "no-rerank") p.noRerank = true;
        else if (boolName === "lex-only") p.lexOnly = true;
        continue;
      }
      const value = inlineValue ?? argv[++i];
      if (value === undefined) throw new UsageError(`option ${key} needs a value`);
      p.seen.add(valueName!);
      if (key === "-d" || key === "--db") p.db = value;
      else if (key === "--config") p.config = value;
      else if (key === "--jobs") p.jobs = value;
      else if (key === "-n" || key === "--limit") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new UsageError(`option -n needs a positive integer, got "${value}"`);
        p.limit = n;
      } else if (key === "-c" || key === "--collection") p.collections.push(value);
      else if (key === "--pattern") p.pattern = value;
    } else {
      p.positionals.push(a);
    }
  }
  return p;
}

export class UsageError extends Error {}

/** Reject options the command does not use (rather than silently ignoring them). */
function validateFlags(command: string, p: Parsed): void {
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) return;
  for (const name of p.seen) {
    if (!allowed.includes(name)) {
      throw new UsageError(`option --${name} is not valid for '${command}' (accepts: ${allowed.map((f) => `--${f}`).join(", ")})`);
    }
  }
}

async function openStore(p: Parsed): Promise<QmdStore> {
  const cfg = loadRemoteConfig(p.jobs);
  return createStoreRemote({ dbPath: p.db, configPath: p.config, jobs: cfg.jobs });
}

function collectionFilter(p: Parsed): string[] | undefined {
  return p.collections.length > 0 ? p.collections : undefined;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdStatus(p: Parsed): Promise<number> {
  const store = await openStore(p);
  try {
    const s = await store.getStatus();
    if (p.json) {
      console.log(JSON.stringify(s, null, 2));
      return 0;
    }
    console.log(`Documents:  ${s.totalDocuments}`);
    console.log(`Awaiting embedding: ${s.needsEmbedding}`);
    console.log(`Vector index: ${s.hasVectorIndex ? "yes" : "no"}`);
    const cols = await store.listCollections();
    if (cols.length > 0) {
      console.log("Collections:");
      for (const c of cols) console.log(`  ${c.name}\t${c.pwd}\t${c.doc_count} docs`);
    } else {
      console.log("Collections: (none — use 'qmd-remote collections add <name> <path>')");
    }
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdUpdate(p: Parsed): Promise<number> {
  const store = await openStore(p);
  try {
    const cols = await store.listCollections();
    if (cols.length === 0) {
      console.log("No collections configured — nothing to index. Use 'qmd-remote collections add <name> <path>'.");
      return 0;
    }
    const r = await store.update({ collections: collectionFilter(p) });
    if (p.json) {
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    console.log(`Indexed: ${r.indexed}  Updated: ${r.updated}  Unchanged: ${r.unchanged}  Removed: ${r.removed}`);
    if (r.needsEmbedding > 0) console.log(`Awaiting embedding: ${r.needsEmbedding} — run 'qmd-remote embed'`);
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdEmbed(p: Parsed): Promise<number> {
  if (p.collections.length > 1) throw new UsageError("embed accepts at most one -c <col>");
  const store = await openStore(p);
  try {
    // Progress goes to stderr; on a TTY it rewrites one line, in a pipe/log it
    // is throttled to whole lines (no stray carriage returns in log files).
    const isTty = process.stderr.isTTY === true;
    const width = (process.stderr.columns ?? 80) - 1;
    let wrote = false;
    let lastPrint = 0;
    const r = await store.embed({
      collection: p.collections[0],
      force: p.force || undefined,
      onProgress: (info) => {
        const text = `Embedding… ${info.chunksEmbedded}/${info.totalChunks} chunks` + (info.errors > 0 ? ` (${info.errors} errors)` : "");
        if (isTty) {
          const line = text.length > width ? text.slice(0, width - 1) + "…" : text;
          process.stderr.write(`\r${line}`);
          wrote = true;
          return;
        }
        const now = Date.now();
        if (now - lastPrint < 10_000 && info.chunksEmbedded !== info.totalChunks) return;
        lastPrint = now;
        process.stderr.write(`${text}\n`);
      },
    });
    if (wrote) process.stderr.write("\n");
    if (p.json) {
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    console.log(`Embedded ${r.chunksEmbedded} chunks from ${r.docsProcessed} docs in ${(r.durationMs / 1000).toFixed(1)} s`);
    if (r.errors > 0) {
      console.log(`ERRORS: ${r.errors} chunks failed (provider errors are shown above) — rerun 'qmd-remote embed' after fixing`);
      return 1;
    }
    return 0;
  } finally {
    await store.close();
  }
}

interface SearchHit {
  file: string;
  displayPath: string;
  title: string;
  score: number;
}

function toHit(h: { file?: string; filepath?: string; displayPath?: string; title?: string; score: number }): SearchHit {
  const f = h.file ?? h.filepath ?? "";
  return { file: f, displayPath: h.displayPath ?? f, title: h.title ?? "", score: h.score };
}

async function cmdQuery(p: Parsed): Promise<number> {
  const text = p.positionals.join(" ").trim();
  if (!text) throw new UsageError("query needs a search text: qmd-remote query <text>");
  const store = await openStore(p);
  try {
    let hits: SearchHit[];
    if (p.lexOnly) {
      hits = (await store.searchLex(text, { limit: p.limit, collection: collectionFilter(p) })).map(toHit);
    } else {
      const opts: SearchOptions = { query: text, limit: p.limit };
      const cols = collectionFilter(p);
      if (cols) opts.collections = cols;
      if (p.noRerank) opts.rerank = false;
      hits = await store.search(opts).then((r) => r.map(toHit));
    }
    if (p.json) {
      console.log(JSON.stringify(hits, null, 2));
      return 0;
    }
    if (hits.length === 0) {
      console.log("No results.");
      return 0;
    }
    for (const h of hits) console.log(`${h.score.toFixed(3)}  ${h.displayPath}${h.title ? `  — ${h.title}` : ""}`);
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdCollections(p: Parsed): Promise<number> {
  const [sub, name, path] = p.positionals;
  if (sub === "list" || sub === undefined) {
    const store = await openStore(p);
    try {
      const cols = await store.listCollections();
      if (p.json) {
        console.log(JSON.stringify(cols, null, 2));
        return 0;
      }
      if (cols.length === 0) {
        console.log("(no collections)");
        return 0;
      }
      for (const c of cols) console.log(`${c.name}\t${c.pwd}${c.includeByDefault ? "  [default]" : ""}`);
      return 0;
    } finally {
      await store.close();
    }
  }
  if (sub === "add") {
    if (!name || !path) throw new UsageError("collections add needs <name> <path>");
    const store = await openStore(p);
    try {
      await store.addCollection(name, { path, pattern: p.pattern });
      console.log(`Added collection "${name}" → ${path}`);
      return 0;
    } finally {
      await store.close();
    }
  }
  if (sub === "remove") {
    if (!name) throw new UsageError("collections remove needs <name>");
    const store = await openStore(p);
    try {
      const ok = await store.removeCollection(name);
      if (!ok) {
        console.error(`qmd-remote: collection "${name}" not found`);
        return 1;
      }
      console.log(`Removed collection "${name}"`);
      return 0;
    } finally {
      await store.close();
    }
  }
  throw new UsageError(`unknown collections subcommand: ${sub ?? ""} (list | add | remove)`);
}

async function cmdDoctor(p: Parsed): Promise<number> {
  const cfg = loadRemoteConfig(p.jobs);
  const jobs: RemoteJobs = cfg.jobs;
  // Probes must not retry: doctor is a diagnostic and is promised to be fast —
  // a rate-limited or dead provider should be reported, not waited out.
  const probeJobs: RemoteJobs = {
    embed: { ...jobs.embed, maxRetries: 0 },
    rerank: { ...jobs.rerank, maxRetries: 0 },
    expand: { ...jobs.expand, maxRetries: 0 },
  };
  const backend = await createBackend(probeJobs);
  const lines: { job: string; provider: string; detail: string; ok: boolean; error?: string }[] = [];

  const probe = async (job: string, fn: () => Promise<unknown>): Promise<{ detail: string; ok: boolean; error?: string }> => {
    const t0 = Date.now();
    try {
      const out = await fn();
      const ms = Date.now() - t0;
      return { detail: formatProbe(job, out, ms), ok: true };
    } catch (err) {
      return { detail: "", ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  const formatProbe = (job: string, out: unknown, ms: number): string => {
    if (job === "embed" && out && typeof out === "object" && "embedding" in (out as object)) {
      return `OK ${(out as { embedding: number[] }).embedding.length} dims, ${ms} ms`;
    }
    if (job === "expand" && Array.isArray(out)) return `OK ${(out as unknown[]).length} variants, ${ms} ms`;
    return `OK ${ms} ms`;
  };
  /**
   * The expand probe must go through `generate()`, NOT `expandQuery()`:
   * expansion degrades softly to the plain query on provider failure (qmd's
   * own semantics), so `expandQuery` never throws and a dead provider would
   * be reported green — the exact thing doctor exists to catch. `generate`
   * hits the same endpoint and fails loudly; the variants are then parsed
   * from its completion so the reported detail stays meaningful.
   */
  const probeExpand = async (): Promise<unknown> => {
    const out = await backend.generate(EXPAND_PROMPT("doctor probe"), { maxTokens: 64, temperature: 0 });
    if (!out || typeof out.text !== "string") throw new Error(`qmd-remote: expand (${jobs.expand.provider} ${jobs.expand.model}) returned no completion`);
    return parseExpansion(out.text, "doctor probe", true);
  };

  if (jobs.embed.provider === "local") lines.push({ job: "embed", provider: "local", detail: "local (no remote call)", ok: true });
  else lines.push({ job: "embed", provider: jobs.embed.provider, ...(await probe("embed", () => backend.embed("qmd-remote doctor probe"))) });
  if (jobs.rerank.provider === "local") lines.push({ job: "rerank", provider: "local", detail: "local (no remote call)", ok: true });
  else
    lines.push({
      job: "rerank",
      provider: jobs.rerank.provider,
      ...(await probe("rerank", () =>
        backend.rerank("doctor probe", [
          { file: "a.md", text: "the doctor probe document alpha" },
          { file: "b.md", text: "an unrelated document about zebras" },
        ]),
      )),
    });
  if (jobs.expand.provider === "local") lines.push({ job: "expand", provider: "local", detail: "local (no remote call)", ok: true });
  else lines.push({ job: "expand", provider: jobs.expand.provider, ...(await probe("expand", probeExpand)) });
  await backend.dispose();

  // index line (local sqlite only; skipped when no index file yet)
  let indexLine: string | null = null;
  const dbPath = p.db ?? defaultQmdDbPath();
  if (existsSync(dbPath)) {
    const store = await createStoreRemote({ dbPath, configPath: p.config, jobs });
    try {
      const s = await store.getStatus();
      indexLine = `index   ${dbPath}  ${s.totalDocuments} docs, ${s.needsEmbedding} awaiting embedding`;
    } finally {
      await store.close();
    }
  }

  if (p.json) {
    console.log(JSON.stringify({ configSource: cfg.source, jobs: lines, index: indexLine }, null, 2));
  } else {
    console.log(`config  ${cfg.source}`);
    for (const l of lines) console.log(`${l.job.padEnd(7)} ${l.provider.padEnd(14)} ${l.error ?? l.detail}`);
    if (indexLine) console.log(indexLine);
    else console.log("index   (no index at " + dbPath + " — run 'qmd-remote collections add' + 'update')");
  }
  return lines.some((l) => !l.ok) ? 1 : 0;
}

async function cmdMcp(p: Parsed): Promise<number> {
  // MCP over stdio: stdout is the protocol channel from here on — no stdout
  // writes outside frames (console.error is fine).
  const cfg = loadRemoteConfig(p.jobs);
  const store = await createStoreRemote({ dbPath: p.db, configPath: p.config, jobs: cfg.jobs });
  const gate = new InflightGate();
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  const handle = await serveStdio(() => createQmdRemoteMcpServer(store, { inflight: gate }));
  // Follow the parent's lifecycle: stdin EOF → the client is gone; wait for
  // in-flight work, then close store (sqlite + backend) and exit.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    handle.close();
    await gate.waitForIdle(10_000);
    await store.close().catch((err) => console.error(`qmd-remote: store close on shutdown failed: ${err instanceof Error ? err.message : err}`));
    // Not process.exit(): let the loop drain so any frame still in the stdout
    // buffer is flushed. Nothing keeps the process alive once stdin is done
    // and sqlite is closed.
    process.exitCode = 0;
    process.stdin.pause();
  };
  const onDone = () => {
    shutdown().catch((err) => {
      console.error(`qmd-remote: shutdown failed: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    });
  };
  // "end" fires when stdin is read to EOF, "close" when the handle goes away.
  // Both are listened to: which one arrives depends on whether the transport
  // keeps stdin in flowing mode.
  process.stdin.once("end", onDone);
  process.stdin.once("close", onDone);
  if (process.stdin.readableEnded) {
    await shutdown();
  }
  return 0; // unreachable while serving; keeps main()'s type honest
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`qmd-remote: ${err.message}`);
      console.error(USAGE);
      return 2;
    }
    throw err;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.version) {
    console.log(packageVersion());
    return 0;
  }
  const [command, ...rest] = parsed.positionals;
  try {
    if (command !== undefined) validateFlags(command, parsed);
    switch (command) {
      case "update":
        return await cmdUpdate(parsed);
      case "embed":
        return await cmdEmbed(parsed);
      case "query":
        parsed.positionals = rest;
        return await cmdQuery(parsed);
      case "status":
        return await cmdStatus(parsed);
      case "doctor":
        return await cmdDoctor(parsed);
      case "mcp":
        return await cmdMcp(parsed);
      case "collections":
        parsed.positionals = rest;
        return await cmdCollections(parsed);
      case undefined:
        console.error(USAGE);
        return 2;
      default:
        console.error(USAGE);
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`qmd-remote: ${err.message}`);
      return 2;
    }
    // D7: provider/config/store errors fail loudly — the message already
    // names job/provider/URL (adapters) or the config path (config-file).
    const msg = redactSecrets(err instanceof Error ? err.message : String(err));
    console.error(msg.startsWith("qmd-remote:") || msg.startsWith("config:") ? msg : `qmd-remote: ${msg}`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(redactSecrets(`qmd-remote: ${err instanceof Error ? (err.stack ?? err.message) : err}`));
      process.exitCode = 1;
    },
  );
}
