import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistrationResult } from "./types.js";

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trimEnd() + "\n";
}

export function writeLocalAdapterArtifact(
  projectRoot: string,
  adapterSlug: string,
  fileName: string,
  label: string,
  content: string,
): RegistrationResult {
  try {
    const dir = join(projectRoot, ".engram-cc", "assistant-configs", adapterSlug);
    mkdirSync(dir, { recursive: true });

    const path = join(dir, fileName);
    const normalized = normalizeContent(content);
    const existing = existsSync(path) ? readFileSync(path, "utf-8") : null;

    if (existing === normalized) {
      return {
        success: true,
        skipped: true,
        message: `${label} already current at ${path}`,
      };
    }

    writeFileSync(path, normalized, "utf-8");
    return {
      success: true,
      skipped: false,
      message: `${label} written to ${path}`,
    };
  } catch (err) {
    return { success: false, skipped: false, message: `Failed: ${String(err)}` };
  }
}

export function getSrcHooksDir(packageRoot: string): string {
  return join(packageRoot, "src", "hooks").replace(/\\/g, "/");
}

export function getBuildHooksDir(packageRoot: string): string {
  return join(packageRoot, "build", "hooks").replace(/\\/g, "/");
}

export function getMcpServerPath(packageRoot: string): string {
  return join(packageRoot, "build", "mcp", "server.js").replace(/\\/g, "/");
}
