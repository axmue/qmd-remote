# Subagent Workflow

The standard for using pi subagents to implement plans in this repo: a parent
(agent session) stays in control — it interviews, plans, dispatches workers,
integrates, commits, and reviews. Subagents do the muscle; the parent does
the judgment.

Powered by pi's **bundled example extension**
(`examples/extensions/subagent/` in the `@earendil-works/pi-coding-agent`
package), installed by symlinking `index.ts` + `agents.ts` into
`~/.pi/agent/extensions/subagent/`. After a pi version upgrade, check that
the symlinks still resolve. It registers the `subagent` tool.

Each subagent run spawns a separate `pi --mode json -p --no-session` process
with the agent's body appended to its system prompt — so children inherit the
project's `AGENTS.md` and run in an isolated context window.

## Agents

Repo-specific agents live in **`.pi/agents/`** (committed; the rest of `.pi/`
is gitignored). Each file: YAML frontmatter (`name`, `description`, optional
`tools`, optional `model` — omitted here so subagents inherit the active
model) + the system-prompt body.

| Agent | Role | Tools |
|-------|------|-------|
| `scout` | Fast read-only codebase recon; returns compressed context for handoff | read, grep, find, ls, bash (read-only) |
| `planner` | Spec/requirements → plan; writes the plan to `docs/tmp/<topic>-plan.md` (living file) | read-only on code + write/edit for the plan file |
| `worker` | One part of an approved plan; `npm run check` green before reporting; **never commits** | all |
| `reviewer` | Verification + spec→plan→implementation fidelity review; writes a durable review file | read-only + write for the review file |

## Calling the tool

Important: the tool's default `agentScope` is `"user"` (agents from
`~/.pi/agent/agents/` only). **Always pass `agentScope: "both"`** so the
repo agents in `.pi/agents/` are discovered (in interactive sessions the
tool confirms project agents on first use).

- **Single**: `subagent({ agent: "scout", task: "Find all code touching the MCP request lifecycle", agentScope: "both" })`
- **Parallel** (independent plan slices): `subagent({ tasks: [{ agent: "worker", task: "…" }, …], agentScope: "both" })` — **max 2 tasks** (machine concurrency cap, see guardrails; the extension's own ceiling is 8 tasks / 4 concurrent — larger independent sets go as several sequential batches of 2).
- **Chain** (sequential handoff): `subagent({ chain: [{ agent: "scout", task: "…" }, { agent: "planner", task: "Plan for: {previous}" }], agentScope: "both" })` — each step receives the previous step's output as `{previous}`. Stops at the first failure.

Results return to the parent with the subagent's final output (50 KB cap per
task) plus turns/tokens/cost; failures return stderr diagnostics. Ctrl+C
kills the children.

## The standard flow

1. **Interview → spec.** Requirements and decisions land in
   `docs/specs/qmd-remote.md` (durable; decisions numbered D1–D14) or
   `docs/tmp/<topic>.md` (in flight).
   The parent does this — subagents don't interview.
2. **Plan.** Chain `scout` → `planner`, or spawn `planner` directly with
   specs/context. It writes `docs/tmp/<topic>-plan.md` with ordered steps, an
   explicit *Parallelizable Parts* section, files (incl. `tests/`), and
   verification commands. The parent reviews the plan with the user before
   dispatching.
3. **Implement.** Per the plan's Parallelizable Parts:
   - independent slices → `tasks` parallel mode, one `worker` per slice —
     **max 2 tasks** (concurrency cap, see guardrails); file sets must be
     disjoint — more independent slices → several sequential batches of 2;
   - sequential slices → separate single calls, one at a time.
   Each worker reports Completed / Files Changed / Tests / Deviations /
   Left Open.
4. **Integrate & commit (parent only).** After reports land: run
   `npm run check` in the parent, resolve overlaps, commit at the green
   checkpoint (see AGENTS.md → *Done When*). Deviations get folded into the
   plan file, which stays the single source of truth for the work.
