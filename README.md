# qmd-remote

**A small adapter that lets [qmd](https://www.npmjs.com/package/@tobilu/qmd) run
its embed / rerank / query-expansion jobs on remote endpoints.**

First, credit where it's due: **[qmd](https://www.npmjs.com/package/@tobilu/qmd)
is the real work here.** The indexer, the chunker, hybrid BM25 + vector search,
the reranking, the MCP tool surface — that's all qmd, and it's genuinely great.
We're simply thankful it exists.

Our part is tiny. We had one humble itch: qmd runs its three model jobs on local
GGUF models via node-llama-cpp, which is slow on a GPU-less box and impractical
on a small one. So `qmd-remote` does just one modest thing — it points any of
those jobs at an OpenAI-compatible endpoint (OpenRouter, Jina, vLLM, LM Studio,
…) or a local Ollama server, per job — and otherwise stays out of qmd's way: the
SQLite index, the chunker, the search, the tools all remain exactly as qmd ships
them. A thin seam around a great tool, nothing more.

- **Same index as stock qmd** (`~/.config/qmd/index.yml` + `~/.cache/qmd/index.sqlite`,
  or a project-local `.qmd/`), so existing qmd users switch models without
  reindexing anything but the embeddings.
- **No patch, no fork**: depends on stock, unmodified `@tobilu/qmd` (pinned
  exactly) and swaps the model backend through a documented runtime seam.
- **No GGUF downloads** when every job is remote.
- **Three doors**: a CLI, an MCP server for agents, and an SDK.

> Unofficial and unaffiliated — just a grateful add-on. All credit for the
> search engine belongs to qmd (`@tobilu/qmd`); this package only contributes
> the remote backend adapters (MIT). If anything here is useful, it's because
> qmd made it easy.

> **Privacy:** remote jobs send your content to a third party. Embedding sends
> every indexed chunk, reranking sends candidate document text (up to 8 000
> chars per candidate), query expansion sends your query. If that is not
> acceptable for a collection, keep those jobs `local` or use Ollama on your own
> machine — `qmd-remote` never silently sends anything a job's config did not
> ask for.

Requirements: **Node ≥ 22**.

## Install

> **Not on npm yet** (first release pending). For now, install from git:
>
> ```sh
> git clone https://github.com/axmue/qmd-remote.git && cd qmd-remote
> npm install && npm run build
> npm link            # puts the `qmd-remote` binary on PATH
> ```
>
> Once published, it becomes:
>
> ```sh
> npm i -g qmd-remote      # CLI + MCP server
> npm i qmd-remote         # as a library
> ```

## Quick start

```sh
# 1. which models serve which job
mkdir -p ~/.config/qmd-remote
cat > ~/.config/qmd-remote/config.json <<'JSON'
{
  "jobs": {
    "embed":  { "provider": "openai-compat", "baseUrl": "https://api.jina.ai/v1",
                "model": "jina-embeddings-v3", "apiKey": "env:JINA_API_KEY" },
    "rerank": { "provider": "openai-compat", "baseUrl": "https://api.jina.ai/v1",
                "model": "jina-reranker-v2-base-multilingual", "apiKey": "env:JINA_API_KEY" },
    "expand": { "provider": "ollama", "model": "qwen3:4b" }
  }
}
JSON

# 2. check it before spending 30 minutes on a bad key
export JINA_API_KEY=jina_…
qmd-remote doctor

# 3. index and search
qmd-remote collections add notes ~/notes
qmd-remote update          # read files, chunk, store (no model calls)
qmd-remote embed           # embeddings via your provider
qmd-remote query "how did we fix the connection pool timeout" -n 5
```

`doctor` output:

```
config  /home/me/.config/qmd-remote/config.json
embed   openai-compat  OK 1024 dims, 412 ms
rerank  openai-compat  OK 288 ms
expand  ollama         OK 4 variants, 1233 ms
index   /home/me/.cache/qmd/index.sqlite  1832 docs, 0 awaiting embedding
```

## Configuration

One JSON file, one key: `jobs`. Path resolution: `--jobs <path>` →
`$QMD_REMOTE_CONFIG` → `$XDG_CONFIG_HOME/qmd-remote/config.json` →
`~/.config/qmd-remote/config.json`. **No file = all jobs local = stock qmd
behavior.** Unknown keys and malformed values are startup errors naming the
exact path (`jobs.embed.baseUrl`), never silently ignored.

### Jobs

| job | what it does | called by |
|---|---|---|
| `embed` | embeds document chunks and queries | `embed`, every `vec`/`hyde` search |
| `rerank` | reorders search candidates | `query` (unless `--no-rerank`) |
| `expand` | turns a plain query into lex/vec/hyde variants | `query` |

### Fields

| field | applies to | meaning |
|---|---|---|
| `provider` | all | `local` (qmd's GGUF models), `openai-compat`, `ollama` |
| `model` | remote | provider model name — **required** for remote jobs |
| `baseUrl` | remote | required for `openai-compat` (e.g. `https://api.jina.ai/v1`); `ollama` defaults to `http://127.0.0.1:11434` |
| `apiKey` | remote | literal, or `env:VAR_NAME`, or `file:/path/to/secret` (see below) |
| `headers` | remote | extra request headers (e.g. OpenRouter's `HTTP-Referer` / `X-Title`) |
| `timeoutMs` | remote | per-request wall-clock cap, default `60000`, min `1000` |
| `maxRetries` | remote | extra attempts on 429/5xx/network, default `2`, `0` disables |
| `embedQueryPrefix` / `embedDocPrefix` | `embed` | text prefixes for two-tower models (Jina v3, E5, …) |
| `rerankMaxChars` | `rerank` | per-document truncation, default `8000` |
| `expandMaxTokens` | `expand` | completion cap, default `600` |

### Keys

Do not paste provider keys into the config file if you can avoid it:

```json
"apiKey": "env:OPENROUTER_API_KEY"   // read from the environment at startup
"apiKey": "file:~/.secrets/jina"     // first line of a file
"apiKey": "sk-or-v1-…"               // literal (warns if the file is readable by others)
```

Indirections are resolved when the config loads, so a missing variable is a
startup error — not a 401 halfway through a long embed run. Keys are scrubbed
from every message `qmd-remote` prints.

### Endpoints used

| provider | embed | rerank | expand |
|---|---|---|---|
| `openai-compat` | `POST {baseUrl}/embeddings` | `POST {baseUrl}/rerank` (Jina style) | `POST {baseUrl}/chat/completions` |
| `ollama` | `POST {baseUrl}/api/embed` | `POST {baseUrl}/api/rerank` | `POST {baseUrl}/api/chat` |

## CLI

```
qmd-remote update      [-c <col> ...]                  index collections (no model calls)
qmd-remote embed       [-c <col>] [--force]            embed what update left
qmd-remote query <text> [-c <col>] [-n <n>]
                       [--no-rerank] [--lex-only]      hybrid search
qmd-remote status                                      index counts (offline)
qmd-remote doctor                                      config + live probe of every remote job
qmd-remote mcp                                         MCP server over stdio (for agents)
qmd-remote mcp --http --port <n> [--host <addr>]       MCP server over Streamable HTTP
               [--allowed-host <h>]... [--token <ref>]
qmd-remote collections list | add <name> <path> [--pattern <glob>] | remove <name>

  -d, --db <path>      index.sqlite    (default: stock qmd location, or ./.qmd/index.sqlite)
      --config <path>  index.yml       (default: stock qmd location, or ./.qmd/index.yml)
      --jobs <path>    models config   (default: $QMD_REMOTE_CONFIG or ~/.config/qmd-remote/config.json)
      --json           machine-readable output
  -h, --help · -V, --version
```

Exit codes: `0` ok · `1` runtime/provider/config error · `2` usage error.

`--lex-only` is the offline leg: BM25 only, zero model calls — useful when a
provider is down or you are on a plane.

### Error semantics

A job configured remote **never silently falls back to local models**. A failed
provider call aborts the command with exit 1 and a message naming the job,
provider, model, URL and reason:

```
qmd-remote: embed (openai-compat jina-embeddings-v3) request to
https://api.jina.ai/v1/embeddings failed: HTTP 401 {"detail":"invalid key"}
```

429/5xx/network failures are retried first (`maxRetries`, honouring
`Retry-After`); 4xx and timeouts fail immediately — they are configuration
problems, and retrying them just wastes your time.

**One documented exception:** query *expansion* degrades to the plain query when
its provider fails (that is also what stock qmd does locally — a search should
not die because the expander is down). It is logged on stderr, and `doctor`
probes the expand job through a call that *does* fail loudly, so a dead expand
provider is never reported green.

## MCP server (agents)

`qmd-remote mcp` serves qmd's tool surface — `query`, `get`, `multi_get`,
`status`, plus the `qmd://{path}` resource — over stdio against the
remote-wired store. One server process per agent; no model downloads when all
jobs are remote.

```json
{
  "mcpServers": {
    "qmd-remote": {
      "command": "qmd-remote",
      "args": ["mcp"],
      "env": {
        "QMD_REMOTE_CONFIG": "/home/me/.config/qmd-remote/config.json",
        "JINA_API_KEY": "jina_…"
      }
    }
  }
}
```

The server exposes the content of your indexed collections to the agent
(including file reads within those collections) — scope it with collections you
are willing to share.

### Over the network (Streamable HTTP)

stdio only reaches a child process on the same machine. To reach a collection
from another host, serve it over **Streamable HTTP** — built in, no bridge:

```sh
qmd-remote mcp --http --port 8771 \
  --host 100.x.y.z \                 # bind address; a tailnet IP/name to expose (default 127.0.0.1)
  --db   /srv/vci/.qmd/index.sqlite \
  --config /srv/vci/.qmd/index.yml \
  --jobs /srv/vci/qmd-remote.json \
  --token env:QMD_HTTP_TOKEN        # optional bearer (literal, env:VAR, or file:/path)
```

Endpoints: `POST /mcp` (sessionless JSON) and `GET /health`. A `Host`-header
allowlist (DNS-rebinding guard) runs first — the bind host is allowed by
default; add more with repeatable `--allowed-host`. The bearer `--token` is
optional; **without it, anyone who can reach the port can query the index**, so
bind to a trusted network. The Host guard is not authentication.

Run one process per collection, each on its own port (independent index + jobs):

```sh
qmd-remote mcp --http --port 8771 --db /srv/vci/.qmd/index.sqlite --config /srv/vci/.qmd/index.yml --jobs /srv/vci/qmd-remote.json
qmd-remote mcp --http --port 8772 --db /srv/agv/.qmd/index.sqlite --config /srv/agv/.qmd/index.yml --jobs /srv/agv/qmd-remote.json
```

An HTTP MCP client then connects to `http://<host>:8771/mcp` (vci) and
`http://<host>:8772/mcp` (agv). Stop with Ctrl-C (SIGINT) — the handler, HTTP
server and store close cleanly.

## SDK

```ts
import { createStoreRemote } from "qmd-remote";

const store = await createStoreRemote();          // config file → remote-wired qmd store
await store.update();
await store.embed();
const hits = await store.search({ query: "connection pool timeout", limit: 5 });
await store.close();
```

Everything qmd exports is re-exported from `qmd-remote` (one physical copy of
qmd in your tree), so `createStore`, types and helpers come from the same
module.

Lower-level door — just the model backend, for wiring into a store yourself:

```ts
import { createBackend, loadRemoteConfig, createStore } from "qmd-remote";

const backend = await createBackend(loadRemoteConfig().jobs);
const store = await createStore({ dbPath });
(store.internal as { llm?: unknown }).llm = backend;   // before any call
```

`createStoreRemote({ dbPath?, configPath?, jobs?, llamaCtor? })` also accepts a
raw `jobs` object directly (normalized and validated internally), which is the
usual choice for tests and embedded use.

## How it works

Stock qmd resolves every model job through one duck-typed LLM object
(`store.llm ?? getDefaultLlamaCpp()`). `createStoreRemote` builds a normal qmd
store and replaces that object with a composite backend **before any call**, so
both the write path (`update` → `embed`) and the search path (expand → embed →
rerank) route through the configured providers. Nothing in `node_modules` is
patched. Jobs left `local` share a single real `LlamaCpp` instance; when every
job is remote, node-llama-cpp is never asked for a model.

Remote jobs report stable model names (`api:openai-compat:<model>`), which feed
qmd's own embedding fingerprints — switching provider or model reads as a model
switch, and qmd re-embeds what it must.

## Compatibility

`@tobilu/qmd` is pinned to an exact version because this package depends on its
runtime shape. CI re-runs the full suite — including an end-to-end proof that
`update` + `embed` + `search` all route through a mock provider on a real,
unpatched store — against every new upstream release before the pin moves.

## License

MIT. See `LICENSE`.
