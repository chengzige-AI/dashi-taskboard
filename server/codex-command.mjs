import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const NODE_SCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

export function resolveDefaultCodexExecutable(projectRoot, env = process.env) {
  if (process.platform !== "win32") return "codex";
  const candidates = [
    path.join(
      projectRoot,
      ".data",
      "tools",
      "codex",
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    ),
    path.join(projectRoot, "node_modules", "@openai", "codex", "bin", "codex.js"),
    env.APPDATA
      ? path.join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
      : null,
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? "codex";
}

export function isCodexCliAvailable(executable, platform = process.platform) {
  if (platform !== "win32") return true;
  if (path.isAbsolute(executable)) {
    return existsSync(executable)
      && ![".bat", ".cmd", ".ps1"].includes(path.extname(executable).toLowerCase())
      && !/[\\/]WindowsApps[\\/]OpenAI\.Codex_/i.test(executable);
  }
  const result = spawnSync("where.exe", [executable], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return false;
  return result.stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .some((candidate) => (
      ![".bat", ".cmd", ".ps1"].includes(path.extname(candidate).toLowerCase())
      && !/[\\/]WindowsApps[\\/]OpenAI\.Codex_/i.test(candidate)
    ));
}

export function normalizeCodexCommandError(error) {
  if (
    process.platform !== "win32"
    || !["EACCES", "EFTYPE", "EINVAL", "ENOENT", "EPERM"].includes(error?.code)
  ) return error;
  const wrapped = new Error(
    "Codex CLI could not be started on Windows. Install the standalone @openai/codex CLI or set CODEX_EXECUTABLE to an executable Codex CLI path; the Microsoft Store app's internal codex.exe cannot be used as an external CLI.",
    { cause: error },
  );
  wrapped.code = "CODEX_CLI_UNAVAILABLE";
  return wrapped;
}

export function resolveCodexInvocation(executable, args, platform = process.platform) {
  if (
    platform === "win32"
    && NODE_SCRIPT_EXTENSIONS.has(path.extname(executable).toLowerCase())
  ) {
    return {
      executable: process.execPath,
      args: [executable, ...args],
    };
  }
  return { executable, args };
}

export function spawnCodexCommand(executable, args, options = {}) {
  const invocation = resolveCodexInvocation(executable, args);
  try {
    return spawn(invocation.executable, invocation.args, {
      windowsHide: true,
      ...options,
    });
  } catch (error) {
    throw normalizeCodexCommandError(error);
  }
}

export function execCodexCommand(executable, args, options = {}) {
  const invocation = resolveCodexInvocation(executable, args);
  return new Promise((resolve, reject) => {
    try {
      execFile(invocation.executable, invocation.args, {
        windowsHide: true,
        ...options,
      }, (error, stdout, stderr) => {
        if (error) {
          const diagnostic = normalizeCodexCommandError(error);
          diagnostic.stdout = stdout;
          diagnostic.stderr = stderr;
          reject(diagnostic);
          return;
        }
        resolve({ stdout, stderr });
      });
    } catch (error) {
      reject(normalizeCodexCommandError(error));
    }
  });
}
