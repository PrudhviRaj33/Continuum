# Continuum — Claude Setup Guide

How to wire Continuum to every Claude surface (VS Code extension, desktop app) automatically — no manual file editing required.

---

## Quick Start

```bash
node scripts/setup-claude.js /path/to/project1 /path/to/project2 ...
```

Then:
- **VS Code** — fully quit (`Cmd+Q`) and reopen
- **Desktop app** — restart the Claude app
- Ask Claude _"what tools do you have?"_ — you should see all 10 Continuum tools

That's it. No files are written to your project folders.

---

## Example

```bash
node scripts/setup-claude.js \
  /Users/me/Desktop/MyProject/Datanitiv.OneView.WebAPI \
  /Users/me/Desktop/MyProject/Datanitiv.OneView.WebAPP \
  /Users/me/Desktop/MyProject/Databaseapp
```

Or via npm:

```bash
npm run setup-claude -- /path/to/project1 /path/to/project2
```

---

## What the Script Does

The script writes to **three global config files only** — nothing touches your project folders:

| File | Surface | What it does |
|------|---------|--------------|
| `~/.claude.json` | VS Code Claude Code extension | Registers Continuum as an MCP server |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | Claude desktop app | Registers Continuum as an MCP server |
| `~/.claude/CLAUDE.md` | All Claude sessions | Instructs Claude to always prefer Continuum tools over reading files |

---

## Why Not `.mcp.json` in Project Folders?

We investigated this thoroughly. Here is what each config file actually does:

| File | Who reads it | Works for VS Code? |
|------|--------------|--------------------|
| `.mcp.json` in project root | Claude Code CLI (terminal only) | ❌ No |
| `~/.claude/settings.json` | Claude Code CLI (no `mcpServers` field — invalid) | ❌ No |
| `~/.claude/mcp.json` | Nobody (not a valid location) | ❌ No |
| **`~/.claude.json` → `mcpServers`** | **VS Code Claude Code extension** | ✅ Yes |
| `claude_desktop_config.json` | Claude desktop app | ✅ Yes (desktop only) |

The VS Code extension reads MCP servers from `~/.claude.json`, not from any project-level file. Writing `.mcp.json` to project folders has no effect on the extension.

---

## Adding a New Project Later

Run the script again with the new path included alongside the existing ones:

```bash
node scripts/setup-claude.js \
  /path/to/existing/project1 \
  /path/to/existing/project2 \
  /path/to/new/project        # ← add here
```

The script overwrites the `continuum` entry with the updated `WATCH_PATHS` list. Restart VS Code and the desktop app after running.

---

## What Gets Installed Where

```
~/.claude.json                          ← VS Code extension reads mcpServers from here
  └── mcpServers.continuum
        command: /path/to/node
        args:    [.../dist/mcp/McpServer.js]
        env:
          WATCH_PATHS: /proj1,/proj2,...
          DB_PATH:     .../Continuum/knowledge.db
          LOG_LEVEL:   info

~/Library/.../Claude/claude_desktop_config.json   ← Desktop app reads mcpServers from here
  └── mcpServers.continuum  (same structure)

~/.claude/CLAUDE.md                     ← Loaded into every Claude session
  └── Instructions to prefer Continuum tools for all code search
```

---

## Troubleshooting

**Tools still not showing after restarting VS Code**
- Make sure you fully quit VS Code (`Cmd+Q`), not just close the window
- Check `~/.claude.json` contains a `mcpServers.continuum` entry
- Verify the node binary path in `~/.claude.json` is correct: `which node`

**`dist/mcp/McpServer.js` not found**
```bash
cd "/path/to/Continuum"
npm run build
```
Then run the setup script again.

**Desktop app not seeing tools**
- Restart the app fully — MCP servers are only launched at app startup
- Check `~/Library/Application Support/Claude/claude_desktop_config.json` has the `continuum` entry

**Continuum watching the wrong folders**
- Run the setup script again with the correct project paths
- The `WATCH_PATHS` env var accepts comma-separated absolute paths
