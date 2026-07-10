# Continuum — Implementation Plan (v3.0)
### Confidence Score: 84/100

> v2.0 covered Phases 1–6 (BM25, forget, knowledge-graph, semantic search,
> multi-agent, VS Code extension). Phases 1 and 2 have since **shipped** —
> see commits `9ef7196` and `d766e1c`. This revision (v3.0) corrects the
> baseline that had gone stale, reprioritizes ahead of Phases 3–6 with work
> found during a full architecture review (see `MULTI_WORKSPACE_DESIGN.md`,
> `PRODUCT_REQUIREMENTS.md`, `TESTING_PLAN.md`), and keeps Phases 3–6 as
> future work, now renumbered to Phases 8–11.

---

## Why 84/100 — Honest Breakdown

| Phase | Confidence | Main Uncertainty |
|---|---|---|
| Phase 0 — Deployment gap | 99% | Zero engineering risk — it's an action, not code |
| Phase 1 — BM25 / camelCase | ✅ Shipped | — |
| Phase 2 — `forget` tool | ✅ Shipped | — |
| Phase 3 — Branch-scoped sessions | 95% | One column, one migration, one query predicate |
| Phase 4 — Token-efficiency benchmark | 85% | Harness design is clear; result quality depends on picking realistic tasks |
| Phase 5 — Process lifecycle + build reliability | 88% | Pidfile pattern is well-understood; build OOM root cause needs confirming |
| Phase 6 — Testing plan execution | 90% | Mostly execution of already-designed tests, not new design |
| Phase 7 — Multi-repo connection manager + fan-out | 70% | Largest, most novel piece; several dependent sub-systems |
| Phase 8 — Knowledge graph (call edges) | 74% | Unchanged from v2.0 — `call_expression` extraction per-language, `from_id` anchoring |
| Phase 9 — Semantic search | 58% | Unchanged from v2.0 — WASM coexistence, memory scaling |
| Phase 10 — Multi-agent isolation | 93% | Unchanged from v2.0 — trivial, low priority |
| Phase 11 — Multi-client installer | 80% | Config format research needed per tool (Cursor, Copilot, Windsurf) |
| Phase 12 — VS Code extension | 78% | Unchanged from v2.0 — build only if requested |

**Overall weighted: 84/100.** Higher than v2.0's 81 because the two riskiest
original phases (BM25, forget) are now done-and-verified rather than
projected, and the new near-term phases (0, 3, 4, 5, 6) are low-risk,
well-understood work. Phase 7 (multi-repo) is the new honest wildcard —
it's the largest, least-precedented piece in this entire plan.

---

## Gaps Found in Original Plan (Now Fixed)

1. **FTS5 MATCH syntax was wrong** — `WHERE symbols_fts MATCH 'name:query OR name_tokens:query'` is not valid FTS5 column filter syntax. Correct form is `{name name_tokens}: query*` or build via the FTS5 query syntax properly.
2. **Pattern matching needs a dep** — `forgetPattern(glob)` requires either `minimatch` package or manual string matching. Original plan glossed over this.
3. **`from_id` anchoring for call edges is wrong** — `storeImportRelationships()` anchors to the *first symbol in the file*. For call edges, `from_id` must be the *specific calling symbol*, not the first one. This requires a different lookup.
4. **"Cache all embeddings in memory"** — won't scale beyond ~5k symbols. Plan now specifies chunked streaming with a hard cap.
5. **In-memory skip-set doesn't survive restart** — the forget watcher skip-set is lost on server restart. Fixed: check `forget_log` at startup and rebuild the skip-set.

---

## Current State (Baseline — corrected, was stale)

```
Tests:    94/94 passing
Build:    tsc clean, 0 errors (intermittent OOM on this machine — see Phase 5)
Tools:    19 MCP tools
DB:       14 tables, SQLite WAL, FTS5 self-contained, name_tokens, forget_log
Parser:   regex (default) + tree-sitter (PARSER=treesitter, 6 languages)
Commit:   a9ffb5d + 2 uncommitted fixes in working tree (hook DB_PATH routing, README rewrite)
Deployed: NOT wired to real projects — reviewer's own 3 production repos still on
          old global config, zero hooks ever fired across 8 real sessions
```

---

## Priority & Dependency Map

