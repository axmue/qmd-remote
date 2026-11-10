# Review fixes — plan (from `docs/tmp/review-2026-11-10.md`)

**Status:** DONE 2026-11-10 — all batches landed; 58/58 tests green. Baseline: commit `20eae2c`, 35/35 green.

Each step ends green (`npm run typecheck` + `npm test`) and is committed.

## Batch A — publish blockers

- [x] A1 `doctor` expand probe uses `backend.generate()` (throws) instead of
      `expandQuery()` (soft-fallback) — review §2.1. Test: dead/401 expand
      provider → exit 1, job named.
- [x] A2 Secrets: `apiKey` indirection `env:VAR` / `file:/path`; warn on
      group/world-readable config file; redact `Bearer …` in error formatting;
      warn on cleartext http + apiKey to a non-loopback host — §3.1-3.3, 3.5.
- [x] A3 `--version` / `-V`; drop the dead eslint directive.
- [x] A4 Real README (install, config incl. secret indirection, CLI, MCP, SDK,
      privacy sentence, fail-loud + the expand exception) — stop pointing at
      `docs/tmp/`.

## Batch B — robustness

- [x] B1 `postJson` retry/backoff: 429 + 5xx + network, honour `Retry-After`,
      2 extra attempts, per-job `maxRetries` — §5.1.
- [x] B2 `importLlamaCppCtor` tries `import.meta.resolve("@tobilu/qmd")` first
      (pnpm/PnP), keeps the walk as fallback — §4.3.
- [x] B3 Project-local `.qmd/index.yaml|.yml` discovery + paired
      `.qmd/index.sqlite`; honour `HOME`/`USERPROFILE` like qmd's
      `qmdHomedir()` — §4.4.
- [x] B4 `embedBatch` returns per-item `null` instead of throwing on a short
      batch — §2.4.
- [x] B5 MCP shutdown: `process.exitCode` instead of `process.exit`, listen on
      `end` as well as `close` — §2.2-2.3.

## Batch C — usability / hygiene

- [x] C1 Per-command flag validation (reject `status --force` etc.);
      `--jobs <path>` flag for the jobs config; `--` separator for `query`.
- [x] C2 TTY-aware progress (no `\r` when piped); print config source on stderr
      for store commands.
- [x] C3 Unify collections idiom after re-verifying the "empty
      `status.collections`" claim (review §1) — use `status.collections`, drop
      the stale comments.
- [x] C4 Docs: promote spec to `docs/specs/`, fill AGENTS.md "Done When",
      `docs/adr/index.md` stub.
- [x] C5 CI: `ci.yml` (typecheck + test + consumer test) and a drift check for
      the verbatim MCP copy.
