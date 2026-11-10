/**
 * qmd-remote — public entry.
 *
 * Two doors:
 *   - `createBackend(jobs)` — the model-backend object implementing qmd's
 *     duck-typed LLM surface (set it as `store.internal.llm` on a qmd store;
 *     the config-file-loading + store helper `createStoreRemote` is P2).
 *   - qmd's own public surface, re-exported — one module for users, one
 *     physical copy of @tobilu/qmd.
 */
export * from "./backend/types.js";
export * from "./backend/config.js";
export { createBackend } from "./backend/factory.js";
export type { QmdBackendOptions, QmdLlamaCppCtor } from "./backend/factory.js";
export {
  OpenAiCompatAdapter,
} from "./backend/adapters/openai-compat.js";
export {
  OllamaAdapter,
  DEFAULT_OLLAMA_BASE_URL,
} from "./backend/adapters/ollama.js";
// Re-export qmd's public surface (one physical qmd copy for the consumer).
export * from "@tobilu/qmd";