```
Phase 0:  Close the deployment gap                ← independent, zero code, ~1 hour — do this FIRST
Phase 1:  BM25 / camelCase token expansion         ← ✅ SHIPPED
Phase 2:  forget tool + audit log                  ← ✅ SHIPPED
Phase 3:  Branch-scoped sessions                   ← independent, ~1 day
Phase 4:  Token-efficiency benchmark               ← needs Phase 0 (real data to measure), ~1 day
Phase 5:  Process lifecycle + build reliability     ← independent, ~1-2 days
Phase 6:  Testing plan execution                   ← needs Phase 0 + 3-5 for full data, ~3 days
Phase 7:  Multi-repo connection manager + fan-out   ← independent, largest piece, ~9-13 days
Phase 8:  Knowledge-graph (call edges)              ← needs tree-sitter ✅, ~3 days
Phase 9:  Vector / semantic search                  ← needs tree-sitter ✅ + Phase 1 ✅, ~1 week
Phase 10: Multi-agent isolation                     ← independent, low priority, ~0.5 days
Phase 11: Multi-client installer                    ← independent, ~2-3 days
Phase 12: VS Code extension                         ← independent, build last/if requested, ~3 days
```

---

## Phase 1 — BM25 Stemming + camelCase Token Expansion
**✅ SHIPPED — commit `9ef7196`. Kept below as historical reference and for the "what not to rebuild" list.**

### What It Does
`getUserById` is one opaque FTS5 token. Searching `user` won't find it.
This adds `name_tokens` (camelCase split + lowercase) so substring searches work.
`getUserById` → indexed as `get user by id` alongside the original.

### Files to Change

#### `src/database/schema.sql`
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name,
  name_tokens,   -- "getUserById" → "get user by id", "MyHTTPClient" → "my http client"
  kind,
  file_path,
  tokenize = 'unicode61'
);
```

#### `src/database/Database.ts` — inside `runMigrations()`
Add after the existing `migrateContentlessFts()` call:
```typescript
migrateFtsAddTokens(instance);
```

New function — mirrors the `migrateContentlessFts()` pattern exactly:
```typescript
function migrateFtsAddTokens(db: BetterSqlite3.Database): void {
  // Check if name_tokens column exists by looking at the FTS schema
  const cols = db
    .prepare("SELECT * FROM pragma_table_info('symbols_fts')")
    .all() as { name: string }[];
  if (cols.some(c => c.name === 'name_tokens')) return; // already migrated

  logger.info('Migrating symbols_fts: adding name_tokens column (rebuild required)');
  db.exec(`DROP TABLE IF EXISTS symbols_fts`);
  db.exec(`
    CREATE VIRTUAL TABLE symbols_fts USING fts5(
      name, name_tokens, kind, file_path, tokenize = 'unicode61'
    )
  `);
  // Re-populate from symbols + files
  const rows = db
    .prepare('SELECT s.name, s.kind, f.path FROM symbols s JOIN files f ON s.file_id = f.id')
    .all() as { name: string; kind: string; path: string }[];
  const insert = db.prepare(
    'INSERT INTO symbols_fts (name, name_tokens, kind, file_path) VALUES (?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (const r of rows) insert.run(r.name, splitCamelCase(r.name), r.kind, r.path);
  })();
  logger.info({ rows: rows.length }, 'symbols_fts rebuilt with name_tokens');
}

// Pure utility — no DB needed. Export for testing.
export function splitCamelCase(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}
```

#### `src/parser/IncrementalParser.ts`
```typescript
// In parseFile(), update FTS statements:
const insertFts = db.prepare(
  'INSERT INTO symbols_fts (name, name_tokens, kind, file_path) VALUES (?, ?, ?, ?)'
);
// Inside transaction:
insertFts.run(s.name, splitCamelCase(s.name), s.kind, filePath);
```
Import `splitCamelCase` from `'../database/Database'`.

#### `src/knowledge/KnowledgeEngine.ts` — `searchSymbols()`
```typescript
// FTS5 correct multi-column syntax — wrap both columns in braces:
WHERE symbols_fts MATCH '{name name_tokens}: ' || ?
// Or as a query prefix:
WHERE symbols_fts MATCH ?
// pass: query + '*'  (the tokenizer handles both columns)
```
> ⚠️ **Testing required:** SQLite FTS5 column filter syntax `{col1 col2}: term`
> must be validated against the actual `unicode61` tokenizer behaviour.
> Fall back to two separate MATCH queries if needed.

### Critical Risk
> FTS5 virtual tables do NOT support `ALTER TABLE ADD COLUMN`.
> Must DROP + recreate + re-populate. Pattern is `migrateContentlessFts()`.

### Tests to Write
- `splitCamelCase('getUserById')` → `'get user by id'`
- `splitCamelCase('MyHTTPClient')` → `'my http client'`
- `splitCamelCase('parse_file')` → `'parse file'`
- Search `'user'` returns symbol `getUserById`
- Search `'getUserById'` (exact) still works — no regression
- `migrateFtsAddTokens` runs twice without error (idempotent)

---

## Phase 2 — `forget` Tool + Audit Log
**✅ SHIPPED — commit `d766e1c`. Kept below as historical reference.**

### What It Does
Removes a file, symbol, or glob pattern from the index permanently.
Logs every deletion with reason + counts so accidental deletes are auditable.
`reindex` can re-add files that still exist on disk.

### New Dependency
Add `minimatch` for glob pattern matching:
```bash
npm install minimatch
npm install --save-dev @types/minimatch
```
Already in the Node ecosystem, zero compile risk.

### Files to Change

#### `src/database/schema.sql` — new table
```sql
CREATE TABLE IF NOT EXISTS forget_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type     TEXT    NOT NULL,   -- 'file' | 'symbol' | 'pattern'
  target_value    TEXT    NOT NULL,
  reason          TEXT,
  session_id      TEXT,
  forgotten_at    INTEGER DEFAULT (unixepoch()),
  symbols_removed INTEGER DEFAULT 0,
  files_removed   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_forget_log_time ON forget_log(forgotten_at DESC);
