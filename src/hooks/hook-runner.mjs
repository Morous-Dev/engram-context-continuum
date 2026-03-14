/**
 * hook-runner.mjs — Windows-safe wrapper for ECC hook commands.
 *
 * What this file is: a tiny launcher that injects assistant/project env vars
 * and then spawns the real hook script under Node.
 * Responsible for: removing nested shell quoting from generated Windows hook
 * commands.
 * Depends on: node:child_process.
 * Depended on by: src/adapters/types.ts on Windows.
 */

import { spawn } from "node:child_process";

function parseRunnerArgs(argv) {
  let assistant = "";
  let projectDir = "";
  let scriptPath = "";
  const forwardedArgs = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--") {
      forwardedArgs.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--assistant" && index + 1 < argv.length) {
      assistant = argv[++index];
      continue;
    }
    if (arg.startsWith("--assistant=")) {
      assistant = arg.slice("--assistant=".length);
      continue;
    }
    if (arg === "--project-dir" && index + 1 < argv.length) {
      projectDir = argv[++index];
      continue;
    }
    if (arg.startsWith("--project-dir=")) {
      projectDir = arg.slice("--project-dir=".length);
      continue;
    }
    if (arg === "--script" && index + 1 < argv.length) {
      scriptPath = argv[++index];
      continue;
    }
    if (arg.startsWith("--script=")) {
      scriptPath = arg.slice("--script=".length);
      continue;
    }
  }

  return { assistant, projectDir, scriptPath, forwardedArgs };
}

const { assistant, projectDir, scriptPath, forwardedArgs } = parseRunnerArgs(process.argv.slice(2));

if (!scriptPath) {
  console.error("[engram-cc] Missing --script for hook runner.");
  process.exit(2);
}

const env = { ...process.env };
if (assistant) env.ENGRAM_ASSISTANT = assistant;
if (projectDir) env.ENGRAM_PROJECT_DIR = projectDir;

const child = spawn(process.execPath, [scriptPath, ...forwardedArgs], {
  env,
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", error => {
  console.error(`[engram-cc] Failed to launch hook script: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
