# Continuum

**A local, per-project memory layer for AI coding assistants**

> Continuum watches your codebase, indexes real code symbols across 17 languages (with AST-accurate parsing for 5 of them), and captures your session's decisions and file activity automatically — through hooks, not by hoping the AI remembers to call a tool. Everything lives in one SQLite file inside your own project. Nothing is sent anywhere, nothing is shared across projects, nothing requires a server.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)

---

## The problem

AI coding assistants lose context constantly — when a conversation compacts, when you close the editor, when you start a new session tomorrow. Every time:
- You re-explain what you were doing
- The AI re-reads files it already processed
- Decisions you already made get re-litigated
- Momentum resets to zero

**Continuum fixes this locally**, with no cloud dependency and no vendor lock-in. It's a personal tool: memory lives on your disk, in your project, and works the same way whether you're using Claude Code, Cursor, or Copilot.

---

## What it actually does

| Layer | What it means in practice |
|---|---|
| **Code index** | Every function, class, and method across 17 languages is indexed as you save — searchable by name, including partial/camelCase matches |
| **Session memory** | Goals, decisions, next steps, and open questions persist across restarts and context compactions |
| **Automatic capture** | File edits, tool errors, and session summaries are recorded by hooks — the AI doesn't need to remember to save anything |
| **Human-readable memory** | `.continuum/context.md` is a plain-markdown distillation of your project's history — open it, read it, hand-edit it |
| **Zero infrastructure** | One SQLite file per project, one Node process, no Docker, no external services, no account |

---

## Quick start

```bash
# 1. Clone and build Continuum once
git clone <this-repo> continuum
cd continuum
npm install --legacy-peer-deps
npm run build

# 2. Set it up inside the project you want memory for
cd /path/to/your/project
node /path/to/continuum/dist/cli/index.js init
```

`init` does everything in one idempotent step:
- Detects your project root (`.git`, `package.json`, `*.sln`, etc. — or the current folder if nothing else matches)
- Writes `.mcp.json` with the resolved root baked in as `PROJECT_ROOT`
- Wires all 5 hooks into `.claude/settings.json`, merging non-destructively with anything already there
- Adds `.continuum/` to `.gitignore`

Restart your editor. Continuum starts automatically and begins indexing — no `WATCH_PATHS`, no manual database path, nothing else to configure.

**Verify it worked:**
```bash
node /path/to/continuum/dist/cli/index.js status
```
Shows project root, database health, session state, index counts per language, and whether all 5 hooks are actually wired (not just installed).

---

## How project root resolution actually works

Claude Code auto-injects `CLAUDE_PROJECT_DIR` into every MCP server's environment with the correct project root, regardless of workspace layout — that's the primary mechanism Continuum reads. `PROJECT_ROOT` (written explicitly by `init`) is the fallback for non-Claude-Code MCP clients or a direct `continuum start`. If neither is present, Continuum walks up from the current working directory looking for a marker file.

> **Note:** `"cwd"` is *not* a supported field in Claude Code's `.mcp.json` schema — it's silently ignored if present. Don't rely on it; use `PROJECT_ROOT`/`CLAUDE_PROJECT_DIR` as above.

**Multiple repos as one feature workspace:** if you regularly work across several repos as one unit (e.g. a UI, an API, and a DB repo for the same feature), put them under one parent folder and run `init` at that level. Continuum's file watcher recurses into every subfolder automatically, and all of it lands in one shared `.continuum/knowledge.db` — search and session memory then span the whole group. The tradeoff: if any of those repos is later opened *alone* with its own separate `init`, that creates a second, disconnected database for it. Pick one approach and stay consistent for a given repo.

---

## MCP Tools (19)

| Tool | What it does |
|------|-------------|
| `get_session` | **Core recovery tool.** Full session state, last 5 tasks, recent errors — call after any compaction |
| `save_task` | Save structured task state (goal, decisions, next steps, open questions) |
| `get_touched_files` | Files modified/created/deleted this session |
| `get_recent_sessions` | Past sessions with goals, summaries, and file activity |
| `get_project_context` | Distilled long-lived memory (`context.md`) — decisions and active work across all sessions, not just the current one |
| `find_related_files` | Cross-layer search for symbols, features, and files |
| `search_symbols` | Full-text + substring search across indexed symbols — finds camelCase partials |
| `smart_search` | One query across symbols, session tasks, and touched files at once |
| `get_file_symbols` | All symbols in a file, grouped by kind — accepts partial paths |
| `enrich_context` | Full picture for a file: symbols inside it, files that import it, recent activity |
| `get_dependencies` | Symbols in a file plus import relationships (TS/JS) |
| `reindex` | Force re-parse one file or everything, ignoring cached hashes; also purges stale entries for files no longer on disk |
| `forget` | Permanently remove a file or glob pattern from the index, with an audit log entry — for accidentally indexed secrets or generated files |
| `get_forget_log` | Audit trail of everything `forget` has removed |
| `list_languages` | Supported languages with indexed file/symbol counts |
| `get_schema` | Live DB schema for a table (MSSQL/PostgreSQL/MySQL, cached 1h) |
| `list_tables` | List tables in the connected external database |
| `get_session_report` | Session metrics: tool calls, files touched, actual tokens returned |
| `health_check` | Server health, uptime, DB status, project root, auto-detection state |