```

#### `src/database/Database.ts` — `runMigrations()`
```typescript
try {
  instance.exec(`CREATE TABLE IF NOT EXISTS forget_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL, target_value TEXT NOT NULL,
    reason TEXT, session_id TEXT, forgotten_at INTEGER DEFAULT (unixepoch()),
    symbols_removed INTEGER DEFAULT 0, files_removed INTEGER DEFAULT 0
  )`);
  instance.exec(`CREATE INDEX IF NOT EXISTS idx_forget_log_time ON forget_log(forgotten_at DESC)`);
} catch { /* already exists */ }
```

#### `src/parser/IncrementalParser.ts`
```typescript
import { minimatch } from 'minimatch';

forgetFile(filePath: string, reason?: string, sessionId?: string): { files: number; symbols: number } {
  const db = getDb();
  const file = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number } | undefined;
  const symbolsBefore = file
    ? (db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE file_id = ?').get(file.id) as { n: number }).n
    : 0;

  this.removeFile(filePath); // existing cleanup — symbols + FTS + cascade

  db.prepare(`
    INSERT INTO forget_log (target_type, target_value, reason, session_id, symbols_removed, files_removed)
    VALUES ('file', ?, ?, ?, ?, ?)
  `).run(filePath, reason ?? null, sessionId ?? null, symbolsBefore, file ? 1 : 0);

  return { files: file ? 1 : 0, symbols: symbolsBefore };
}

forgetPattern(glob: string, reason?: string, sessionId?: string): { files: number; symbols: number } {
  const db = getDb();
  const allPaths = (db.prepare('SELECT path FROM files').all() as { path: string }[])
    .map(r => r.path)
    .filter(p => minimatch(p, glob, { matchBase: true }));

  let totalFiles = 0, totalSymbols = 0;
  for (const p of allPaths) {
    const r = this.forgetFile(p, reason, sessionId);
    totalFiles += r.files;
    totalSymbols += r.symbols;
  }
  // One summary log entry for the pattern itself
  db.prepare(`
    INSERT INTO forget_log (target_type, target_value, reason, session_id, symbols_removed, files_removed)
    VALUES ('pattern', ?, ?, ?, ?, ?)
  `).run(glob, reason ?? null, sessionId ?? null, totalSymbols, totalFiles);
  return { files: totalFiles, symbols: totalSymbols };
}
```

#### `src/mcp/McpServer.ts` — Tools 18 + 19
- `forget`: takes `target`, `type` (`file|symbol|pattern`), optional `reason`, optional `dry_run`
- `get_forget_log`: returns last N entries from `forget_log`

#### Watcher skip-set (restart-safe)
```typescript
// In FileWatcher.start(), load existing forget_log on startup:
const forgotten = new Set<string>(
  db.prepare("SELECT target_value FROM forget_log WHERE target_type = 'file'")
    .all() as { target_value: string }[]
).map(r => r.target_value);
// Then in parseFile enqueue: skip if forgotten.has(filePath)
```

### Tests to Write
- `forgetFile('src/config/secrets.ts')` removes from files + symbols + symbols_fts + forget_log written
- `forgetPattern('**/*.generated.ts')` matches all generated files
- Re-indexing a forgotten file (via `reindex`) re-adds it
- `get_forget_log` returns newest-first with correct counts
- Dry-run returns count without deleting

---

## Phase 0 — Close the Deployment Gap
**Confidence: 99/100**

### What It Does
Nothing in this plan can be honestly measured (Phase 6) until Continuum is
actually running against real, daily-use projects. Right now it isn't: the
reviewer's own 3 production repos (WebAPI, WebAPP, Databaseapp) are still on
the pre-hooks global config, and across 8 real sessions, zero hooks have ever
fired. This is an action, not a build task, and it has to happen before Phase
4 and Phase 6 can produce real numbers instead of estimates.

### Steps
1. Commit the two changes currently sitting in the working tree: the hook
   `DB_PATH` routing fix (`src/cli/index.ts`) and the README rewrite.
2. Run `continuum init` inside each of the 3 real projects.
3. Confirm via `continuum status` in each that all 5 hooks show wired and the
   project root is correctly detected.
4. Remove (or leave inert — project-level `.mcp.json` takes precedence
   regardless) the old `WATCH_PATHS`-based entry in `~/.claude.json`.

### Tests to Write
None — this is a deployment step, not new code. Verification is `continuum
status` reporting `5/5 wired` on each real project, confirmed by hand.

---

## Phase 3 — Branch-Scoped Sessions
**Confidence: 95/100**

### What It Does
Today, `sessions` has no concept of git branch. Working on two different
efforts in the same repo (a feature branch yesterday, a hotfix on `main`
today) shares one undifferentiated task history — a real, confirmed gap
(Case 9 in `MULTI_WORKSPACE_DESIGN.md`). The fix is narrow: the code/symbol
index stays branch-agnostic (correct, since hash-based reparsing already
keeps it current); only session memory needs to know which branch it belongs to.

### Files to Change

#### `src/database/schema.sql`
```sql
ALTER TABLE sessions ADD COLUMN branch TEXT DEFAULT 'default';
```

#### `src/database/Database.ts` — `runMigrations()`
```typescript
try { instance.exec(`ALTER TABLE sessions ADD COLUMN branch TEXT DEFAULT 'default'`); } catch { /* already exists */ }
```

#### `src/session/SessionEngine.ts`
```typescript
import { execSync } from 'child_process';

