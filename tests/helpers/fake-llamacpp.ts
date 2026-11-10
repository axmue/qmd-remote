/**
 * Fake LlamaCpp for local-job routing tests — records calls, never loads models.
 * Injected via the factory's `llamaCtor` seam.
 */
import type { QmdLlmBackend } from "../../src/backend/types.js";

export class FakeLlamaCpp implements QmdLlmBackend {
  /** instances constructed, so tests can inspect what actually ran. */
  static instances: FakeLlamaCpp[] = [];
  readonly embedModelName: string;
  readonly generateModelName: string;
  readonly rerankModelName: string;
  calls: string[] = [];
  constructor(
    readonly ctorConfig?: Record<string, unknown>,
    names?: { embed?: string; generate?: string; rerank?: string },
  ) {
    this.embedModelName = names?.embed ?? "fake:embed-model";
    this.generateModelName = names?.generate ?? "fake:generate-model";
    this.rerankModelName = names?.rerank ?? "fake:rerank-model";
    FakeLlamaCpp.instances.push(this);
  }
  async embed(text: string) {
    this.calls.push("embed");
    return { embedding: [1, 1, 1], model: this.embedModelName };
  }
  async embedBatch(texts: string[]) {
    this.calls.push("embedBatch");
    return texts.map(() => ({ embedding: [1, 1, 1], model: this.embedModelName }));
  }
  async generate(prompt: string) {
    this.calls.push("generate");
    return { text: prompt, model: this.generateModelName, done: true };
  }
  async expandQuery(query: string) {
    this.calls.push("expandQuery");
    return [{ type: "lex" as const, text: query }];
  }
  async rerank(_query: string, documents: { file: string }[]) {
    this.calls.push("rerank");
    return { results: documents.map((d, i) => ({ file: d.file, score: 1, index: i })), model: this.rerankModelName };
  }
  async modelExists(uri: string) {
    return { name: uri, exists: true };
  }
  async tokenize(text: string) {
    this.calls.push("tokenize");
    return [42];
  }
  async countTokens(text: string) {
    return 1;
  }
  async detokenize() {
    return "fake";
  }
  async getDeviceInfo() {
    return { gpu: "fake-gpu", gpuOffloading: true, gpuDevices: ["fake-gpu"], cpuCores: 4 };
  }
  async dispose() {
    this.calls.push("dispose");
  }
}
