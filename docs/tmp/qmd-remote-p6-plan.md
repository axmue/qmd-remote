# P6 plan — publish (spec D4, D13) — admin phase, mostly user-driven

**Status:** drafted 2026-10-31. Everything technical is done (P5 gate met);
this phase is account/repo/registry steps. The user does the interactive
parts; the agent prepares and executes everything around them.

## State before P6

- code + tests complete: 35/35 in-repo tests + 6/6 consumer gate
- name decision still open (D4): `qmd-remote` (recommended, free as of
  2026-10-31) vs `qmd-remote-wrapper`
- `private: true` still in package.json (must come off before publish)

## User tasks (interactive — the agent can't do these)

1. **Decide the final npm name** (D4).
2. **Create a GitHub account/repo** (if the user doesn't already have a
   suitable one): repo `qmd-remote` (or chosen name), public, with the
   standard description. The local git repo (this folder) is ready to push.
3. **Create an npm account** (npmjs.com): enable 2FA from the start.
4. **`npm login`** (interactive) — then the agent runs `npm publish --access
   public`.

## Agent tasks (ordered; each is a checkpoint)

1. **Final name + polish** (after task 1):
   - set `name` in package.json (if it changes, also the bin name + README +
     spec refs — grep `qmd-remote` first);
   - drop `private: true`;
   - version stays `0.1.0` (first public release; the consumer test reads the
     version dynamically, nothing hardcoded).
2. **Real README** (replace the stub):
   - pitch + install (`npm i qmd-remote`);
   - quick start: `qmd-remote doctor` → `collections add` → `update` →
     `embed` → `query`;
   - config file section: path (`$QMD_REMOTE_CONFIG` /
     `~/.config/qmd-remote/config.json`), the `jobs` schema with a full
     example (openai-compat + ollama + local mixed), per-job fields,
     fail-loud semantics (D7);
   - MCP section: the exact agent-config JSON for `qmd-remote mcp` (stdio),
     one server process per agent;
   - SDK section: `createStoreRemote` + `createBackend` examples;
   - `doctor` output example (real, from a test run);
   - relationship statement (D1): "Unofficial, not affiliated with tobit/qmd.
     Depends on stock, unmodified @tobilu/qmd (pinned); the backend adapters
     are original code."
   - requirements: Node ≥ 22.
3. **GitHub push** (after task 2): `git remote add origin … && git push -u
   origin main` (agent runs it once the remote URL exists).
4. **Publish** (after task 4): `npm publish --access public` from a clean
   tree; verify `npm view qmd-remote` + `npm i -g qmd-remote` smoke in a
   throwaway dir (`qmd-remote --help`).
5. **CI (D11)** — GitHub Actions, weekly schedule:
   - `check-qmd-release.yml`: `npm view @tobilu/qmd version` vs the pinned
     version; if new → run the compat suite: `npm test` (incl. the e2e seam
     proof) AND `scripts/consumer-test.mjs` in a workspace with the NEW pin
     (`npm i @tobilu/qmd@<new>` + regenerate nothing — the pin is the only
     coupling point); green ⇒ open a PR bumping the pin (never auto-merge);
     red ⇒ open an issue with the failing test.
   - `ci.yml` (on push): `npm ci && npm test` (pretest builds; Node 22).
6. **Final tick**: spec "Status" → shipped; move the durable docs per
   AGENTS.md promotion rules (spec stays in docs/, tmp plans stay — never
   delete); tag `v0.1.0` on the commit.

## Out of scope / later

- HTTP MCP mode, the opt-in dist-patch layer (make stock `qmd` honor config)
  — both deliberately deferred (D3); only if users ask.
- Any feature additions for 0.2.x.

## Risk notes

- **Name squatting window**: closes the moment the first `npm publish` lands
  (even a 0.0.1 placeholder would do, but we have a real 0.1.0 ready — publish
  the real thing).
- **publish irreversibility**: npm versions can't be edited (only unpub within
  72 h / deprecate) — run `npm publish --dry-run` first (agent task 4).
- The weekly CI needs a GitHub token with PR-open scope — standard repo
  `GITHUB_TOKEN` suffices for scheduled workflow → PR.
