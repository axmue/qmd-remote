# qmd-remote

Remote model backend for [qmd](https://github.com/tobit/qmd): point its three model
jobs — **embed**, **rerank**, **query-expansion** — at OpenAI-compatible endpoints
(OpenRouter, Jina, …) or a local Ollama server, per job. Keep qmd's indexer,
chunker, and hybrid search; swap only the models. No GPU or GGUF downloads needed
for remote jobs.

> Unofficial. Not affiliated with tobit/qmd. Depends on stock, unmodified
> `@tobilu/qmd`; the backend adapters are original code (MIT).

**Under construction** — see `docs/tmp/qmd-remote-package-spec.md` for the full design.
