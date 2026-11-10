# P5b — try it locally somewhere else (CLI + MCP), no publishing

Shortcut: `node scripts/consumer-test.mjs` automates everything below (mock
provider). The manual path below uses YOUR provider of choice.

## 1. Pack + install into a fresh folder

```sh
cd ~/Services/qmd-wrapper
npm run build && npm pack                 # → qmd-remote-0.1.0.tgz

mkdir ~/qmd-remote-playground && cd ~/qmd-remote-playground
npm init -y
npm i ~/Services/qmd-wrapper/qmd-remote-0.1.0.tgz
```

Bin is now `./node_modules/.bin/qmd-remote`.

## 2. Create the three fixture files

`docs/` — a few markdown files to index:

```
docs/note1.md
docs/note2.md
```

`index.yml` — which folder is a collection (qmd's own format):

```yaml
collections:
  playground:
    path: /absolute/path/to/playground/docs
```

`qmd-remote.json` — which models serve which job. Pick ONE:

all-local (uses qmd's bundled GGUF; downloads models on first run):
```json
{ "jobs": { "embed": { "provider": "local" }, "rerank": { "provider": "local" }, "expand": { "provider": "local" } } }
```
or local Ollama (no keys):
```json
{ "jobs": { "embed":  { "provider": "ollama", "model": "nomic-embed-text" },
            "rerank": { "provider": "ollama", "model": "jina-reranker-v0" },
            "expand": { "provider": "local" } } }
```
or OpenAI-compatible (key required):
```json
{ "jobs": { "embed":  { "provider": "openai-compat", "baseUrl": "https://openrouter.ai/api/v1", "model": "qwen/qwen3-embedding-4b", "apiKey": "sk-or-..." },
            "rerank": { "provider": "openai-compat", "baseUrl": "https://api.jina.ai/v1", "model": "jina-reranker-v2", "apiKey": "..." },
            "expand": { "provider": "local" } } }
```

## 3. Point qmd + qmd-remote at the playground (sandbox env)

```sh
export QMD_REMOTE_CONFIG=$PWD/qmd-remote.json     # jobs config
export QMD_CONFIG_DIR=$PWD                        # index.yml lives here
export INDEX_PATH=$PWD/index.sqlite               # the sqlite db
```

(Without these, the defaults are stock qmd's locations —
`~/.config/qmd/index.yml` + `~/.cache/qmd/index.sqlite` — i.e. it would share
the index with an existing stock qmd install. That's a feature in normal use;
for testing, sandbox it like above.)

## 4. Test the CLI

```sh
alias qr=./node_modules/.bin/qmd-remote
qr doctor                    # ← first: config + live provider probe, exit 1 if broken
qr collections list          # → playground
qr update                    # index docs (no embeddings)
qr embed                     # embeddings via your provider(s)
qr query "your search text" -n 5
qr query "term" --lex-only   # offline leg (zero provider calls)
qr status
qr collections add other ~/some/other/folder
qr collections remove other
```

Expected failure behavior to verify once (D7): break a key → `qr embed`
exits 1, stderr names job/provider/URL/HTTP status; nothing falls back to
local silently.

## 5. Test the MCP server

Agent config entry (Claude Code / any MCP client, stdio):

```json
{
  "mcpServers": {
    "qmd-remote": {
      "command": "/absolute/path/to/playground/node_modules/.bin/qmd-remote",
      "args": ["mcp"],
      "env": {
        "QMD_REMOTE_CONFIG": "/absolute/path/to/playground/qmd-remote.json",
        "QMD_CONFIG_DIR": "/absolute/path/to/playground",
        "INDEX_PATH": "/absolute/path/to/playground/index.sqlite"
      }
    }
  }
}
```

Then in the agent: ask it to search → it sees 4 tools
(`query`, `get`, `multi_get`, `status`) + the server instructions listing your
collections. Verify: a `query` call returns your docs; `get` returns a
document with line numbers.

Without an agent, one-line protocol check (handshake + tools/list):

```sh
cd ~/qmd-remote-playground && npm i -D @modelcontextprotocol/client@2.0.0
node --input-type=module -e '
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
const t = new StdioClientTransport({ command: process.execPath, args: ["node_modules/qmd-remote/dist/cli.js", "mcp"], env: { ...getDefaultEnvironment(), ...process.env }, stderr: "inherit" });
const c = new Client({ name: "smoke", version: "0.0.0" });
await c.connect(t);
console.log("server:", (await c.getServerVersion()).name);
console.log("tools:", (await c.listTools()).tools.map(x => x.name).join(", "));
await c.close();
'
```

## 6. Clean up

```sh
unset QMD_REMOTE_CONFIG QMD_CONFIG_DIR INDEX_PATH
rm -rf ~/qmd-remote-playground     # or keep it as your sandbox
```
