# P1 plan — package scaffold + backend port

**Status:** drafted 2026-10-31. Ready to start (pending: workspace-location confirmation, see P1.0).
**Parent spec:** `docs/tmp/qmd-remote-package-spec.md` (decisions D1–D14).
**Source to port:** `../axel-agent/src/qmd-backend/` (≈1 540 lines) + `../axel-agent/tests/qmd-backend.test.ts` (19 tests) + the `qmdKb` block of `tests/config.test.ts`.

## Goal / definition of done

A standalone local package that compiles, is fully unit-tested offline, and exposes
one working entry point: `createBackend(jobs)` → an object implementing qmd's duck-typed
LLM surface, proven end-to-end against a local mock HTTP provider.

**Green gate (commit when met):** `npm run typecheck` clean + `npm test` all green +
smoke: `createBackend` with an `openai-compat` job pointed at a local mock server
returns a real embedding vector.

## Out of scope (later phases)

`createStoreRemote` + config-file loading (P2), CLI (P3), MCP server (P4), consumer
test (P5), publishing (P6). P1 ships **no** bin, **no** config-file reader.

## P1.0 — Workspace (DECIDED: current folder)

- **Workspace: this folder** (`/Users/axel/Services/qmd-wrapper`, its `.git` was
  deleted by the user), project/package name **`qmd-remote`** from day one.
  `git init` now (local-only; GitHub remote added in P6). The interview docs
  (`docs/tmp/`, AGENTS.md) stay in the repo — they document this project.
- License: MIT, `Copyright (c) 2026 Axel Müller <info@axel-mueller.net>`.

Files to create:

