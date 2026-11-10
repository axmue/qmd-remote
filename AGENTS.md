# qmd-wrapper

## 📖 Documentation

The project documentation is organized into functional categories in the `docs/` directory:

- **[Specifications](docs/specs/)**: Living functional specs — start with
  [`qmd-remote.md`](docs/specs/qmd-remote.md) (decisions D1–D14; the source
  comments reference them by number).
- **[ADR Log](docs/adr/index.md)**: decisions taken after the spec interview.
- **[Working notes](docs/tmp/)**: phase plans (P1–P6), the local-usage
  walkthrough, code reviews. Kept, never deleted.
- No `docs/arch/` or `docs/dev/` yet — the spec covers the architecture at this
  size; add them when the spec stops being enough.

---


## ✍️ Write early & often

The runtime we work in is not 100% stable — tasks have died mid-flight and hours of
work with them. So: *release early and often* → **write early and often**. Treat
"on disk" as the unit of safety.

Applies to any **non-trivial** task (multi-step: spec/plan/implement/test). A one-line
fix gets no plan file — the rot would outweigh the crash risk.

- **After the interview, before the next step**: when the conversation yields a spec,
  decision, or plan, write it to `docs/tmp/<topic>.md` immediately — chat-only
  thinking is what evaporates.
- **The plan is a living file**: create it with the first part, grow it as the work
  develops. Never hold the whole spec + plan + implementation in context before
  writing the first line.
- **Implementation lands file-by-file**, so a crash leaves partial-but-consistent
  work — never a tower of half-edited files.
- **Commit at green checkpoints** (tests + typecheck pass). Disk survives a session
  crash; only a commit survives the machine — the last green commit is the recovery
  point.
- **On completion**: promote the durable part (spec → `docs/specs/`, decision →
  `data/issues/` or the commit message). Do **not** delete `docs/tmp/` scratch
  files — the agent never removes them (cleanup is a human decision).
  `docs/tmp/` files MAY be committed alongside the code they document (a plan
  that explains a non-obvious change is part of the change) — only omit a file
  that is obviously throwaway scratch.

---


## ✅ Done When

A change is done when all of these are true:

1. `npm run check` is green — that is `typecheck` + `check:mcp-drift` +
   the full test suite (which builds `dist/` first via `pretest`, because the
   CLI and MCP tests spawn the built output).
2. Behavior that the change claims is covered by a test that **fails without
   the change**. Provider traffic goes to the loopback mock
   (`tests/helpers/mock-server.ts`) — the suite stays offline and GPU-free.
3. Anything touching the packaged surface (exports, `bin`, `files`, deps) also
   passes `npm run test:consumer` — the packed tarball driven from a fresh
   consumer project (the publish gate, spec D13).
4. The reasoning lives on disk: a spec/ADR/plan update for a non-obvious
   change, and a comment at the seam for anything that depends on qmd's
   internals (which version, which file, why).
5. Committed at that green point — the last green commit is the recovery point.
