import { readFileSync } from "node:fs";
import path from "node:path";

export const AGENT_HOSTS = new Set(["codex", "claude-code"]);

export function normalizeAgentHost(value) {
  const host = String(value ?? "").trim().toLowerCase();
  if (host === "claude" || host === "claude_code") return "claude-code";
  return AGENT_HOSTS.has(host) ? host : null;
}

export function readAgentHostConfig(dataDirectory, env = process.env) {
  const explicitHost = normalizeAgentHost(env.TASKBOARD_AGENT_HOST);
  if (explicitHost) {
    return {
      host: explicitHost,
      executable: env.TASKBOARD_AGENT_EXECUTABLE?.trim() || null,
      source: "environment",
    };
  }

  const configPath = path.join(dataDirectory, "agent-host.json");
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    const host = normalizeAgentHost(parsed?.host);
    if (!host) throw new Error("Unsupported agent host");
    return {
      host,
      executable: typeof parsed.executable === "string" && parsed.executable.trim()
        ? parsed.executable.trim()
        : null,
      source: configPath,
    };
  } catch {
    return { host: "codex", executable: null, source: "default" };
  }
}
