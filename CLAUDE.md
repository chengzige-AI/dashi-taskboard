# Claude Code project instructions

Follow `AGENTS.md` for repository development rules.

## First-time Taskboard installation

When the user asks you to install, configure, or start this Taskboard, configure the local execution host explicitly as Claude Code before starting it. Do not choose a host by checking which CLIs happen to be installed.

```powershell
node scripts/setup-agent-host.mjs --host claude-code
npm install
npm run build
npm start
```

On macOS or Linux, the commands are the same. Keep `npm start` running while the board is in use. Claude Code must already be installed and signed in with `claude auth login`; Taskboard never stores or copies Claude credentials.

Do not add an Agent selector to the UI. The server-owned `.data/agent-host.json` setting is the only host selection for this installation.