---

## Hooks — memory without asking the AI to cooperate

`continuum init` wires 5 Claude Code hooks. These are what make Continuum's memory automatic instead of dependent on the AI remembering to call a tool:

| Hook | Fires when | What it does |
|------|-----------|--------------|
| `PreCompact` | Context is about to compact | Injects the session's goal, decisions, and touched files so they survive |
| `Stop` | Session ends | Consolidates the session and regenerates `context.md` |
| `PostToolUse` | Edit/Write/Bash/MultiEdit runs | Records the touched file automatically — no `save_task` needed |
| `PostToolUseFailure` | A tool call fails | Captures the error, surfaced later in `get_session` |
| `SessionStart` | A new session begins | Injects `context.md` into the starting context |

**`.continuum/context.md`** is generated deterministically (no LLM) by the `Stop` hook from accumulated session history: Active Work, Decisions, Open Questions, Recently Active Areas. It's gitignored — personal, local memory, not a team artifact. Any section you mark `## Heading @manual` is preserved verbatim across regenerations, so you can edit it by hand without it being overwritten.

**Important limitation:** these are Claude Code hook events specifically. On MCP clients without an equivalent hook system (Cursor, Copilot, etc.), the automatic-capture layer doesn't run — the MCP tools above still work, but you'd need to call `save_task` explicitly rather than relying on hooks.

---

## Parsing: tree-sitter where it counts, regex everywhere else

Set `PARSER=treesitter` to enable AST-based extraction (via `web-tree-sitter`, WASM, no native compilation) for **TypeScript/JavaScript, Python, C#, Java, and Go**. This eliminates false-positive symbols that regex parsing can produce and gives exact end-lines and real signatures. Falls back silently to regex if a WASM grammar fails to load.

Every other supported language uses regex extraction — fast, zero extra dependencies, and accurate for the vast majority of real-world code. Each file's `parser` field in the database records which extractor was actually used, so a mixed index is visible, not silent.

---

## Search quality

- **FTS5 + LIKE always merged** — a ranked full-text match and a substring fallback both run on every `search_symbols` query, so partial and camelCase matches (`user` finding `getUserById`) work without exact substring matching.
- **`name_tokens` column** splits camelCase/snake_case at index time (`getUserById` → also indexed as `get user by id`), so single-word queries find compound symbol names.

---

## Supported languages

| Language | Extensions | Parser |
|----------|-----------|--------|
| TypeScript | `.ts`, `.tsx` | tree-sitter (opt-in) or regex |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | tree-sitter (opt-in) or regex |
| Python | `.py`, `.pyw` | tree-sitter (opt-in) or regex |
| C# | `.cs` | tree-sitter (opt-in) or regex |
| Java | `.java` | tree-sitter (opt-in) or regex |
| Go | `.go` | tree-sitter (opt-in) or regex |
| Rust | `.rs` | regex |
| C/C++ | `.c`, `.cpp`, `.h`, `.hpp` | regex |
| Ruby | `.rb`, `.rake` | regex |
| PHP | `.php` | regex |
| Swift | `.swift` | regex |
| Kotlin | `.kt`, `.kts` | regex |
| SQL | `.sql` | regex |
| Markdown | `.md`, `.mdx` | regex |
| HTML / Angular | `.html`, `.htm` | regex — component selectors, template refs |
| CSS | `.css` | regex — selectors, custom properties |
| SCSS / Sass | `.scss`, `.sass` | regex — mixins, functions, variables |

**Angular projects** get first-class support: component selectors (`<app-*>`), `@Input`/`@Output`, and template reference variables are indexed across `.ts`, `.html`, and `.scss` together — `find_related_files` returns matches spanning all three layers for one component.

**Adding a new language:** create a file in `src/languages/definitions/`, export a `LanguageDefinition` default, register it in `LanguageRegistry.ts`. No other changes needed.

---

## Live database schema (optional)

Set `DB_TYPE` to enable `get_schema` and `list_tables` against a real external database:

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

