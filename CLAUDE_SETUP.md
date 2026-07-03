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

---

## Hooks Setup — Surviving Context Compaction

Continuum ships four Claude Code hooks that dramatically improve memory continuity.
Wire them in your project's `.claude/settings.json` (create if it doesn't exist):

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [{
          "type": "command",
          "command": "node /absolute/path/to/Continuum/scripts/hooks/pre-compact.js",
          "timeout": 5000
        }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "node /absolute/path/to/Continuum/scripts/hooks/stop.js",
          "timeout": 10000
        }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [{
          "type": "command",
          "command": "node /absolute/path/to/Continuum/scripts/hooks/post-tool-use.js",
          "timeout": 3000
        }]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "",
        "hooks": [{
          "type": "command",
          "command": "node /absolute/path/to/Continuum/scripts/hooks/post-tool-failure.js",
          "timeout": 3000
        }]
      }
    ]
  }
}
```

Replace `/absolute/path/to/Continuum` with the actual path from `pwd` in your Continuum directory.

Also set the `DB_PATH` env var so hooks find the same database as the MCP server:

```bash
export DB_PATH="/absolute/path/to/Continuum/knowledge.db"
```

Or add it to each hook command:

```json
"command": "DB_PATH=/path/to/knowledge.db node /path/to/Continuum/scripts/hooks/pre-compact.js"
```

### What each hook does

| Hook | Script | What it does |
|------|--------|--------------|
| `PreCompact` | `pre-compact.js` | Injects compressed session context **before** compaction — context survives |
| `Stop` | `stop.js` | Consolidates session on close — appears in `get_recent_sessions` summaries |
| `PostToolUse` | `post-tool-use.js` | Auto-records file edits into `touched_files` without needing `save_task` |
| `PostToolUseFailure` | `post-tool-failure.js` | Captures tool errors — surfaces in `get_session` as `recent_errors` |
