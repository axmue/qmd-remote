/**
 * Package version, read from the shipped package.json (one source of truth —
 * nothing hardcodes a version string). Used by `--version` and as the MCP
 * server's advertised version.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function packageVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    cached = pkg.version ?? "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}
