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
| [0003](0003-global-default-seam.md) | 2026-11-19 | Close the second seam: qmd's global default LlamaCpp (`setDefaultLlamaCpp`) — the `embed` chunking-tokenizer path leaked a 318 MB model download on clean machines (CI "runs forever") | superseded by 0004 (hole closed upstream in 2.9.0; workaround retired) |
| [0004](0004-qmd-2-9-0-upgrade.md) | 2026-11-21 | qmd 2.9.0: keep the full remote backend (embed stays ours), retire the global-default seam, adopt the metadata surface (MCP `metadata` tool + `filter`, CLI parity) | accepted |
