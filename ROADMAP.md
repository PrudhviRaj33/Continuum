# Continuum Roadmap

The single source of truth for what's done, what's next, and what's being
considered. When a PR ships a "Next" item, move it to "Shipped" in the same commit.

Continuum is a **personal, local developer tool**. Its two moats:
1. **Memory owned by you locally, not the vendor** — on your disk, works across Claude Code, Cursor, Copilot.
2. **Memory captured with zero AI cooperation** — hooks and file watching, not hoping the model calls a tool.

---

## Shipped

### v1.1 (July 2026)
- **Tree-sitter behind a flag** — `PARSER=treesitter` activates WASM-based AST extraction via `web-tree-sitter` (no node-gyp). Regex stays the zero-dep default. Supported: TypeScript/JavaScript, Python, C#, Java, Go. Delivers: no false-positive symbols, exact end lines, real signatures. Per-file `parser` field records which extractor was used; `reindex` upgrades an existing regex index to tree-sitter in one step. Graceful fallback to regex if WASM is unavailable (optional deps not installed).
- **`continuum init` — one-command installer** — auto-detects project root, writes `.mcp.json` (no `WATCH_PATHS`/`DB_PATH` needed), wires all 5 hooks into `.claude/settings.json` via non-destructive merge, updates `.gitignore`. Idempotent. Replaced the old CLI `init` that wrote deprecated per-`.env` config.
- **`continuum status`** — read-only CLI: project root + detection marker, DB size/integrity (`PRAGMA integrity_check`), server liveness (pid filtered to this project via `lsof` cwd match), session state, per-language index counts with FTS-drift warning, hook wiring check. `--json` for scripting.
- **Local `context.md`** — human-readable memory file in `.continuum/` (gitignored, personal/local only): Active Work / Decisions / Open Questions / Recently Active Areas, regenerated deterministically by the Stop hook from `session_summaries`. `## Heading @manual` sections preserved verbatim across regeneration. New `get_project_context` MCP tool + `SessionStart` hook injection (capped ~1500 tokens) so fresh sessions start with distilled project memory automatically.
- **Context-survival hooks (5 total)** — PreCompact (injects session context before compaction), Stop (consolidates session + regenerates `context.md`), PostToolUse (auto-records file edits), PostToolUseFailure (captures tool errors into `tool_errors`, surfaced in `get_session`), SessionStart (injects `context.md`)
- **Auto-detect project root** — no `WATCH_PATHS` config needed; server resolves root from cwd (walks up to `.git`/`package.json`/`*.sln`/etc.), per-project DB in `.continuum/knowledge.db`
- **Session resume on restart** (`SESSION_RESUME_HOURS`, default 4) — server restarts reuse the recent session
- **Task garbage collection** (`MAX_TASKS_PER_SESSION`, default 15) — oldest tasks collapse into a consolidated entry
- **Stale-data elimination** — `removeFile()` cleans files+symbols+FTS together; `sweepOrphans()` on startup and full reindex purges files deleted while the watcher was offline; ENOENT mid-parse treated as delete
- **FTS5 ranked search repaired** — `symbols_fts` migrated from contentless (`content=''`, which silently broke the ranked-search JOIN since day one) to self-contained; automatic safe migration on startup
- **Lazy DB path resolution** — resolved on first use, not import time (fixes env-var ordering under ESM import hoisting)
- **New MCP tools** (17 total): `smart_search`, `enrich_context`, `list_tables`, `get_project_context`, `get_file_symbols`, `reindex` (reports `orphans_removed`), `get_recent_sessions`
- **camelCase search fix** — FTS5 + LIKE results always merged
- **TS/JS import extraction** into `relationships` (named/default/namespace/multi-line)
- **JS symbol extraction rewrite** — arrow functions, `module.exports`, generators, getters/setters
- **Angular support** — `@Component` selectors, `@Input`/`@Output`, template refs indexed across `.ts`/`.html`/`.scss`

### v1.0
- SQLite WAL + busy timeout, corruption quarantine on startup
- Watcher queueing with debounce and bulk-operation detection (`BULK_TOUCH_THRESHOLD`)
- Parsing safeguards (1MB file cap, UTF-16 BOM handling)
- Touched-files GC (24h prune)
- 17 languages via pluggable regex definitions
- Live DB schema reader (MSSQL/Postgres/MySQL) with 1h cache

---

## Next (committed, in order)

No committed items — all planned work is in the backlog below.

---

## Later (under consideration, unordered)

- **BM25 stemming / camelCase token expansion** — index `getUserById` as
  `get user by id` tokens; requires FTS rebuild. Search works today; this is a
  quality boost, not a gap.
- **Vector/semantic search** — opt-in (`EMBEDDING_MODEL=local`,
  `@xenova/transformers`, all-MiniLM-L6-v2), RRF fusion with FTS+LIKE. Only worth
  doing after tree-sitter provides clean symbols to embed.
- **`forget` tool + audit log** — remove accidentally indexed secrets/stale
  entries with an audit trail.
- **Knowledge-graph expansion** — `graph_nodes` table, 1-hop traversal in
  `find_related_files`. Depends on tree-sitter for accurate edges.
- **Multi-agent isolation** — `AGENT_ID`/`AGENT_SCOPE` with parameterized
  scoping. No current use case; design exists if one appears.
- **VS Code extension** — auto-generate config, status-bar health. Superseded in
  part by `continuum init`; revisit after it ships.

---

*History: earlier planning documents (`CONTINUUM_IMPLEMENTATION_PLAN.md`,
`IMPROVEMENT_PLAN.md`, `STRATEGY.md`) were consolidated into this file in July
2026. Git history preserves them.*
