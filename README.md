# codex-kanban

A local-first issue board for Codex and Claude Code. Both use the same board and workflow: publish work into backlog, move selected work to todo, let the configured local Agent claim it, then inspect the linked conversation from done or blocked. The Agent type is installation detail and is never shown as a selector in the UI.

## Requirements

- Node.js 22.5 or newer

## Let your coding Agent install it

Download or clone the repository, open it in Codex or Claude Code, and ask:

> 安装并启动这个任务看板。

The repository contains `AGENTS.md` and `CLAUDE.md`. The current Agent uses the matching instruction file, explicitly records its own host type under the ignored `.data` directory, installs dependencies, builds the UI, and starts the same local server. It does not guess from other CLIs installed on the machine.

Manual equivalents:

```bash
# When Codex is doing the installation
npm run setup:codex

# When Claude Code is doing the installation
npm run setup:claude

npm install
npm run build
npm start
```

Open <http://127.0.0.1:47823>. The SQLite database and hidden host setting are stored under `.data/`. No Codex or Claude login credential is copied into Taskboard.

## Run locally for development

```bash
npm install
npm run build
npm start
```

For development with live frontend reload:

```bash
npm run dev
```

The Vite UI runs at <http://127.0.0.1:5173> and proxies API requests to the local service.

## Use the CLI

Run it from the project:

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

Use `npm link` if you want `taskctl` on your shell path. Set `CODEX_TASKBOARD_URL` to point the CLI at another local or LAN service. Cloud deployments are configured through the loopback companion with `taskctl cloud login`.

## Install the Codex Skill manually

Copy or symlink `skills/manage-taskboard` into the Codex skills directory, then start a new Codex task:

```bash
ln -s /absolute/path/to/codex-kanban/skills/manage-taskboard \
  ~/.codex/skills/manage-taskboard
```

The Skill teaches Codex to inspect an issue, move it to `in_progress`, use optimistic versions, verify the work, and then move it to `in_review`; it moves the issue to `done` only after the user explicitly confirms acceptance or asks to mark it complete.

## Windows

Install Node.js 22.5 or newer and either a signed-in standalone Codex CLI or Claude Code. The recommended path is to let that Agent follow the installation instructions above.

To configure and start manually with Codex:

```powershell
npm install
npm run build
npm run setup:codex
$env:CODEX_TASKBOARD_HOST = "127.0.0.1"
npm start
```

With Claude Code, replace `npm run setup:codex` with `npm run setup:claude`. Keep the terminal running while using the board. Automatic execution uses the current Agent's official CLI login and does not bypass its permission system. If the CLI is installed in a custom location, set `CODEX_EXECUTABLE` or `CLAUDE_CODE_EXECUTABLE` to its native executable or Node entry script.

The Microsoft Store Codex app does not expose its packaged `codex.exe` as a normal external CLI, so Codex-based AI Chat and server-side automatic claiming require a standalone Codex CLI such as `npm install --global @openai/codex`.

For a project-private installation under `.data/tools`, launch with `start-taskboard-windows.cmd`. It uses the private Node.js and Codex CLI without changing the system PATH. On the first run it opens the official Codex sign-in flow; after authorization it starts Taskboard automatically.

The **自动认领待办** menu is backed by the local Taskboard service on Windows. Once enabled, it keeps working while the browser page is closed as long as the Taskboard service is running. The polling interval can be set as low as 5 seconds, and each project runs at most one automatic task at a time. The scheduler skips todos with unfinished blockers, reserves the selected task, starts a linked Agent conversation in that project's working directory, and moves the task to `in_progress` only after the Agent process has actually started. A successful run moves the task to done; a launch or execution failure moves it to blocked and records the error.