function detectBranch(projectRoot: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim() || 'default';
  } catch {
    return 'default'; // not a git repo, or detached HEAD
  }
}
```
Use in `initSession()`'s resume query:
```sql
SELECT id FROM sessions WHERE updated_at > ? AND branch = ? ORDER BY updated_at DESC LIMIT 1
```
`tasks` and `touched_files` need no schema change — both are already
foreign-keyed to `session_id`, so branch scoping is inherited automatically.

### Tests to Write
- `detectBranch()` returns the correct branch name in a real git repo
- `detectBranch()` returns `'default'` for a non-git directory
- Session resume only matches sessions on the same branch
- Switching branches mid-session-window starts a fresh, correctly-scoped session
- Non-git projects behave exactly as before (no regression)

---

## Phase 4 — Token-Efficiency Benchmark
**Confidence: 85/100**

### What It Does
Builds the actual measurement described in `TESTING_PLAN.md` §2.3. This
project has already shipped one fabricated token-savings metric before
(caught and replaced with `total_tokens_returned`, a real sum). This phase
exists so the next efficiency claim is measured, not argued.

### Approach
1. Define 8–10 fixed representative tasks (e.g. "find where auth is handled,"
   "what does this file depend on," "resume this session after a compaction").
2. Run each task twice against a real project (unlocked by Phase 0 — needs
   actual usage history to be meaningful): once with only ordinary
   file-reading tools available, once with Continuum's tools available.
3. Record real token counts from the model API's own usage reporting for
   each run.
4. Report the distribution (min/median/max), not a single cherry-picked number.

### Files to Change
No product code — this is a benchmark harness and a results document
(`benchmark/TOKEN_EFFICIENCY.md`, following the same pattern as agentmemory's
own `benchmark/` folder, referenced in `TESTING_PLAN.md`).

### Tests to Write
None in the traditional sense — the "test" is the benchmark run itself
producing a reproducible, re-runnable result with its methodology disclosed
alongside the number.

---

## Phase 5 — Process Lifecycle + Build Reliability
**Confidence: 88/100**

### What It Does
Two small, independent hardening fixes surfaced during review:
1. **Orphaned server processes** — 7 were found running simultaneously on
   the reviewer's own machine from past editor sessions, with no lock file or
   lifecycle check to prevent or clean this up.
2. **Build fragility** — `npm run build` intermittently exhausts its
   configured 4GB heap even on a capable machine; workarounds this session
   used `--skipLibCheck` and/or a larger heap successfully.

### Files to Change

#### `src/mcp/McpServer.ts` — startup
```typescript
// Write a pidfile keyed to the resolved project root; if a live process
// already holds it, log and continue without starting a second FileWatcher
// against the same root (still safe today per WAL, just wasteful).
```

#### `package.json` — build script
```json
"build": "NODE_OPTIONS=--max-old-space-size=8192 tsc --skipLibCheck && mkdir -p dist/database && cp src/database/schema.sql dist/database/"
```
Confirm `skipLibCheck` doesn't hide a real type error before adopting it
permanently — run a clean `tsc --noEmit` (no skipLibCheck) at least once
after this change to confirm nothing is being silently masked.

### Tests to Write
- Starting a second server against an already-running root's pidfile is
  detected (doesn't need to block it — today's dual-process behavior is safe,
  just wasteful — but it must be visible in `continuum status`)
- `npm run build` completes without OOM on a clean checkout, measured heap ceiling documented

---

## Phase 6 — Execute the Testing Plan
**Confidence: 90/100**

### What It Does
`TESTING_PLAN.md` is a design, not a result. This phase runs it for real,
against real data unlocked by Phase 0:
- Regression tests for every bug found this review cycle (§1.2 in the testing plan)
- The isolation test (§1.3) — two separate projects, assert zero cross-leakage
- Coverage push on `FileWatcher.ts`, `cli/index.ts`, `ContextGenerator.ts` to ≥70%
- Recall@5/@10/MRR measurement (§2.1) against the real production symbol index
- p50/p95 latency pulled from real `tool_usage.duration_ms` (§2.2)
- Stale-data correctness metric (§2.5) — controlled deletion batch, measure orphan count

### Files to Change
Primarily `tests/` — new regression test files per bug, plus a
`benchmark/` folder for the recall/latency/token results, matching the
structure `TESTING_PLAN.md` references from agentmemory's own repo.

### Tests to Write
Covered above — this phase *is* the test-writing phase.

---

## Phase 7 — Multi-Repo Connection Manager + Fan-Out
**Confidence: 70/100 — the largest, least-precedented phase in this plan**

### What It Does
Implements the design in `MULTI_WORKSPACE_DESIGN.md` in full: live workspace
discovery via the MCP `roots` protocol (confirmed available in the installed
SDK, zero lines currently call it), a connection manager tracking which
per-repo databases are "in view," dynamic `FileWatcher` path add/remove, and
fan-out versions of `search_symbols`/`smart_search`/`get_session` that query
every open connection and tag results by repo of origin.

### Sub-phases (each independently testable, per the design doc's own build order)
1. Per-repo connection manager (`forEachOpenRepo`, `searchAcross` helpers) — ~2-3 days
2. Roots discovery wired to the connection manager, containment check for nested roots — ~1-2 days
3. `FileWatcher` dynamic add/remove of watch paths — ~1 day
4. Fan-out `search_symbols`/`smart_search`/`get_session` — ~3-4 days
5. Cross-cutting `save_task` duplication across open repos — ~0.5 day
6. Hardening pass: WAL checkpoint interval, parse-queue cap, per-connection cache sizing — ~1-2 days

### Why confidence is lower here than everywhere else in this plan
This is genuinely new architecture, not an extension of an existing pattern
(unlike Phases 1–6, which all follow patterns already proven in this
codebase). The MCP `roots` protocol has never been exercised against this
server. Real-world testing against actual multi-root workspace behavior in
Claude Code is required before this can be called done — a design document
and an SDK capability check are not the same as verified behavior.

### Files to Change
Full detail already lives in `MULTI_WORKSPACE_DESIGN.md` — this entry exists
to place it in the sequenced plan, not duplicate its content.

### Tests to Write
- Two repos open simultaneously: search returns results from both, tagged correctly
- A third repo added mid-session (simulated `roots/list_changed`) is picked up without restart
- A repo removed mid-session stops appearing in fan-out results, its DB file untouched on disk
- Nested roots (a monorepo + one of its own subpackages) don't double-index
- A repo opened solo, then as part of a group, resolves to the *same* database both times (no fragmentation)

---

## Phase 8 — Knowledge-Graph Expansion
**Confidence: 74/100**

### What It Does
Adds `calls`, `extends`, and `implements` relationship edges from tree-sitter AST.
Upgrades `find_related_files` to 1-hop graph traversal.
New `get_graph` MCP tool for multi-hop queries.

### Dependency
✅ Tree-sitter shipped. Call edges from regex are not accurate enough.

### Critical Design Fix vs Original Plan
> ⚠️ The existing `storeImportRelationships()` anchors all edges to the **first symbol
> in the file**. That works for file-level imports but NOT for call edges.
> A `from_id` for a call edge must be the **specific calling symbol** — the method
> or function that contains the call. This requires walking the symbol list
> and matching by line range, not just taking the first.

```typescript
function findEnclosingSymbol(
  symbols: { id: number; start_line: number; end_line: number }[],
  callLine: number
): number | null {
  // Find the smallest symbol whose line range contains callLine
  const candidates = symbols.filter(s => s.start_line <= callLine && s.end_line >= callLine);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.start_line - a.start_line)); // innermost first
  return candidates[0].id;
}
```

### Files to Change

#### `src/database/schema.sql` — new table
```sql
CREATE TABLE IF NOT EXISTS graph_nodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL,  -- 'module' | 'package' | 'directory'
  path       TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_name ON graph_nodes(name);
