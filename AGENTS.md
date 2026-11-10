# qmd-wrapper

## 📖 Documentation

The project documentation is organized into functional categories in the `docs/` directory:

- **[Architecture](docs/arch/)**: High-level system design.
- **[Specifications](docs/specs/)**: Living functional specs.
- **[Development Guides](docs/dev/)**: to be specified
- **[Plugin Guides](docs/docs/)**: to be specified.
- **[ADR Log](docs/adr/index.md)**: The immutable history of architectural decisions.

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

to be specified
