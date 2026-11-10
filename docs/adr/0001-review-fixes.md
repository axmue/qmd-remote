# ADR-0001 — Decisions taken while fixing the 2026-11-10 code review

**Date:** 2026-11-10 · **Status:** accepted · **Context:**
[`docs/tmp/review-2026-11-10.md`](../tmp/review-2026-11-10.md),
[`docs/tmp/review-fixes-plan.md`](../tmp/review-fixes-plan.md)

The review raised four questions that the original spec (D1–D14) did not answer.
The answers are recorded here because they constrain future work.

## 1. Query expansion is the one exception to fail-loud (refines D7)

D7 says a job configured remote never silently falls back. Query expansion does
degrade — to the plain query — when its provider fails, because that is stock
qmd's own behavior and because a search dying over a missing *paraphrase* is
worse than a slightly weaker search. The boundary is now explicit:

- the degradation is logged on stderr, naming the provider and reason;
- `doctor` probes the expand job through `generate()` (which throws) instead of
  `expandQuery()` (which does not), so a dead expand provider is reported red.
  This closed a real bug: before the fix, `doctor` reported `OK 2 variants` and
  exited 0 for a provider on a closed port.
- `embed` and `rerank` keep the hard-failure semantics unchanged.

**Consequence:** any future caller that needs "expansion must work" has to use
`generate()`/`complete()` directly, not `expandQuery()`.

## 2. Credentials: indirection in the config, redaction on the way out (refines D9)

D9 made the config file the single source of truth and rejected per-field env
overrides. That is kept for *routing*, but credentials are different: a literal
key in `~/.config/qmd-remote/config.json` gets committed, synced and copied into
agent configs. Therefore:

- `apiKey` accepts `env:VAR_NAME` and `file:/path` in addition to a literal;
- indirections resolve **at config load**, so a missing secret is a startup
  error, not a 401 in minute 20 of an embed run;
- a literal key in a group/world-readable file produces a one-time stderr
  warning (not a refusal — stranding a user mid-task is worse);
- `apiKey` + cleartext `http://` to a non-loopback host warns;
- everything printed goes through `redactSecrets()`, because gateways echo the
  request (including `Authorization`) in 4xx payloads.

**Rejected:** refusing to start on a loose file mode (too brittle: shared CI
checkouts, root-owned configs), and an OS keychain integration (platform-
specific, and `file:`/`env:` composes with any secret manager already).

## 3. Retries belong in the transport, not in qmd (new)

Metered providers rate-limit exactly the workload this package generates (a few
thousand embed requests in a row). Retrying is therefore the transport's job:
429/5xx/network get `maxRetries` (default 2) extra attempts with exponential
backoff honouring `Retry-After`.

- 4xx **and timeouts** are not retried: a 401 is a config error, and retrying a
  timeout multiplies the wall-clock budget the user explicitly set.
- `doctor` probes run with `maxRetries: 0` — a diagnostic must report a slow or
  rate-limited provider, not wait it out.
- Partial batch responses now yield per-item `null` instead of throwing, because
  qmd records and retries individual failed chunks; throwing discarded 31 good
  embeddings to punish one bad input.

## 4. "Stock index locations" includes the project-local layout (refines D6)

D6 promised the same files as stock qmd. The mirror only covered the global
locations, so a user inside a project that stock `qmd` indexed into
`.qmd/index.yml` + `.qmd/index.sqlite` silently got a different (global, usually
empty) index. Resolution order is now, for both config and DB:

1. explicit flag / env (`--db`/`--config`, `INDEX_PATH`, `QMD_CONFIG_DIR`)
2. project-local `.qmd/index.yaml|.yml` found by walking up from the cwd
3. the global XDG locations

`HOME`/`USERPROFILE` now take precedence over `os.homedir()`, matching qmd's
`qmdHomedir()`.

**Consequence:** path resolution depends on the cwd. The CLI documents it; SDK
callers that must be cwd-independent should pass `dbPath`/`configPath`
explicitly.

## 5. Guarding the copies (operationalises D3/D11)

`src/mcp.ts` is a deliberate verbatim copy of qmd's internal MCP tool surface.
`scripts/check-mcp-drift.mjs` compares the copy's tool names and input-schema
keys against the installed qmd and fails when the pin moves, so a bump forces a
deliberate re-sync. It runs in CI and in the weekly upstream-release job, where
drift is *reported* rather than gating (a bump is expected to need review).
