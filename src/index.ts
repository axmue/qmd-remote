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
export { createStoreRemote, defaultQmdDbPath, defaultQmdConfigPath, findLocalQmdIndex } from "./store-remote.js";
export { resolveSecret, isSecretReference, redactSecrets } from "./backend/secrets.js";
export { packageVersion } from "./version.js";
export type { CreateStoreRemoteOptions, QmdStore } from "./store-remote.js";
export { createQmdRemoteMcpServer, InflightGate } from "./mcp.js";
export type { QmdRemoteMcpServerOptions } from "./mcp.js";
export { startQmdRemoteMcpHttpServer } from "./mcp-http.js";
export type { StartHttpServerOptions, HttpServerHandle } from "./mcp-http.js";
export { loadRemoteConfig, defaultConfigPath, QMD_REMOTE_CONFIG_ENV } from "./config-file.js";
export type { RemoteConfig } from "./config-file.js";
// Re-export qmd's public surface (one physical qmd copy for the consumer).
export * from "@tobilu/qmd";