```

#### `src/parser/TreeSitterExtractor.ts` — new export
```typescript
export interface RelationshipEdge {
  from_name:       string;
  from_start_line: number;  // needed to find enclosing symbol
  to_name:         string;
  kind:            'calls' | 'extends' | 'implements';
}

// Node types per language (grounded in actual GRAMMAR_CONFIGS):
// TypeScript:  call_expression, member_expression, extends_clause
// JavaScript:  call_expression, member_expression
// Python:      call (python grammar), class_definition.bases
// C#:          invocation_expression, base_list
// Java:        method_invocation, superclass, super_interfaces
// Go:          call_expression, interface_type

export function extractRelationships(tree: TSTree, langName: string): RelationshipEdge[]
```

#### `src/parser/IncrementalParser.ts`
After tree-sitter extraction and symbols stored:
```typescript
if (actualParser === 'treesitter') {
  const edges = extractRelationships(tree, langName);
  storeRelationshipEdges(filePath, fileId, edges, symbolsList, db);
}
```

`storeRelationshipEdges()` uses `findEnclosingSymbol()` for call edges.
For extends/implements, anchor to the class symbol directly by name.

#### `src/knowledge/KnowledgeEngine.ts` — upgrade `findRelated()`
```sql
-- Existing LIKE search UNION 1-hop traversal:
SELECT DISTINCT f2.path, f2.language
FROM relationships r
JOIN symbols s1 ON r.from_id = s1.id
JOIN files    f1 ON s1.file_id = f1.id
JOIN symbols  s2 ON s2.name = r.to_name
JOIN files    f2 ON s2.file_id = f2.id
WHERE (f1.path LIKE ? OR s1.name LIKE ?)
  AND r.kind IN ('calls','extends','implements','imports')