Install the Taskboard Skill for the Windows Codex app with:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex\skills" | Out-Null
Copy-Item -Recurse -Force ".\skills\manage-taskboard" "$env:USERPROFILE\.codex\skills\manage-taskboard"
```

Restart Codex after copying the Skill. The browser board, Skill/CLI workflow, and Taskboard server-side automatic claiming are supported on Windows. The CDP-injected sidebar panel and Codex App's native automation bridge remain macOS-only because the Windows Store app cannot currently be relaunched by this project with Electron remote-debugging flags.

## Embed in Codex

### Recommended: keep your current window and open a separate Taskboard window

Keep the existing Codex window open. From the Taskboard repository, start a second Codex instance with a dedicated CDP port:

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

After the new Codex window appears, run the injector in another terminal:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

Keep the injector terminal running while using the embedded panel. The original Codex window remains unchanged, and the new window receives the Taskboard sidebar entry. If port `9231` is occupied, use another port in both commands.

### Alternative: restart Codex with the standalone launcher

Quit every running Codex window, then run:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

This starts the local Taskboard service when needed, launches the official macOS Codex app with a loopback-only CDP port, injects a native-looking Taskboard entry after Plugins, and keeps watching both the service and replacement renderers. Opening Taskboard asks this launcher to health-check the fixed local service, restart it when needed, and rebuild a failed iframe. Keep this command running while using the embedded panel. The launcher does not modify `ChatGPT.app` or its `app.asar`.

Codex 26.715.52143 ships a renderer CSP that blocks arbitrary HTTP iframes. The launcher therefore enables CDP CSP bypass, reloads that renderer once, installs the document-start script, and waits until the Taskboard OOPIF is actually loaded. CDP is unauthenticated to other processes on the same machine, so only run trusted local code while the launcher is active.

To inject into a Codex instance that was already launched with CDP by another method, run:

```bash
npm run codex:inject -- --port 9229 --open
```

This command also stays resident so the injected tab can restart Taskboard after a service exit. Stop it with `Ctrl-C`.

The script adds a Taskboard entry to the Codex sidebar and renders the iframe across Codex's complete main workspace, including the contextual titlebar area so Taskboard's own header does not leave an empty strip. That full rectangular header is placed above Electron's draggable layer and marked `no-drag`; because the native contextual actions are suppressed while Taskboard is active, its own actions use their normal edge padding without an artificial right-side gap. The native sidebar stays mounted, while the previous page selection and contextual header are temporarily suppressed; choosing another Codex page restores them.

“在对话中打开” selects the corresponding native Codex project when one is available and opens an unsent native composer with `$manage-taskboard ISSUE-ID`. A conversation is attributed only after it actually processes the issue: `taskctl` reads Codex's `CODEX_THREAD_ID` and records that ID on the issue or comment mutation. Recorded IDs are clickable through Codex's native route bridge. Each issue can bind either one Git branch or one worktree; the options are scanned from the selected Codex project's repository instead of being typed by hand. The integration uses Codex's existing project, composer, and route markers; it does not patch React, replace `fetch`, load private chunks, or edit Codex data files.

To use a different UI origin, set `window.__CODEX_TASKBOARD_URL__` before the user script runs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP bind address; use `127.0.0.1` to disable LAN access |
| `CODEX_TASKBOARD_PORT` | `47823` | Local HTTP port |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite data directory |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API origin |
| `CODEX_EXECUTABLE` | `codex` | Executable Codex CLI path; on Windows it may also point to the standalone package's `codex.js` |
| `CLAUDE_CODE_EXECUTABLE` | `claude` | Executable Claude Code CLI path; on Windows it may also point to the package's `cli.js` |
| `TASKBOARD_AGENT_HOST` | local setup value or `codex` | Internal override: `codex` or `claude-code`; not exposed in the UI |

`npm start` prints both the local URL and the available LAN URLs. Teammates on the same trusted network can open one of those LAN URLs and use the same taskboard service. Task, comment, and attachment changes are broadcast to every open client through server-sent events; reconnecting clients perform a full refresh so changes made while disconnected are not missed. A teammate using `taskctl` can point it at the shared service with `CODEX_TASKBOARD_URL=http://<host-ip>:47823`.

LAN mode has no account authentication: anyone on the trusted local network who can reach the URL can read and write the taskboard. Public internet and cloud deployment require an authenticated deployment boundary.

## Share through Cloudflare

For two trusted collaborators, the taskboard can run on Cloudflare with Worker Static Assets and API routes, D1 as the authoritative business database, and a private R2 bucket for attachments. The deployment uses HTTPS Basic Authentication with a shared password and refreshes open boards after a global revision changes.

Each device keeps its own project checkout mapping and continues to use a local companion for Codex, Git/worktree, Skill, and MCP capabilities. Cloud mode never falls back to or double-writes the local SQLite database.

See [Cloud collaboration](docs/cloud-collaboration.md) for owner deployment, existing GitHub installation setup, password rotation, local path mapping, and the one-time local-data migration flow.

## Verify

```bash
npm run check
```

This runs TypeScript checking, a production frontend build, and the server/CLI/injection test suite.
