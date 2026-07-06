# Continuum — Implementation Plan (v2.0 Backlog)
### Confidence Score: 81/100

> Refined after deep re-read of actual source code (July 2026).
> 5 gaps were found and fixed in this version vs the original draft.
> Every risk, file, and schema change is grounded in the real codebase.

---

## Why 81/100 — Honest Breakdown

| Phase | Confidence | Main Uncertainty |
|---|---|---|
| Phase 1 — BM25 / camelCase | 91% | FTS5 multi-column MATCH syntax needs live testing |
| Phase 2 — `forget` tool | 88% | Pattern matching needs `minimatch` dep or manual glob |
| Phase 3 — Knowledge graph | 74% | call_expression extraction is complex per-language; `from_id` anchoring needs rethink |
| Phase 4 — Semantic search | 58% | Memory scaling, WASM coexistence, @xenova size — most unknowns |
| Phase 5 — Multi-agent | 93% | Trivial scoping, well-understood pattern |
| Phase 6 — VS Code | 78% | VS Code API surface is straightforward, Marketplace publish is new |

**Overall weighted: 81/100.**
The foundation (SQLite, parser, MCP tools) is very solid — that's what keeps it above 80.
Phase 4 is the honest wildcard that pulls it below 90.

---

## Gaps Found in Original Plan (Now Fixed)

1. **FTS5 MATCH syntax was wrong** — `WHERE symbols_fts MATCH 'name:query OR name_tokens:query'` is not valid FTS5 column filter syntax. Correct form is `{name name_tokens}: query*` or build via the FTS5 query syntax properly.
2. **Pattern matching needs a dep** — `forgetPattern(glob)` requires either `minimatch` package or manual string matching. Original plan glossed over this.
3. **`from_id` anchoring for call edges is wrong** — `storeImportRelationships()` anchors to the *first symbol in the file*. For call edges, `from_id` must be the *specific calling symbol*, not the first one. This requires a different lookup.
4. **"Cache all embeddings in memory"** — won't scale beyond ~5k symbols. Plan now specifies chunked streaming with a hard cap.
5. **In-memory skip-set doesn't survive restart** — the forget watcher skip-set is lost on server restart. Fixed: check `forget_log` at startup and rebuild the skip-set.

---

## Current State (Baseline)

```
Tests:    81/81 passing
Build:    tsc clean, 0 errors
Tools:    17 MCP tools
DB:       12 tables, SQLite WAL, FTS5 self-contained
Parser:   regex (default) + tree-sitter (PARSER=treesitter, 6 languages)
Commit:   64183ac
```

---

## Priority & Dependency Map

```
Phase 1: BM25 / camelCase token expansion   ← independent, ~1 day
Phase 2: forget tool + audit log            ← independent, ~1 day
Phase 3: Knowledge-graph (call edges)       ← needs tree-sitter ✅, ~3 days
Phase 4: Vector / semantic search           ← needs tree-sitter ✅ + Phase 1, ~1 week
Phase 5: Multi-agent isolation              ← independent, low priority, ~0.5 days
Phase 6: VS Code extension                  ← independent, build last, ~3 days
```

---

## Phase 1 — BM25 Stemming + camelCase Token Expansion
**Confidence: 91/100**

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
**Confidence: 88/100**

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

## Phase 3 — Knowledge-Graph Expansion
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

## Phase 4 — Vector / Semantic Search
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

> ⚠️ **Do not start this phase until Phases 1–3 are running on a real project.**
> Validate symbol quality first. Bad input → bad embeddings → bad search.

### Tests to Write
- `EmbeddingEngine.isEnabled()` false when no env var
- `embed(['hello world'])` returns Float32Array of length 384
- `cosineSimilarity(identical, identical)` ≈ 1.0
- `semanticSearch` returns results without loading all embeddings at once
- Stale embedding auto-deleted when symbol deleted (CASCADE)

---

## Phase 5 — Multi-Agent Isolation
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

## Phase 6 — VS Code Extension
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
Sprint 1:   Phase 1 — BM25 token expansion         ~1 day
Sprint 2:   Phase 2 — forget + audit log            ~1 day
Sprint 3:   Phase 3 — knowledge graph               ~3 days
Sprint 4:   Phase 4 — semantic search               ~1 week
Sprint 5:   Phase 5 — multi-agent (when needed)     ~0.5 days
Sprint 6:   Phase 6 — VS Code (when requested)      ~3 days
```

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
npx vitest run       # 81/81 ✅
npx tsc --noEmit     # 0 errors ✅
git status --short   # clean ✅
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
| splitCamelCase logic foundation | Already used in FTS search — Phase 1 formalises it |

---

*Last refined: July 2026 — baseline commit 64183ac, 81/81 tests passing*
*Confidence: 81/100 — Phase 4 semantic search is the primary uncertainty*