LIMIT 20
```
> Guard against circular traversal at the application layer with a `visited` Set.

#### `src/mcp/McpServer.ts` — Tool 20
```typescript
server.tool('get_graph', ..., {
  target: z.string(),
  depth:  z.number().int().min(1).max(3).optional().default(1),
  kinds:  z.array(z.enum(['imports','calls','extends','implements'])).optional()
})
```

### Risk Table
| Risk | Mitigation |
|---|---|
| `call_expression` has different node types per language | Document per-language mappings in code (they exist for symbols already — same pattern) |
| call_expression nodes are very numerous | Filter only direct named calls, not chained expressions |
| `from_id` line-range lookup slow | Symbols list is already in memory from parseFile — no extra DB call |
| Graph traversal circular loop | `visited: Set<number>` in DFS |
| Only treesitter files have call edges | Documented clearly; regex files keep imports only |

### Tests to Write
- TS class `extends Base` → `extends` edge in relationships
- TS `foo()` call → `calls` edge with correct `from_id` pointing to enclosing method
- `findRelated()` returns files connected via graph
- `get_graph(depth=2)` returns 2-hop files without infinite loop
- No duplicate edges on reindex

---

## Phase 9 — Vector / Semantic Search
**Confidence: 58/100**

### What It Does
Opt-in (`EMBEDDING_MODEL=local`) local embedding of symbols via `@xenova/transformers`
(`all-MiniLM-L6-v2`, 384-dim). RRF fusion with FTS5 results.

Example: `"authenticate user"` → finds `verifyJWT`, `checkCredentials`, `AuthMiddleware`.

### Dependencies
- ✅ Tree-sitter (clean symbol names to embed)
- ✅ Phase 1 (clean FTS for RRF merge)
- New optional dep: `@xenova/transformers@^2.x` (~100MB)

### Why 58/100
- `@xenova/transformers` WASM may conflict with `web-tree-sitter` WASM (two WASM VMs)
- Memory scaling is the biggest unknown — 384 floats × 4 bytes = 1.5KB per symbol; 50k symbols = 75MB just for embeddings in RAM
- RRF tuning (k parameter) requires real-world calibration
- `@xenova/transformers` v2 vs v3 API surface is changing

### Files to Change

#### `src/database/schema.sql`
```sql
CREATE TABLE IF NOT EXISTS symbol_embeddings (
  symbol_id  INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  embedding  BLOB    NOT NULL,   -- Float32Array, 384 dims, little-endian binary
  model      TEXT    NOT NULL,   -- 'all-MiniLM-L6-v2'
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_embeddings_symbol ON symbol_embeddings(symbol_id);
```

#### New: `src/embeddings/EmbeddingEngine.ts`
```typescript
export class EmbeddingEngine {
  private pipeline: unknown | null = null;

  isEnabled(): boolean { return !!process.env['EMBEDDING_MODEL']; }

  async embed(texts: string[]): Promise<Float32Array[]> {
    // lazy load @xenova/transformers only when enabled
    // batch in chunks of 64 to limit memory pressure
  }

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    // standard dot(a,b) / (norm(a) * norm(b))
  }
}
```

#### `src/parser/IncrementalParser.ts`
After symbols stored, if embedding enabled:
```typescript
// Non-blocking — run after the sync parse completes
setImmediate(async () => {
  const texts = symbols.map(s => `${s.kind} ${s.name} ${s.signature}`);
  const embeddings = await embeddingEngine.embed(texts);
  // batch insert into symbol_embeddings
});
```

#### `src/knowledge/KnowledgeEngine.ts`
```typescript
// Streaming similarity — DO NOT load all embeddings at once
// Process in chunks of 1000 to cap memory at ~1.5MB per chunk
async semanticSearch(query: string, limit = 20): Promise<SymbolSearchResult[]> {
  const queryVec = await embeddingEngine.embed([query])[0];
  const CHUNK_SIZE = 1000;
  // paginate through symbol_embeddings with LIMIT/OFFSET
  // maintain top-N heap
}
```

#### `src/mcp/McpServer.ts`
- `smart_search` upgraded to include semantic results when enabled
- New standalone `semantic_search` tool (Tool 21)

### Risk Table
| Risk | Mitigation |
|---|---|
| `@xenova/transformers` ~100MB download | Optional dep — zero impact if not installed |
| WASM conflict with web-tree-sitter | Test coexistence first; if conflict, use `node-llama-cpp` as fallback |
| Memory: loading all embeddings | Chunked streaming with heap — never load all at once |
| RRF k-parameter needs tuning | Start with k=60 (standard default), expose as env var |
| Stale embeddings after reindex | CASCADE delete on symbols(id) handles this automatically |

> ⚠️ **Do not start this phase until Phases 1, 2, and 8 are running on a real project.**
> Validate symbol quality first. Bad input → bad embeddings → bad search.

### Tests to Write
- `EmbeddingEngine.isEnabled()` false when no env var
- `embed(['hello world'])` returns Float32Array of length 384
- `cosineSimilarity(identical, identical)` ≈ 1.0
- `semanticSearch` returns results without loading all embeddings at once
- Stale embedding auto-deleted when symbol deleted (CASCADE)

---

## Phase 10 — Multi-Agent Isolation
**Confidence: 93/100**

### What It Does
`AGENT_ID` scoping so Claude + Copilot running simultaneously have separate sessions.

### Files to Change

**`src/database/Database.ts`** — `runMigrations()`:
```typescript
try { instance.exec(`ALTER TABLE sessions ADD COLUMN agent_id TEXT DEFAULT 'default'`); } catch {}
try { instance.exec(`ALTER TABLE touched_files ADD COLUMN agent_id TEXT DEFAULT 'default'`); } catch {}
try { instance.exec(`ALTER TABLE tasks ADD COLUMN agent_id TEXT DEFAULT 'default'`); } catch {}
try { instance.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id)`); } catch {}
```

