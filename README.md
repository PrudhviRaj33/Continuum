# Continuum

**AI Development Memory Layer — Universal Language Support**

> Give your AI coding assistant persistent memory across context windows. Continuum is a local MCP server that watches your codebase, indexes symbols from 17+ languages, tracks your session state, and lets AI assistants resume exactly where they left off — even after context compaction.

[![CI](https://github.com/yourusername/continuum/actions/workflows/ci.yml/badge.svg)](https://github.com/yourusername/continuum/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)

---

## The Problem

AI coding assistants lose all context when their conversation fills up (context compaction). Every time this happens:
- You re-explain the goal from scratch
- The AI re-reads files it already processed
- Architectural decisions get forgotten
- Momentum is lost

**Continuum fixes this.** It persists session state in a local SQLite database and exposes it through MCP tools so any AI assistant can instantly recover full context.

> **Zero config.** Open any project in VS Code — Continuum detects the project root automatically. No `WATCH_PATHS` to configure. Each project gets its own isolated symbol index.

---

## Architecture

```
Your Codebase
     │  (chokidar file watcher)
     ▼
FileWatcher ──► IncrementalParser ──► SQLite (knowledge.db)
                  (17 languages)          │
                                    ┌─────┴──────┐
                                    │ Symbols     │
                                    │ Sessions    │
                                    │ Tasks       │
                                    │ FTS5 Index  │
                                    └─────┬───────┘
                                          │
                                    McpServer (stdio)
                                    16 MCP Tools
                                          │
                              Claude Code / Cursor / Copilot
```

---

## Quick Start

```bash
# 1. Clone and build
git clone https://github.com/yourusername/continuum
cd continuum
npm install --legacy-peer-deps
npm run build

# 2. Register with Claude Code (run once per project)
node scripts/setup-claude.js /path/to/your/project

# That's it. Open the project in VS Code — Continuum starts automatically.
# No WATCH_PATHS. No manual DB config. Fully automatic.
```

**Adding more projects later:**
```bash
node scripts/setup-claude.js /path/to/project1 /path/to/project2
```

---

## Wire to Claude Code

Run the setup script once — it writes a `.mcp.json` to each project root automatically:

```bash
node /path/to/continuum/scripts/setup-claude.js /path/to/your/project
```

This creates `.mcp.json` in your project root with `cwd` set to that project. When VS Code opens the project, Claude Code reads this file and spawns Continuum with `cwd = project root`. Continuum then auto-detects the root and starts watching.

**The resulting `.mcp.json` in your project** (written automatically by the setup script):
```json
{
  "mcpServers": {
    "continuum": {
      "command": "/path/to/node",
      "args": ["/path/to/continuum/dist/mcp/McpServer.js"],
      "cwd": "/your/project/root",
      "env": {
        "LOG_LEVEL": "info",
        "SESSION_RESUME_HOURS": "4"
      }
    }
  }
}
```

No `WATCH_PATHS`. No `DB_PATH`. Continuum resolves both from `cwd` automatically.

**Symbol index location:** `.continuum/knowledge.db` in your project root (auto-gitignored).

Reload VS Code after setup. Verify: ask Claude "call health_check" — you should see `auto_detected: true` and the correct `project_root`.

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_session` | 🔄 **Core recovery tool.** Full session state including last 5 saved tasks — call after any context compaction |
| `save_task` | 💾 Save structured task state (goal, decisions, next steps, open questions) |
| `get_touched_files` | 📁 Files modified/created/deleted this session |
| `get_recent_sessions` | 🕰️ List past sessions with goals and file activity — cross-session continuity |
| `find_related_files` | 🔍 Cross-layer search for symbols, features, and files |
| `search_symbols` | 🔎 Full-text + substring search across all indexed symbols — finds camelCase partials |
| `get_file_symbols` | 📄 All symbols in a specific file, grouped by kind — accepts partial paths |
| `reindex` | ♻️ Force re-parse one file or all files, ignoring cached hashes |
| `get_schema` | 🗄️ Live DB schema for a table (MSSQL/PostgreSQL/MySQL, cached 1h) |
| `get_dependencies` | 🕸️ Symbols defined in a file + import relationships extracted from TS/JS |
| `list_languages` | 🌍 All supported languages with indexed file/symbol counts |
| `get_session_report` | 📊 Session metrics: tool calls, files touched, actual tokens returned |
| `health_check` | 🩺 Server health, uptime, DB status |
| `smart_search` | ⚡ Unified search — symbols + session tasks + touched files in one query |
| `enrich_context` | 🔬 Full picture for a file — symbols inside, files that import it, recent activity |
| `list_tables` | 📋 List all tables in connected external database (requires DB_TYPE) |

---

## Slash Commands

Create these in your project's `.claude/commands/` folder:

| Command | Action |
|---------|--------|
| `/resume` | Recover full session after compaction — continue without re-explaining |
| `/checkpoint` | Proactively save task state before context fills |
| `/task [description]` | Start a task with full codebase context pre-loaded |
| `/report` | Show session efficiency metrics |

---

## Supported Languages

| Language | Extensions | Symbol Types |
|----------|-----------|--------------|
| TypeScript | `.ts`, `.tsx` | class, interface, function, enum, type, method, property |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | class, function, method |
| Python | `.py`, `.pyw` | class, function, method, async def |
| Rust | `.rs` | struct, enum, trait, fn, mod, type, impl |
| Go | `.go` | func, method, struct, interface, type |
| Java | `.java` | class, interface, enum, method, constructor |
| C# | `.cs` | class, interface, enum, struct, record, method, property |
| C/C++ | `.c`, `.cpp`, `.h`, `.hpp` | class, struct, function, method |
| Ruby | `.rb`, `.rake` | class, module, def, method |
| PHP | `.php` | class, interface, trait, enum, function, method |
| Swift | `.swift` | class, struct, protocol, enum, func, extension |
| Kotlin | `.kt`, `.kts` | class, interface, enum, object, fun |
| SQL | `.sql` | TABLE, VIEW, PROCEDURE, FUNCTION, TYPE, INDEX |
| Markdown | `.md`, `.mdx` | H1 (doc), H2 (section), H3 (subsection) |
| HTML / Angular | `.html`, `.htm` | custom elements, Angular component selectors, `ng-template` refs, template reference variables (`#var`) |
| CSS | `.css` | class selectors, CSS custom properties (`--token`), `@keyframes`, `@layer` |
| SCSS / Sass | `.scss`, `.sass` | `@mixin`, `@function`, `$variables`, `%placeholders`, CSS custom properties, `@keyframes`, `@layer`, class selectors |

**Angular projects** get first-class support: component selectors (`<app-*>`, `<mat-*>`), named template blocks, and template reference variables are all indexed across `.html`, `.scss`, and `.ts` files. `find_related_files` returns results across all three layers for a single component.

**Adding a new language:** Create a file in `src/languages/definitions/yourlanguage.ts`, export a `LanguageDefinition` as default, and add one `import` + `registerLanguage()` call in `LanguageRegistry.ts`. No other changes needed.

> **Note on parsing accuracy:** Symbol extraction uses regex, which covers the vast majority of real-world code. Highly complex cases — deeply nested generics, multi-line decorators, or unusual macro patterns — may occasionally be missed or partially extracted. AST-based parsing via Tree-sitter is planned for Phase 4 and will resolve these edge cases.

---

## Database Schema (Optional)

Enable the `get_schema` tool by setting `DB_TYPE` in `.env`:

```bash
# PostgreSQL
DB_TYPE=postgres
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=myapp
PG_USER=myuser
PG_PASSWORD=mypassword

# MSSQL
DB_TYPE=mssql
MSSQL_HOST=localhost
MSSQL_DATABASE=myapp
MSSQL_USER=myuser
MSSQL_PASSWORD=mypassword

# MySQL / MariaDB
DB_TYPE=mysql
MYSQL_HOST=localhost
MYSQL_DATABASE=myapp
MYSQL_USER=myuser
MYSQL_PASSWORD=mypassword
```

---

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| Variable | Default | Description |
|----------|---------|-------------|
| _(none needed)_ | — | **Zero config by default.** Project root and DB path are auto-detected from `cwd`. |
| `WATCH_PATHS` | _(auto)_ | Override auto-detection. Comma-separated absolute paths to watch. |
| `PROJECT_ROOT` | _(auto)_ | Explicitly set project root (skips git/package.json walk-up). |
| `DB_PATH` | `<project>/.continuum/knowledge.db` | Override the per-project DB location. |
| `WATCH_IGNORE` | _(none)_ | Comma-separated regex patterns to exclude from watching. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `NODE_ENV` | `development` | Set to `production` for JSON logs |
| `DB_TYPE` | _(none)_ | `mssql` \| `postgres` \| `mysql` — enables `get_schema` and `list_tables` |
| `SESSION_RESUME_HOURS` | `4` | Resume most recent session if active within N hours. `0` = always new. |
| `MAX_TASKS_PER_SESSION` | `15` | Max tasks before oldest are collapsed into a consolidated entry. |

---

## Development

```bash
npm run dev          # Run with tsx (no build step)
npm run type-check   # TypeScript strict check
npm run lint         # ESLint
npm run format       # Prettier
npm test             # Vitest
npm run test:watch   # Vitest watch mode
npm run test:coverage # Coverage report
npm run build        # Production TypeScript compile
```

### Docker

```bash
docker build -t continuum .
docker compose up -d
```

---

## How It Works

1. **Startup**: Continuum reads `cwd` (set by the per-project `.mcp.json`) and walks up the directory tree to find the project root (`.git`, `package.json`, `*.sln`, etc.). It creates or resumes a session in `.continuum/knowledge.db` inside that root.
2. **Indexing**: Every file change triggers incremental parsing. The file's MD5 hash is checked — unchanged files are skipped. New symbols are extracted and stored in SQLite with FTS5 indexing.
3. **Session tracking**: Every file change after the initial scan is recorded as a `touched_file` event (debounced to 5 seconds per path). The PostToolUse hook captures edits automatically.
4. **MCP tools**: Your AI assistant calls tools via stdio. `save_task` checkpoints the current goal and decisions; `get_session` recovers them after compaction.
5. **Compaction survival**: The PreCompact hook injects compressed context (goal, decisions, next steps, touched files) before compaction — session state is never lost.
6. **Schema cache**: `get_schema` fetches live database schema and caches it in SQLite for 1 hour.

---

## Troubleshooting

**Claude Code doesn't see the tools**
→ Reload VS Code after editing `mcp.json`. Check `npm run dev` starts without errors.

**File changes not being indexed**
→ Ensure `WATCH_PATHS` includes the directory you're editing. Check `LOG_LEVEL=debug` for watcher events.

**MSSQL connection fails**
→ Set `LOG_LEVEL=debug` and check the error. Ensure `trustServerCertificate=true` for local SQL Server.

**MCP server crashes on startup**
→ Ensure no `console.log` in any source file (breaks stdio MCP transport). Use the logger utility.

**Symbols not extracted for my language**
→ Open `src/languages/definitions/` and check the regex rules. Enable `LOG_LEVEL=debug` to see what's parsed.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/new-language`
3. Add your language definition in `src/languages/definitions/`
4. Add tests in `tests/parser.test.ts`
5. Run `npm test && npm run type-check`
6. Submit a PR

---

## License

MIT — see [LICENSE](LICENSE)

---

*Continuum v1.0 — Model-agnostic · Offline · No cloud dependencies · Production-ready*