- `package.json`:
  - `name`: `qmd-remote` (FINAL, confirmed 2026-10-31; the npm name is claimed at
    P6 publish)
  - `version` `0.1.0`, `type: "module"`, `license: "MIT"`, `private: true` (until P6)
  - `engines: { node: ">=22.0.0" }` — **qmd itself requires ≥22** (its package.json);
    this corrects the spec's "Node ≥20"
  - `main`/`types` → `dist/index.js`/`dist/index.d.ts`; `exports` = `{ ".": { types, import } }`
    (mirror qmd's shape; do NOT add a bin in P1)
  - `files: ["dist", "README.md", "LICENSE"]`
  - `dependencies`: `"@tobilu/qmd": "2.8.3"` (exact pin, D5). No other runtime deps —
    adapters are plain `fetch`, like axel-agent's.
  - `devDependencies`: `typescript`, `tsx`, `@types/node`
  - `scripts`: `build` = `tsc -p tsconfig.build.json`, `typecheck` = `tsc --noEmit`,
    `test` = `node --import tsx --test 'tests/*.test.ts'` (axel-agent's exact runner —
    native node:test, no framework dep)
- `tsconfig.json` (dev, `noEmit`, `module: nodenext`, `moduleResolution: nodenext`,
  `strict`) + `tsconfig.build.json` (`outDir: dist`, `declaration: true`, excludes
  `tests/`)
- `LICENSE` (MIT, `Copyright (c) 2026 Axel Müller <info@axel-mueller.net>`)
- `README.md` (stub: title + one-paragraph pitch + "under construction"; full README
  is P6)
- `.gitignore` (`node_modules/`, `dist/`, `*.tgz`, `scratch/`, `.DS_Store`); `docs/`
  already holds the spec + this plan (workspace = this folder)
- First commit right after `npm install` goes green (that also verifies qmd's native
  deps — node-llama-cpp, better-sqlite3, sqlite-vec, tree-sitter — install cleanly on
  this machine via plain npm; axel-agent needed an allow-list entry for
  node-llama-cpp's postinstall, plain npm just runs it — watch the install log)

- **Import extensions:** axel-agent's source imports with `.ts` extensions (tsx
  source mode). The port rewrites those to `.js` (standard ESM output convention) so
  one plain `tsc` build works without `allowImportingTsExtensions`. tsx resolves
  `.js` → local `.ts` for tests/run.

## P1.1 — Port the backend (file by file, commit per green checkpoint)

Target layout: `src/backend/{types.ts, config.ts, factory.ts, adapters/{shared.ts,
openai-compat.ts, ollama.ts}}` + public `src/index.ts`.

Per file — **KEEP / CHANGE / DROP**:

- **`types.ts` → `src/backend/types.ts`** — KEEP the whole LLM-surface mirror
  (`QmdLlmBackend`, options/results types) and the job-config shapes. CHANGE: rename
  for the package (drop the app-specific `QmdKb` prefix): `QmdKbJobConfig` →
  `RemoteJobConfig`, `QmdKbJobs` → `RemoteJobs`, `QmdKbProvider` →
  `RemoteProvider`. DROP: `QmdKbConfig` (its `name`/`indexDir` fields are
  store/CLI concerns, P2+). DROP from comments: ADR-0010 / axel-agent references.
- **`config.ts` → `src/backend/config.ts`** — KEEP the normalization logic
  (defaults: `timeoutMs` 60 000, `rerankMaxChars` 8000, `expandMaxTokens` 600,
  loud errors on unknown fields / missing `baseUrl` on remote jobs). CHANGE: input
  is now a `jobs` object (not a `qmdKb` block) — export
  `normalizeJobs(raw: unknown): RemoteJobs`; keep "absent job = `{provider:"local"}`".
- **`adapters/shared.ts`** — KEEP as-is (HTTP helper + qmd-mirroring expansion
  parse/fallback). Minor comment cleanups only.
- **`adapters/openai-compat.ts`** — KEEP (`/embeddings`, Jina-style `/rerank`,
  `/chat/completions`, THROW-on-provider-failure). CHANGE: remove the `keyFor`
  parameter (axel-agent's auth.json indirection, D-ported-out); `job.apiKey` is the
  only key source in the package.
- **`adapters/ollama.ts`** — KEEP (`/api/embed`, `/api/rerank`, `/api/chat`), same
  `keyFor` removal.
- **`factory.ts` → `src/backend/factory.ts`** — KEEP: composite per-job routing; one
  shared real `LlamaCpp` only when ≥1 job is local; stable `api:<provider>:<model>`
  name getters; lossless UTF-16 code-unit tokenize for all-remote; the **file-URL
  import of `LlamaCpp` from the installed qmd dist** (qmd's exports map is `.`-only —
  subpath imports are blocked; the exact pin keeps the dist path stable — the trick
  in `factory.ts:60+` comes along verbatim). CHANGE: rename to `createBackend(jobs,
  options?)`; `options` keeps `llamaCtor` (test hook), drops `keyFor`.
- **`keys.ts` — DROP entirely** (auth.json key resolution is app plumbing).
- **`index.ts` (old bridge entry) — DROP and replace** (see P1.2). The
  `AXEL_QMD_BACKEND` / `AXEL_QMD_JOBS` env machinery and `createQmdBackend` exist
  only for axel-agent's patched-CLI path; the package has no patched qmd.

## P1.2 — Public entry `src/index.ts`

```ts
export * from "./backend/types.js";
export * from "./backend/config.js";
export { createBackend } from "./backend/factory.js";
// re-export qmd's public surface (D5: one physical qmd copy, one module for users)
export * from "@tobilu/qmd";
```

Verify at build time that `export * from "@tobilu/qmd"` carries the d.ts surface
(`createStore` + friends) through `dist/` — that's the whole "one module" promise
tested by a typecheck-only test file.

## P1.3 — Tests (port, don't rewrite)

`tests/backend.test.ts` (from `tests/qmd-backend.test.ts`, 19 tests) +
`tests/config.test.ts` (the `qmdKb` block of axel-agent's `tests/config.test.ts`,
scoping to normalization only). Changes: renames per P1.1, remove `keyFor`/auth.json
fixtures, drop the `createQmdBackend`-env-var tests (replaced by two new ones):

- `createBackend` with a remote job missing `baseUrl` → throws, message names the job
- all-local `createBackend` with a stubbed `llamaCtor` → the stub instance's methods
  are used for all three jobs (proves the local leg without loading native models)

Plus the **P1 smoke** (not a permanent test): small script in `scratch/` (gitignored
pattern from axel-agent) that starts an inline mock `/v1/embeddings` HTTP server on
loopback, calls `createBackend({ jobs: { embed: { provider:"openai-compat",
baseUrl: mock, model:"mock-embed" } } })`, runs `embed("hello")`, asserts a numeric
vector of fixed dims comes back.

## P1.4 — Pack dry-run

`npm run build` → `npm pack --dry-run` → confirm the tarball contains exactly
`dist/` + README + LICENSE + package.json (no tests, no scratch). Not published
(P6); this just proves the shape.

## Checkpoint/commit sequence

1. scaffold + `npm install` green → commit
2. types + config + tests green → commit
3. adapters + their tests green → commit
4. factory + public entry + smoke green → commit (P1 done → run green gate)

## Known risks

- **Native-dep install** (node-llama-cpp postinstall, better-sqlite3, sqlite-vec,
  tree-sitter prebuilds) on this machine — first commit exposes any problem early;
  it's dead weight when remote but keeps the `local` provider real (accepted, spec
  fine print).
- **Name collision in `export *`**: if `@tobilu/qmd`'s d.ts ever exports a name we
  also export (e.g. our `createBackend`), TS errors at build — keep our export names
  distinct (`createBackend`, `normalizeJobs`, `Remote*`).
- axel-agent's source is private/unlicensed: port by copying-then-rewriting headers
  (no "derived from axel-agent" line — the adapters are the user's own prior work;
  the README in P6 states the package's relationship to qmd only).
