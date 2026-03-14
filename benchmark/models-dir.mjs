import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

function getRuntimeProjectDir(fallback = process.cwd()) {
  return process.env.ENGRAM_PROJECT_DIR
    || process.env.GEMINI_PROJECT_DIR
    || process.env.CLAUDE_PROJECT_DIR
    || fallback;
}

function getProjectConfig(projectDir) {
  const configPath = join(projectDir, '.engram-cc', 'config.json');
  if (!existsSync(configPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function getBenchmarkModelsDir(projectDir = getRuntimeProjectDir()) {
  const runtimeProjectDir = getRuntimeProjectDir(projectDir);
  const configured = getProjectConfig(runtimeProjectDir).sharedModelsDir?.trim();
  if (!configured) {
    throw new Error(
      `Shared models directory is not configured for ${runtimeProjectDir}. Run engramcc --project-dir "${runtimeProjectDir}" --models-dir <path>.`,
    );
  }

  return isAbsolute(configured) ? configured : resolve(runtimeProjectDir, configured);
}