## Configuration reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECT_ROOT` | _(auto)_ | Written automatically by `continuum init`. Explicit project root override. |
| `WATCH_PATHS` | _(auto)_ | Comma-separated absolute paths — overrides root auto-detection entirely if set. |
| `DB_PATH` | `<project>/.continuum/knowledge.db` | Override the database location. |
| `WATCH_IGNORE` | _(none)_ | Comma-separated regex patterns to exclude from watching, merged with built-in ignores (`node_modules`, `.git`, `dist`, etc.) |
| `PARSER` | `regex` | Set to `treesitter` to enable AST parsing for the 5 supported languages. |
| `SESSION_RESUME_HOURS` | `4` | Resume the most recent session if it was active within N hours. `0` disables resume — always start fresh. |
| `MAX_TASKS_PER_SESSION` | `15` | Oldest tasks collapse into one consolidated entry past this count. |
| `BULK_TOUCH_THRESHOLD` | `30` | File-touch batches larger than this (e.g. a `git checkout`) skip session-touch logging to avoid noise. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `LOG_FILE` | _(none)_ | Optional path to also write logs to a file. |
| `NODE_ENV` | `development` | Set to `production` for JSON logs. |
| `DB_TYPE` | _(none)_ | `mssql` \| `postgres` \| `mysql` — enables `get_schema`/`list_tables`. |

---

## How it works, end to end

1. **Startup** — resolves project root (`CLAUDE_PROJECT_DIR` → `PROJECT_ROOT` → marker walk), opens or creates `.continuum/knowledge.db` inside it, resumes the recent session if within `SESSION_RESUME_HOURS`.
2. **Indexing** — every file change triggers incremental parsing; unchanged files are skipped via MD5 hash comparison. On startup and on full reindex, files that no longer exist on disk are automatically purged (no stale symbols left behind from deleted files).
3. **Capture** — hooks record file touches, session consolidation, and errors automatically; MCP tools (`save_task`, `forget`, etc.) remain available for explicit, deliberate memory.
4. **Search** — `search_symbols`/`smart_search` merge FTS5 ranked results with a LIKE substring fallback, so partial and camelCase queries both work.
5. **Recovery** — `PreCompact` injects context before compaction; `SessionStart` injects `context.md` at the start of every new session.

---

## Development

```bash
npm run dev            # Run with tsx (no build step)
npm run type-check     # TypeScript strict check
npm run lint           # ESLint
npm run format         # Prettier
npm test               # Vitest
npm run test:watch     # Vitest watch mode
npm run test:coverage  # Coverage report
npm run build          # Production TypeScript compile
```

> **Known issue:** `npm run build` can intermittently exhaust its configured heap limit on memory-constrained machines. If it fails with an out-of-memory error, retry with a larger heap: `NODE_OPTIONS=--max-old-space-size=8192 npm run build`.

### Docker

```bash
docker build -t continuum .
docker compose up -d
```

---

## Troubleshooting

**Claude Code doesn't see the tools**
→ Fully restart the editor after running `init`. Run `continuum status` to confirm `.mcp.json` exists and hooks are wired.

**File changes not being indexed**
→ Run `continuum status` to check the detected project root is correct. Set `LOG_LEVEL=debug` for watcher events.

**Hooks show as wired but nothing seems to happen**
→ Confirm the hook scripts exist at the paths in `.claude/settings.json`. Each hook writes errors to stderr — check your editor's MCP/hook logs.

**MSSQL connection fails**
→ Set `LOG_LEVEL=debug` and check the error. Ensure `trustServerCertificate=true` for local SQL Server.

**MCP server crashes on startup**
→ Ensure no `console.log` anywhere in source (breaks stdio MCP transport) — use the logger utility instead.

**Symbols missing for my language**
→ Check `src/languages/definitions/` for the relevant regex rules, or enable `PARSER=treesitter` if your language is one of the 5 supported for AST parsing. Enable `LOG_LEVEL=debug` to see what's being parsed.

---

## Current limitations

Being direct about what isn't built yet, rather than implying it is:

- **Multi-repo workspaces aren't fully solved.** Putting several repos under one parent folder and running `init` there works today (shared search and memory across all of them), but opening any of those repos separately later creates a second, disconnected memory for it. A design for live multi-root detection and per-repo isolation without this tradeoff exists in `MULTI_WORKSPACE_DESIGN.md` but isn't implemented.
- **Session memory isn't branch-aware.** Working on two different features (branches) in the same repo currently shares one task history.
- **No installer for non-Claude-Code clients.** `continuum init` only writes Claude Code's config format; Cursor/Copilot/Windsurf users need to configure the MCP server manually.
- Full roadmap, what's shipped, and what's next: see [`ROADMAP.md`](ROADMAP.md).

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/new-language`
3. Add your language definition in `src/languages/definitions/`
4. Add tests in `tests/`
5. Run `npm test && npm run type-check`
6. Submit a PR

---

## License

MIT. (No `LICENSE` file exists in this repository yet — add one before publishing publicly.)

---

*Continuum — a personal, local memory layer. Model-agnostic · offline · no cloud dependencies.*
