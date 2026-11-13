# ADR log

qmd-remote's architectural decisions live in the spec as a decision table
(D1–D14), because they were taken in one interview and are cross-referenced by
every phase plan and by comments in the source:

→ **[`docs/specs/qmd-remote.md`](../specs/qmd-remote.md)** — decisions D1–D14.

Decisions taken *after* that interview get an entry here.

| ADR | Date | Decision | Status |
|---|---|---|---|
| [0001](0001-review-fixes.md) | 2026-11-10 | Secret indirection, provider retries, soft-fallback boundary for query expansion, project-local index discovery | accepted |
| [0002](0002-http-mcp-transport.md) | 2026-11-13 | Native Streamable-HTTP MCP transport (`mcp --http`), mirroring qmd's `startMcpHttpServer`; Host-guard + optional bearer; no new dependency | accepted |