**`src/session/SessionEngine.ts`**:
- Add `private readonly agentId = process.env['AGENT_ID'] ?? 'default'`
- Add `WHERE agent_id = ?` to all session queries

**`src/mcp/McpServer.ts`**:
- `health_check` output includes `agent_id`

### Risk Table
| Risk | Mitigation |
|---|---|
| Existing rows lose `agent_id` | `DEFAULT 'default'` in ALTER preserves all existing data |
| No production use case yet | Build only when needed — kept here for design completeness |

---

## Phase 11 — Multi-Client Installer
**Confidence: 80/100**

### What It Does
`continuum init` today only writes Claude Code's config format
(`.mcp.json` + `.claude/settings.json`). Cursor, Copilot CLI, and Windsurf
each expect the MCP server registered in a different file/format, and there's
no `continuum connect <tool>` equivalent — a real gap versus the nearest
comparable project, which ships exactly this kind of per-tool installer.

### Approach
1. Research each target tool's actual config format (Cursor: `~/.cursor/mcp.json`
   or project-level `.cursor/mcp.json`; Copilot CLI: `~/.copilot/mcp-config.json`;
   Windsurf: similar `mcpServers` block in its own config path).
2. Add a `connect` command to `src/cli/index.ts`: `continuum connect cursor`,
   `continuum connect copilot`, etc., each writing the correct format with the
   same `PROJECT_ROOT`-based resolution already used for Claude Code.
3. Document plainly, per client, that the hook-driven zero-cooperation
   capture layer is Claude-Code-specific — other clients get the MCP tools
   but not automatic hooks, since none of them have an equivalent event system.

### Files to Change
`src/cli/index.ts` — new `connect` subcommand, one handler function per
supported tool, sharing the existing `detectProjectRoot()`/`resolveDbPath()` logic.

### Tests to Write
- `continuum connect cursor` writes valid JSON in Cursor's expected format and location
- Running it twice is idempotent, same pattern as `init`
- Existing unrelated entries in each tool's config file are preserved (non-destructive merge, matching `init`'s existing behavior)

---

## Phase 12 — VS Code Extension
**Confidence: 78/100**

