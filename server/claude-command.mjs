import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const NODE_SCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

function npmClaudeScript(env) {
  return env.APPDATA
    ? path.join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
    : null;
}

export function resolveDefaultClaudeExecutable(env = process.env) {
  const candidates = process.platform === "win32"
    ? [
        env.CLAUDE_CODE_EXECUTABLE,
        env.CLAUDE_EXECUTABLE,
        path.join(os.homedir(), ".local", "bin", "claude.exe"),
        npmClaudeScript(env),
      ]
    : [env.CLAUDE_CODE_EXECUTABLE, env.CLAUDE_EXECUTABLE];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? "claude";
}

export function resolveClaudeInvocation(executable, args, platform = process.platform) {
  if (platform === "win32" && NODE_SCRIPT_EXTENSIONS.has(path.extname(executable).toLowerCase())) {
    return { executable: process.execPath, args: [executable, ...args] };
  }
  return { executable, args };
}

export function isClaudeCliAvailable(executable) {
  const invocation = resolveClaudeInvocation(executable, ["auth", "status"]);
  const result = spawnSync(invocation.executable, invocation.args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  return result.status === 0;
}

export function normalizeClaudeCommandError(error) {
  if (!error || !["EACCES", "EFTYPE", "EINVAL", "ENOENT", "EPERM"].includes(error.code)) {
    return error;
  }
  const wrapped = new Error(
    "Claude Code CLI could not be started. Install Claude Code, run 'claude auth login', or set CLAUDE_CODE_EXECUTABLE to its native executable path.",
    { cause: error },
  );
  wrapped.code = "CLAUDE_CODE_CLI_UNAVAILABLE";
  return wrapped;
}

export function spawnClaudeCommand(executable, args, options = {}) {
  const invocation = resolveClaudeInvocation(executable, args);
  try {
    return spawn(invocation.executable, invocation.args, {
      windowsHide: true,
      ...options,
    });
  } catch (error) {
    throw normalizeClaudeCommandError(error);
  }
}

export function execClaudeCommand(executable, args, options = {}) {
  const invocation = resolveClaudeInvocation(executable, args);
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      windowsHide: true,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        const diagnostic = normalizeClaudeCommandError(error);
        diagnostic.stdout = stdout;
        diagnostic.stderr = stderr;
        reject(diagnostic);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
