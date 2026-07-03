# Continuum Roadmap

The single source of truth for what's done, what's next, and what's being
considered. When a PR ships a "Next" item, move it to "Shipped" in the same commit.

Continuum is a **personal, local developer tool**. Its two moats:
1. **Memory owned by you locally, not the vendor** — on your disk, works across Claude Code, Cursor, Copilot.
2. **Memory captured with zero AI cooperation** — hooks and file watching, not hoping the model calls a tool.

---

## Shipped

### v1.1 (July 2026)
- **Context-survival hooks** — PreCompact (injects session context before compaction), Stop (consolidates session into `session_summaries`), PostToolUse (auto-records file edits), PostToolUseFailure (captures tool errors into `tool_errors`, surfaced in `get_session`)
- **Auto-detect project root** — no `WATCH_PATHS` config needed; server resolves root from cwd (walks up to `.git`/`package.json`/`*.sln`/etc.), per-project DB in `.continuum/knowledge.db`
- **Session resume on restart** (`SESSION_RESUME_HOURS`, default 4) — server restarts reuse the recent session
- **Task garbage collection** (`MAX_TASKS_PER_SESSION`, default 15) — oldest tasks collapse into a consolidated entry
- **Stale-data elimination** — `removeFile()` cleans files+symbols+FTS together; `sweepOrphans()` on startup and full reindex purges files deleted while the watcher was offline; ENOENT mid-parse treated as delete
- **FTS5 ranked search repaired** — `symbols_fts` migrated from contentless (`content=''`, which silently broke the ranked-search JOIN since day one) to self-contained; automatic safe migration on startup
- **Lazy DB path resolution** — resolved on first use, not import time (fixes env-var ordering under ESM import hoisting)
- **New MCP tools** (16 total): `smart_search`, `enrich_context`, `list_tables`, `get_file_symbols`, `reindex` (reports `orphans_removed`), `get_recent_sessions`
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

1. **`continuum init` — one-command installer** (~1 day)
   Auto-detect root, write `.mcp.json`, wire all 4 hooks into `.claude/settings.json`
   (non-destructive merge, `require.resolve`d script paths), update `.gitignore`.
   Idempotent. Replaces the stale CLI `init` that still writes deprecated
   `WATCH_PATHS` config. Pitch: *install once, your project remembers everything,
   no AI cooperation required.*

2. **`continuum status`** (~½ day)
   Read-only CLI: project root + how it was detected, DB size/integrity, server
   liveness, session state, index counts per language, orphan-sweep results, and
   whether each hook is actually wired. `--json` for scripting. Works when the
   server is down — that's when you need it.

3. **Local `context.md`** (~2 days)
   Human-readable memory file in `.continuum/` (gitignored, never committed):
   Active Work / Decisions / Gotchas / Recently Active Areas, regenerated
   deterministically by the Stop hook from session summaries. `@manual` sections
   preserved on regeneration. New `get_project_context` MCP tool + SessionStart
   injection so fresh sessions start with distilled project memory.

4. **Tree-sitter behind a flag** (~1 week)
   `PARSER=treesitter` via `web-tree-sitter` (WASM — no node-gyp). Regex stays the
   zero-dep default. Top 5 languages first: TypeScript/JavaScript, Python, C#,
   Java, Go. Delivers: no false-positive symbols (no more `$`), exact end lines,
   real signatures, class↔method nesting. Per-file `parser` field so mixed
   indexes are visible; `reindex` upgrades an existing index.

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