### Architecture (thin wrapper, no shared code)
```
packages/vscode-extension/
  package.json          ← "engines": { "vscode": "^1.90.0" }
  src/extension.ts      ← activate(): registers statusBar + commands
  src/statusBar.ts      ← polls `continuum status --json` every 10s
  src/commands.ts       ← continuum.init, continuum.openContext
  .vscodeignore
  README.md
  CHANGELOG.md
```

All communication via `child_process.execFile('continuum', ['status', '--json'])`.
No shared Node.js runtime with Continuum itself. No source imports.

### When to Build
Only after at least 3 users request it. `continuum init` covers 80% of this value already.
The CLI approach is sufficient for power users.

### Risk Table
| Risk | Mitigation |
|---|---|
| VS Code extension host Node version conflicts | Extension only shells out — completely isolated |
| Marketplace approval delay (~1 week) | Plan for it, not a blocker |
| VS Code API version churn | Pin to `vscode ^1.90.0` (LTS stable) |

---

## Build Order + Commit Convention

```
                                                            Effort      Elapsed
Sprint 1:   Phase 1 — BM25 token expansion                 ~1 day      ✅ SHIPPED
Sprint 2:   Phase 2 — forget + audit log                   ~1 day      ✅ SHIPPED
-------------------------------------------------------------------------------
Sprint 3:   Phase 0 — Close the deployment gap             ~1 hour     Day 1
Sprint 4:   Phase 3 — Branch-scoped sessions                ~1 day      Day 1-2
Sprint 5:   Phase 4 — Token-efficiency benchmark            ~1 day      Day 2-3
Sprint 6:   Phase 5 — Process lifecycle + build reliability ~1-2 days   Day 3-5
Sprint 7:   Phase 6 — Execute the testing plan              ~3 days     Day 5-8
-------------------------------------------------------------------------------
Sprint 8:   Phase 7 — Multi-repo connection manager         ~9-13 days  Day 8-21
            + fan-out (largest single phase)
-------------------------------------------------------------------------------
Sprint 9:   Phase 11 — Multi-client installer               ~2-3 days   Day 21-24
Sprint 10:  Phase 8 — Knowledge graph                       ~3 days     Day 24-27
Sprint 11:  Phase 9 — Semantic search                       ~1 week     Day 27-34
Sprint 12:  Phase 10 — Multi-agent (when needed)            ~0.5 days   as needed
Sprint 13:  Phase 12 — VS Code (when requested)             ~3 days     as needed
```

**Total to close everything currently planned: ~24 working days (~5 weeks)**
from Phase 0 through Phase 9, not counting Phases 10/12 which are explicitly
gated on "when needed"/"when requested" rather than scheduled.

**If only closing the near-term gaps that unlock honest measurement** (Phases
0, 3, 4, 5, 6 — everything through the testing plan execution, before the
large multi-repo phase): **~8-9 working days, under 2 weeks.**

Commit format per phase:
```
feat(phase-N): <description>

- Schema changes (migrations added)
- Files changed
- Tests added/updated
- ROADMAP.md: move item from Next→Shipped
```

---

## Pre-Build Checklist (Must Pass Before Starting Each Phase)

```bash
npx vitest run       # 94/94 ✅
npx tsc --noEmit     # 0 errors ✅ (use --skipLibCheck if it OOMs — see Phase 5)
git status --short   # clean — commit Phase 0's pending fixes before starting anything else
git log --oneline -1 # confirm you're on latest commit
```

---

## What NOT to Rebuild (Already Done — Do Not Touch)

| Capability | Location |
|---|---|
| FTS contentless→self-contained migration | `Database.ts:migrateContentlessFts()` |
| File removal (symbols + FTS + cascade) | `IncrementalParser.ts:removeFile()` |
| Startup orphan sweep | `IncrementalParser.ts:sweepOrphans()` |
| Import edges in relationships | `IncrementalParser.ts:storeImportRelationships()` |
| Tree-sitter lazy init + fallback | `TreeSitterExtractor.ts:ensureTreeSitter()` |
| Per-file `parser` column + migration | `schema.sql` + `Database.ts` |
| camelCase FTS + LIKE merged search | `KnowledgeEngine.ts:searchSymbols()` |
| Session resume, task GC, 5 hooks | `SessionEngine.ts` |
| splitCamelCase logic foundation | Already used in FTS search — Phase 1 formalised it |
| BM25 `name_tokens` + `forget_log` (Phases 1-2) | `schema.sql`, `KnowledgeEngine.ts`, `IncrementalParser.ts:forgetFile/forgetPattern` |
| Project root resolution via `CLAUDE_PROJECT_DIR`/`PROJECT_ROOT` | `src/utils/projectRoot.ts` — do not reintroduce a `.mcp.json` `"cwd"` field, it is not a supported Claude Code config field |

---

*Last refined: July 2026 — baseline commit `a9ffb5d`, 94/94 tests passing*
*Confidence: 84/100 — Phase 7 (multi-repo connection manager) is the primary uncertainty*