5. **Review.** Spawn `reviewer` with: spec path, plan path, topic + date,
   commit range (or "uncommitted working tree"). It returns a compact
   verdict and writes the full review to
   `docs/tmp/<YYYY-MM-DD>-<topic>-implementation-review.md`.
6. **Close the loop.**
   - Critical findings → fix (worker or parent), re-verify, commit.
   - *Undocumented decisions* and *Improvements for next time* → fold the
     durable parts back into `docs/specs/`, `docs/tmp/` plans, or
     the commit message. Reviews are quality-control artifacts: keep them,
     never delete (same rule as `docs/tmp/` scratch); the parent commits
     them alongside the code.
   - Warnings/suggestions without a plan to act on → note in the review's
     "Improvements for next time" and move on; do not expand scope.

## Long jobs (multi-hour)

Code-verified facts about durations:

- **No job-level wall-clock timeout exists** in pi or in the example
  extension (the only timer is a 5 s SIGTERM→SIGKILL escalation *on user
  abort*). A job is a sequence of model requests; each is bounded by
  `retry.provider.timeoutMs` in `~/.pi/agent/settings.json` — a multi-hour
  job is many requests, each well under the limit.
- The 30-min cuts seen with the former pi-subagents package were
  mastermind's **30-min idle unload** hitting the unload/reload path
  (unload ≠ unavailable — the next request cold-loads the model), not a pi
  timeout. Documented in `docs/dev/known-issues.md` KI-007 in the
  axel-agent repo (the machine-level constraint applies to this repo too).
- While the tool runs, the **parent session is blocked but nothing is
  in flight on its side** — no LLM request, no timeout; it can wait for
  hours. **You** watch progress live in the TUI (per-task status, streamed
  tool calls; Ctrl+O expands the result).
- Caveats, stated once: the **parent model cannot act while blocked** (it
  resumes when the tool returns); **Esc, a parent-session crash, or
  machine sleep kills the child** (SIGTERM→SIGKILL). For very long jobs:
  start them when the session can be left alone, keep the machine awake,
  and prefer several medium jobs over one huge one — a killed job only
  loses its own slice.

## Guardrails

- **Concurrency cap: max 2 subagents running at once** (mastermind must
  not serve concurrent model loads — see KI-007 in the axel-agent repo):
  **max 2 tasks per `tasks` array**; chains and single calls are sequential.
  While the `subagent` tool runs, the main agent is by definition waiting,
  so 2 is the standing limit — do not stack another model-consuming pi
  session on top of 2 subagents.
- **`agentScope: "both"` every time** — without it, the repo agents are
  invisible to the tool.
- **Subagents never commit or push.** Only the parent commits, at green
  checkpoints, so commit history stays a single-author recovery story
  (see the write-early rules in AGENTS.md).
- **Parallel only for disjoint file sets.** Two workers editing the same
  file race. When in doubt, run them sequentially (or as a chain).
- **One mechanism.** Subagents via the bundled example extension's `subagent`
  tool — don't add a second subagent tool or package.
- **Environment problems → ask.** If a subagent reports an environmental
  failure (model host, keys, network), the parent asks the user — it does
  not probe.
- **Context hygiene.** Give subagents paths, not pasted file contents, and
  keep their tasks to one plan slice. Use `scout` (or a chain starting with
  it) when the subagent will need codebase context it doesn't have yet.
- **Stay offline & GPU-free.** Workers writing tests route provider traffic
  to the loopback mock (`tests/helpers/mock-server.ts`); no worker may
  start a real provider session as part of a test.

## Failure handling

- A failed subagent returns an error with preserved stderr/output; the
  parent reads it before retrying. Retrying the same task twice without a
  change is not a fix.
- Chain mode stops at the first failing step and says which step failed.
- Parallel mode keeps separate 50 KB budgets per task; oversized results are
  truncated — ask the subagent for a shorter final section if the tail got
  cut.
- Reviews with verdict *Rework needed* block the commit step: the plan gets
  updated first, then implementation continues.
