#!/usr/bin/env node
/**
 * ekilo — Engram-CC wrapper for Kilo CLI.
 *
 * Runs the Kilo wrapper lifecycle for EngramCC:
 *   1. prepares project-local context before launch
 *   2. launches Kilo in the target project
 *   3. writes the normal ECC stop handoff after Kilo exits
 *
 * This is the supported Kilo integration path until Kilo exposes native hooks.
 *
 * Usage:
 *   ekilo              # Start new session
 *   ekilo --continue   # Continue previous session
 *   ekilo --project-dir <path>
 *   ekilo "prompt"     # Run prompt in auto mode
 *   ekilo --help       # Show help
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = __dirname;
const HOOKS_DIR = join(PACKAGE_ROOT, "src", "hooks");
const STOP_HOOK_PATH = join(PACKAGE_ROOT, "build", "hooks", "stop.js");
const SESSIONSTART_PATH = join(HOOKS_DIR, "kilo-sessionstart.mjs");

function log(msg) {
  console.error(`[ekilo] ${msg}`);
}

function ensureKiloConfig(projectDir) {
  const configPath = join(projectDir, ".kilocode", "opencode.json");
  const configDir = join(projectDir, ".kilocode");

  let config = {};

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (err) {
      log(`Warning: failed to parse existing ${configPath}; preserving only safe defaults (${err.message})`);
      config = {};
    }
  }

  // Add instructions if not present
  const contextFile = ".engram-cc/kilo-context.md";
  const instructions = Array.isArray(config.instructions) ? [...config.instructions] : [];
  const mcp = config.mcp && typeof config.mcp === "object" ? { ...config.mcp } : {};
  const engramMcp = mcp["engram-cc"] && typeof mcp["engram-cc"] === "object"
    ? { ...mcp["engram-cc"] }
    : {};
  const desiredCommand = ["node", join(PACKAGE_ROOT, "build", "mcp", "server.js")];
  let changed = false;

  if (!instructions.includes(contextFile)) {
    instructions.push(contextFile);
    config.instructions = instructions;
    changed = true;
    log(`Added ${contextFile} to Kilo instructions`);
  }

  const commandMatches = Array.isArray(engramMcp.command)
    && engramMcp.command.length === desiredCommand.length
    && engramMcp.command.every((value, index) => value === desiredCommand[index]);

  if (
    engramMcp.type !== "local"
    || engramMcp.enabled !== true
    || !commandMatches
  ) {
    mcp["engram-cc"] = {
      type: "local",
      command: desiredCommand,
      enabled: true,
    };
    config.mcp = mcp;
    changed = true;
    log("Updated Kilo MCP config for EngramCC");
  }

  if (changed) {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  }
}

function getFlagValue(args, flag) {
  const prefixed = `${flag}=`;
  const inline = args.find(arg => arg.startsWith(prefixed));
  if (inline) return inline.slice(prefixed.length);

  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function resolveProjectRoot(args) {
  const requested = getFlagValue(args, "--project-dir");
  const projectRoot = resolve(requested || process.cwd());
  if (!existsSync(projectRoot)) {
    throw new Error(`Project directory does not exist: ${projectRoot}`);
  }
  if (!statSync(projectRoot).isDirectory()) {
    throw new Error(`Project directory is not a folder: ${projectRoot}`);
  }
  return projectRoot;
}

function getKiloCommand() {
  return process.env.ENGRAM_KILO_BIN || "kilo";
}

function canRunKilo(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

async function runHook(hookPath, projectRoot, sessionId) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [hookPath], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ENGRAM_ASSISTANT: "kilo-cli",
        ENGRAM_PROJECT_DIR: projectRoot,
        ENGRAM_SESSION_ID: sessionId,
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        log(`hook exited with code ${code}: ${stderr}`);
        resolve({ stdout, stderr, code });
      }
    });

    child.on("error", (err) => {
      log(`hook error: ${err.message}`);
      resolve({ stdout: "", stderr: err.message, code: -1 });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const projectRoot = resolveProjectRoot(args);
  const kiloCommand = getKiloCommand();
  const sessionId = process.env.ENGRAM_SESSION_ID || `kilo-${randomUUID()}`;

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Engram-CC Wrapper for Kilo CLI

Usage:
  ekilo              Start new session
  ekilo --continue   Continue previous session
  ekilo --new        Start fresh session (clear context)
  ekilo --project-dir <path>
  ekilo "prompt"     Run prompt in autonomous mode
  ekilo --help       Show this help

This wrapper automatically:
  1. Loads previous session context from <project>/.engram-cc/
  2. Launches Kilo inside the target project directory
  3. Saves session context when Kilo exits
`);
    process.exit(0);
  }

  // Determine Kilo arguments
  const kiloArgs = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--continue" || arg === "-c") {
      kiloArgs.push(arg);
    } else if (arg === "--new") {
      kiloArgs.push(arg);
    } else if (arg === "--project-dir") {
      index += 1;
    } else if (arg.startsWith("--project-dir=")) {
      continue;
    } else {
      kiloArgs.push(arg);
    }
  }

  // Check if kilo is installed
  if (!canRunKilo(kiloCommand)) {
    log(`Error: unable to run Kilo command "${kiloCommand}".`);
    log("Install it with: npm install -g @kilocode/cli or set ENGRAM_KILO_BIN to the correct executable.");
    process.exit(1);
  }

  // Ensure Kilo config includes the context file
  ensureKiloConfig(projectRoot);

  // Run sessionstart hook to load context
  log("Loading session context...");
  if (existsSync(SESSIONSTART_PATH)) {
    await runHook(SESSIONSTART_PATH, projectRoot, sessionId);
  } else {
    log("Warning: kilo-sessionstart.mjs not found, skipping context load");
  }

  log(`Launching Kilo in ${projectRoot}...`);
  const kilo = spawn(kiloCommand, kiloArgs, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      ENGRAM_ASSISTANT: "kilo-cli",
      ENGRAM_PROJECT_DIR: projectRoot,
      ENGRAM_SESSION_ID: sessionId,
    },
  });

  // Wait for Kilo to exit
  const exitCode = await new Promise((resolve) => {
    kilo.on("close", (code) => resolve(code));
    kilo.on("error", (err) => {
      log(`Kilo error: ${err.message}`);
      resolve(-1);
    });
  });

  // Run stop hook to save context
  log("Saving session context...");

  if (existsSync(STOP_HOOK_PATH)) {
    const assistant = "kilo-cli";

    // Build stop hook input
    const stopInput = {
      assistant,
      project_id: projectRoot,
      project_dir: projectRoot,
      session_id: sessionId,
      event_type: "stop",
      source_kind: "wrapper",
      confidence: "exact",
      payload: { kind: "stop" },
      timestamp: new Date().toISOString(),
    };

    const stopChild = spawn("node", [STOP_HOOK_PATH], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ENGRAM_ASSISTANT: assistant,
        ENGRAM_PROJECT_DIR: projectRoot,
        ENGRAM_SESSION_ID: sessionId,
      },
    });

    stopChild.stdin.write(JSON.stringify(stopInput));
    stopChild.stdin.end();

    let stderr = "";
    stopChild.stderr.on("data", (data) => { stderr += data; });
    
    const stopCode = await new Promise((resolve, reject) => {
      stopChild.on("close", resolve);
      stopChild.on("error", reject);
    });

    if (stopCode === 0) {
      log("Session context saved");
    } else {
      log(`Warning: stop hook exited with code ${stopCode}`);
      if (stderr.trim()) log(stderr.trim());
    }
  } else {
    log("Warning: stop.js not found, skipping context save");
  }

  log(`Kilo exited with code ${exitCode}`);
  process.exit(exitCode || 0);
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
