import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeAgentHost } from "../server/agent-host.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readArguments(argv) {
  let host = null;
  let executable = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host") host = normalizeAgentHost(argv[++index]);
    else if (argument === "--executable") executable = argv[++index]?.trim() || null;
    else throw new Error(`Unknown argument '${argument}'`);
  }
  if (!host) {
    throw new Error("Pass the current coding agent explicitly with --host codex or --host claude-code");
  }
  if (executable?.includes("\0")) throw new Error("Executable path contains an invalid character");
  return { host, executable };
}

const configuration = readArguments(process.argv.slice(2));
const dataDirectory = path.join(projectRoot, ".data");
const configPath = path.join(dataDirectory, "agent-host.json");
await mkdir(dataDirectory, { recursive: true });
await writeFile(
  configPath,
  `${JSON.stringify({ schemaVersion: 1, ...configuration }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);

console.log(`Taskboard is configured for ${configuration.host}.`);
console.log("The setting is local-only under .data and is not shown in the board UI.");
