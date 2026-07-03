# Continuum — Complete Improvement Plan
### Based on deep source-level analysis of agentmemory v0.9.27

> **How this was researched:** Not just the README — actual source files were read:
> `post-tool-use.ts`, `session-start.ts`, `stop.ts`, `pre-compact.ts`, `prompt-submit.ts`,
> `post-tool-failure.ts`, `hybrid-search.ts`, `vector-index.ts`, `search-index.ts`, `config.ts`,
> `types.ts`, and the full changelog through v0.9.27 (June 2026).
> Every item below is grounded in what agentmemory actually does, not marketing claims.

---

## What agentmemory Actually Does (The Real Architecture)

Before listing improvements, here is what we actually learned from the source:

### How their hooks work (not magic — simple HTTP POSTs)

Every hook is a small Node.js script that reads JSON from `stdin` and POSTs to `localhost:3111`. That's it. The hooks are not clever — they are thin wrappers:

```
Claude fires hook → script reads stdin JSON → POST /agentmemory/observe → exit after 500ms
```

Key details from the source:
- `PostToolUse`: Captures tool name, input, output (truncated to **8000 chars**). Strips base64 images. No dedup in the hook itself — dedup happens server-side via SHA-256.
- `SessionStart`: POSTs to `/agentmemory/session/start`. If `AGENTMEMORY_INJECT_CONTEXT=true`, writes response context to **stdout** — Claude Code reads stdout from hooks as context injection. **1500ms timeout.**
- `Stop`: POSTs to `/agentmemory/summarize` (120s timeout) then `/agentmemory/session/end` (5s). Process exits after 1.5s regardless.
- `PreCompact`: POSTs to `/agentmemory/context` with **1500 token budget**, writes result to stdout. This is how memory survives compaction.
- `PromptSubmit`: Captures user prompt text → POST `/agentmemory/observe`. 3s timeout, exits after 500ms.
- `PostToolFailure`: Captures error + tool name + inputs, sanitized to **4000 chars max**. 3s timeout.

### How their hybrid search actually works

Three independent streams merged via **Reciprocal Rank Fusion (RRF, k=60)**:

```
BM25 score  = bm25Weight  / (60 + rank_in_bm25_results)
Vector score = vectorWeight / (60 + rank_in_vector_results)
Graph score  = graphWeight  / (60 + rank_in_graph_results)

final_score = sum of whichever streams returned a result
```

Default weights: `BM25=0.4, Vector=0.6, Graph=0.3` (configurable via env).

BM25 uses **k1=1.2, b=0.75**, with stemming, synonym expansion (0.7× weight vs 1.0× for exact), and prefix matching (0.5× IDF bonus).

Results are **diversified** to max 3 per session to avoid clustering from a single source.

### What their type system reveals about features Continuum doesn't have

From `types.ts`:
- **Actions** — tracked items with `pending | active | done | blocked | cancelled` + parent-child hierarchies
- **Checkpoints** — validation gates (`ci | approval | deploy | external | timer`) with expiration
- **Crystals** — narrative summaries of completed work with lessons + affected files
- **Lessons** — extracted knowledge with confidence scores + decay config + reinforcement counts
- **Sketches** — ephemeral action groupings with promote/discard lifecycle
- **GraphNode types**: `file | function | concept | error | decision | pattern | library | person | project | preference | location | organization | event`
- **GraphEdge** has 17 relationship types: `uses, imports, causes, fixes` and 13 more
- **ConsolidationTier**: `working | episodic | semantic | procedural`

### Critical security bug they had to fix (v0.9.27)

> "A critical isolation bypass allowed agents to read other agents' memories via the search function."

This tells us multi-agent isolation is **hard to get right**. We should design it correctly from the start.

### What they learned from operating at scale

From the changelog:
- `parseSummaryXml` silently dropped summaries wrapped in markdown fences — **always validate LLM output**
- Graph queries timed out due to O(n) scans → fixed with 3 side-indexes
- Cross-provider fallback failures — need retry logic with fallback chains

---

## The True Gap Analysis

| Layer | agentmemory | Continuum | Verdict |
|---|---|---|---|
| **Session capture** | Automatic via 15 hook scripts | Manual `save_task` | They win — fix this |
| **Pre-compaction rescue** | `PreCompact` hook injects 1500 tokens before compaction | Nothing — context lost | They win — critical fix |
| **Symbol/code index** | None whatsoever | 136k symbols, 17 languages | We win — keep & improve |
| **Search** | BM25 + Vector (cosine) + Graph, RRF fusion | FTS5 + LIKE merged | They win on semantic |
| **Memory structure** | 4 tiers + Actions + Crystals + Lessons + Sketches | Flat tasks table | They win on depth |
| **Session continuity** | Full history, never loses on restart | Resets every boot | They win — fix this |
| **Infrastructure** | 4 ports, REST API, LLM required for full features | 1 process, 1 SQLite | We win on simplicity |
| **Observability** | Real-time viewer port 3113, OpenTelemetry | LOG_LEVEL=debug | They win — add CLI |
| **Error capture** | PostToolFailure hook | Nothing | They win — fixable |
| **Multi-agent** | `AGENT_ID` + `AGENT_SCOPE`, team isolation | Not supported | They win |
| **Knowledge graph** | Full entity/relationship extraction (optional) | relationships table (partial) | They win |
| **Privacy** | Image extraction, 8000-char truncation | None | They win — add it |
| **DB schema** | Live MSSQL/Postgres/MySQL | Live MSSQL/Postgres/MySQL | Tie |

---

## Implementation Plan

Organized by impact, not complexity. Build the most valuable things first.

---

## CRITICAL — Must Fix Before Anything Else

### C1. PreCompact Hook — Memory Rescue Before Compaction

**This is the most important missing feature.** When Claude Code compacts context, Continuum currently loses everything. agentmemory injects 1500 tokens of compressed context *before* compaction fires via a `PreCompact` hook that writes to stdout.

**How to implement:**

Create `.claude/hooks/pre-compact.js` (ships in the Continuum repo as a template):

```javascript
#!/usr/bin/env node
// Continuum PreCompact hook — re-injects session context before compaction
const { execSync } = require('child_process');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    // Read current session state from Continuum's SQLite directly (no HTTP, stdio-safe)
    const DB_PATH = process.env.DB_PATH || './knowledge.db';
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });

    const session = db.prepare(`
      SELECT s.goal, s.compaction_count,
             t.goal as task_goal, t.decisions, t.next_steps, t.open_questions
      FROM sessions s
      LEFT JOIN tasks t ON t.session_id = s.id
      WHERE s.id = (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1)
      ORDER BY t.saved_at DESC LIMIT 1
    `).get();

    const touched = db.prepare(`
      SELECT path, action FROM touched_files
      WHERE session_id = (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1)
        AND touched_at > unixepoch() - 86400
      GROUP BY path ORDER BY MAX(touched_at) DESC LIMIT 20
    `).all();

    db.close();

    if (!session) return;

    // Update compaction count
    const dbWrite = new Database(DB_PATH);
    dbWrite.prepare(`
      UPDATE sessions SET compaction_count = compaction_count + 1
      WHERE id = (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1)
    `).run();
    dbWrite.close();

    // Write context to stdout — Claude Code prepends this to the compacted conversation
    const context = [
      `## Continuum Context Recovery (Compaction #${(session.compaction_count || 0) + 1})`,
      session.goal ? `**Current goal:** ${session.goal}` : '',
      session.task_goal ? `**Last task:** ${session.task_goal}` : '',
      session.decisions ? `**Key decisions:** ${JSON.parse(session.decisions || '[]').slice(0, 5).join('; ')}` : '',
      session.next_steps ? `**Next steps:** ${JSON.parse(session.next_steps || '[]').slice(0, 3).join('; ')}` : '',
      touched.length ? `**Files touched this session:**\n${touched.slice(0, 15).map(f => `- ${f.action}: ${f.path}`).join('\n')}` : '',
      `---`,
    ].filter(Boolean).join('\n');

    process.stdout.write(context);
  } catch (err) {
    // Never crash — compaction must proceed even if hook fails
    process.stderr.write(`[Continuum] PreCompact hook error: ${err.message}\n`);
  }
}

main();
```

**Wire it in `CLAUDE_SETUP.md` and `settings.json` template:**

```json
{
  "hooks": {
    "PreCompact": [{
      "hooks": [{
        "type": "command",
        "command": "node /path/to/continuum/.claude/hooks/pre-compact.js",
        "timeout": 5000
      }]
    }]
  }
}
```

**Checklist:**
- [ ] Create `scripts/hooks/pre-compact.js` (ships with the repo)
- [ ] Reads SQLite directly (no HTTP, safe for stdio transport)
- [ ] Writes compressed context to stdout (Claude Code reads this)
- [ ] Increments `compaction_count` in sessions table
- [ ] Never throws — wraps everything in try/catch
- [ ] Token budget: target < 1500 tokens of output
- [ ] Update `CLAUDE_SETUP.md` with installation instructions
- [ ] Update `README.md` with "Surviving Context Compaction" section
- [ ] Test: verify compaction_count increments correctly
- [ ] Test: verify context appears in conversation after compaction

---

### C2. Stop Hook — Auto-Consolidate on Session End

agentmemory's `Stop` hook calls `/summarize` (120s timeout) then `/session/end`. In Continuum, nothing happens when Claude Code closes.

**Create `scripts/hooks/stop.js`:**

```javascript
#!/usr/bin/env node
const Database = require('better-sqlite3');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const DB_PATH = process.env.DB_PATH || './knowledge.db';
    const db = new Database(DB_PATH);

    // Get current session
    const session = db.prepare(
      'SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1'
    ).get();
    if (!session) return;

    // Get all tasks for this session
    const tasks = db.prepare(`
      SELECT goal, decisions, next_steps FROM tasks
      WHERE session_id = ? ORDER BY saved_at ASC
    `).all(session.id);

    if (tasks.length === 0) return;

    // Build consolidated summary (no LLM needed — deterministic)
    const allDecisions = [...new Set(
      tasks.flatMap(t => JSON.parse(t.decisions || '[]'))
    )];
    const lastTask = tasks[tasks.length - 1];
    const nextSteps = JSON.parse(lastTask.next_steps || '[]');

    const summary = JSON.stringify({
      goal: lastTask.goal,
      decisions: allDecisions.slice(0, 10),
      resume_with: nextSteps.slice(0, 3),
      task_count: tasks.length,
    });

    // Get touched files count
    const filesCount = db.prepare(`
      SELECT COUNT(DISTINCT path) as n FROM touched_files WHERE session_id = ?
    `).get(session.id).n;

    // Store consolidated summary
    db.prepare(`
      INSERT OR REPLACE INTO session_summaries
        (session_id, summary, key_decisions, files_count, created_at)
      VALUES (?, ?, ?, ?, unixepoch())
    `).run(session.id, summary, JSON.stringify(allDecisions), filesCount);

    // Mark session as completed
    db.prepare(
      "UPDATE sessions SET updated_at = unixepoch() WHERE id = ?"
    ).run(session.id);

    db.close();
  } catch (err) {
    process.stderr.write(`[Continuum] Stop hook error: ${err.message}\n`);
  }
}

main();
```

**Checklist:**
- [ ] Create `scripts/hooks/stop.js`
- [ ] Deterministic consolidation (no LLM dependency)
- [ ] Stores to `session_summaries` table (add schema + migration)
- [ ] Wire in `CLAUDE_SETUP.md` settings.json template
- [ ] Test: run Claude Code, close session, verify summary written
- [ ] Update `get_recent_sessions` tool to include summary from `session_summaries`

---

### C3. PostToolUse Hook — Auto-Capture Every Action

agentmemory captures every tool use automatically. Continuum only knows what the AI manually saves.

**Create `scripts/hooks/post-tool-use.js`:**

```javascript
#!/usr/bin/env node
const Database = require('better-sqlite3');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || data.toolName || '';
    const toolInput = JSON.stringify(data.tool_input || data.toolInput || {});

    // Only capture meaningful tools (skip read-only queries)
    const CAPTURE_TOOLS = ['Edit', 'Write', 'Bash', 'Task', 'WebFetch'];
    if (!CAPTURE_TOOLS.some(t => toolName.includes(t))) return;

    const DB_PATH = process.env.DB_PATH || './knowledge.db';
    const db = new Database(DB_PATH);

    const session = db.prepare(
      'SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1'
    ).get();
    if (!session) return;

    // Capture file path from Edit/Write inputs
    let touchedPath = null;
    try {
      const inp = JSON.parse(toolInput);
      touchedPath = inp.file_path || inp.filePath || null;
    } catch {}

    if (touchedPath) {
      // Debounce: skip if same file touched in last 5 seconds
      const recent = db.prepare(`
        SELECT id FROM touched_files
        WHERE session_id = ? AND path = ? AND touched_at > unixepoch() - 5
      `).get(session.id, touchedPath);

      if (!recent) {
        db.prepare(`
          INSERT INTO touched_files (session_id, path, action, touched_at)
          VALUES (?, ?, 'modified', unixepoch())
        `).run(session.id, touchedPath);
      }
    }

    // Log to tool_usage
    db.prepare(`
      INSERT INTO tool_usage (session_id, tool_name, input_json, tokens_returned, duration_ms, called_at)
      VALUES (?, ?, ?, 0, 0, unixepoch())
    `).run(session.id, toolName, toolInput.slice(0, 4000));

    db.close();
  } catch (err) {
    process.stderr.write(`[Continuum] PostToolUse hook error: ${err.message}\n`);
  }
}

main();
```

**Checklist:**
- [ ] Create `scripts/hooks/post-tool-use.js`
- [ ] Capture Edit/Write/Bash tool uses into `touched_files`
- [ ] Debounce: skip same file within 5 seconds (matches SessionEngine)
- [ ] Truncate inputs to 4000 chars (matches agentmemory pattern)
- [ ] Wire in `CLAUDE_SETUP.md` settings.json template
- [ ] Test: edit a file, verify it appears in `get_touched_files` without calling `save_task`

---

## HIGH PRIORITY — Core Architecture

### H1. Session Resume on Restart

Every server restart creates a new UUID. Yesterday's work is orphaned in the DB even though it's still there.

**Change in `SessionEngine.initSession()`:**

```typescript
private initSession(): string {
  const db = getDb();
  const resumeHours = parseInt(process.env.SESSION_RESUME_HOURS || '4', 10);

  if (resumeHours > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - (resumeHours * 3600);
    const recent = db.prepare(`
      SELECT id FROM sessions WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 1
    `).get(cutoff) as { id: string } | undefined;

    if (recent) {
      logger.info({ sessionId: recent.id }, 'Resumed recent session');
      return recent.id;
    }
  }

  const id = randomUUID();
  db.prepare(`INSERT INTO sessions (id, started_at, updated_at) VALUES (?, unixepoch(), unixepoch())`).run(id);
  // Prune touched_files older than 24h
  db.prepare(`DELETE FROM touched_files WHERE touched_at <= unixepoch() - 86400`).run();
  logger.info({ sessionId: id }, 'New session started');
  return id;
}
```

**Checklist:**
- [ ] Implement resume logic in `SessionEngine.initSession()`
- [ ] Add `SESSION_RESUME_HOURS` env var (default: `4`, `0` = always new)
- [ ] Update `health_check` to show `resumed: true/false` and `session_age_hours`
- [ ] Update `get_session` response to include `resumed: boolean`
- [ ] Add test: stop + restart, verify session ID matches
- [ ] Document in README Configuration Reference

---

### H2. Session Summaries Table + Consolidation

agentmemory consolidates sessions on Stop into structured memory. This is what makes "resume from last week" work.

**New table in `schema.sql`:**

```sql
CREATE TABLE IF NOT EXISTS session_summaries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT    NOT NULL REFERENCES sessions(id),
  goal            TEXT,
  key_decisions   TEXT,          -- JSON array, max 10 items
  resume_steps    TEXT,          -- JSON array, max 3 items
  files_count     INTEGER DEFAULT 0,
  task_count      INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id);
```

**Checklist:**
- [ ] Add `session_summaries` table to `schema.sql`
- [ ] Add migration in `Database.ts` (`runMigrations()`)
- [ ] Implement `consolidateSession()` in `SessionEngine.ts`
- [ ] Call from `McpServer.ts` shutdown handlers (SIGTERM, SIGINT)
- [ ] Call from `scripts/hooks/stop.js`
- [ ] Update `get_recent_sessions` to JOIN `session_summaries` and return `summary`
- [ ] Update `get_session` to include previous session's summary as context
- [ ] Test: full session → shutdown → restart → verify summary in `get_recent_sessions`

---

### H3. Task Garbage Collection

agentmemory uses Ebbinghaus decay — stale memories weaken and evict. Continuum accumulates tasks forever.

**In `SessionEngine.saveTask()`:**

```typescript
saveTask(task: TaskState): number {
  const db = getDb();
  // ... existing insert ...
  this.pruneOldTasks(db);
  return taskId;
}

private pruneOldTasks(db: BetterSqlite3.Database): void {
  const MAX_TASKS = parseInt(process.env.MAX_TASKS_PER_SESSION || '15', 10);

  const count = (db.prepare(
    'SELECT COUNT(*) as n FROM tasks WHERE session_id = ?'
  ).get(this.sessionId) as { n: number }).n;

  if (count <= MAX_TASKS) return;

  const toRemove = count - MAX_TASKS + 1;

  // Collect oldest tasks to collapse
  const oldest = db.prepare(`
    SELECT goal, decisions, next_steps FROM tasks
    WHERE session_id = ? ORDER BY saved_at ASC LIMIT ?
  `).all(this.sessionId, toRemove) as RawTask[];

  const mergedDecisions = [
    ...new Set(oldest.flatMap(t => JSON.parse(t.decisions || '[]') as string[]))
  ];

  db.transaction(() => {
    db.prepare(`
      DELETE FROM tasks WHERE id IN (
        SELECT id FROM tasks WHERE session_id = ? ORDER BY saved_at ASC LIMIT ?
      )
    `).run(this.sessionId, toRemove);

    db.prepare(`
      INSERT INTO tasks (session_id, goal, decisions, next_steps, open_questions, saved_at)
      VALUES (?, ?, ?, ?, '[]', unixepoch())
    `).run(
      this.sessionId,
      `[Consolidated prior context] ${oldest[oldest.length - 1].goal}`,
      JSON.stringify(mergedDecisions),
      oldest[oldest.length - 1].next_steps
    );
  })();
}
```

**Checklist:**
- [ ] Add `pruneOldTasks()` private method to `SessionEngine.ts`
- [ ] Call from `saveTask()` after insert
- [ ] Add `MAX_TASKS_PER_SESSION` env var (default: `15`)
- [ ] Test: save 20 tasks, verify count stays ≤ 15
- [ ] Test: consolidated entry preserves decisions from merged tasks
- [ ] Document in README

---

### H4. Error Capture — PostToolFailure Hook

agentmemory captures every tool failure. Continuum has no visibility into errors at all.

This is pure value: an AI can call `get_session` after a failure and see the error context. Currently that information vanishes.

**New table in `schema.sql`:**

```sql
CREATE TABLE IF NOT EXISTS tool_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  tool_name   TEXT    NOT NULL,
  input_json  TEXT,
  error_msg   TEXT,
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tool_errors_session ON tool_errors(session_id, occurred_at);
```

**`scripts/hooks/post-tool-failure.js`:**

```javascript
#!/usr/bin/env node
const Database = require('better-sqlite3');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    if (data.is_interrupt) return; // Skip user-initiated interrupts

    const DB_PATH = process.env.DB_PATH || './knowledge.db';
    const db = new Database(DB_PATH);
    const session = db.prepare(
      'SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1'
    ).get();
    if (!session) return;

    db.prepare(`
      INSERT INTO tool_errors (session_id, tool_name, input_json, error_msg)
      VALUES (?, ?, ?, ?)
    `).run(
      session.id,
      String(data.tool_name || '').slice(0, 100),
      JSON.stringify(data.tool_input || {}).slice(0, 4000),
      String(data.error || data.message || '').slice(0, 4000)
    );
    db.close();
  } catch {}
}

main();
```

**Update `get_session` to include recent errors:**

```typescript
const recentErrors = db.prepare(`
  SELECT tool_name, error_msg, occurred_at FROM tool_errors
  WHERE session_id = ? ORDER BY occurred_at DESC LIMIT 5
`).all(this.sessionId);
```

**Checklist:**
- [ ] Add `tool_errors` table to `schema.sql`
- [ ] Add migration in `Database.ts`
- [ ] Create `scripts/hooks/post-tool-failure.js`
- [ ] Update `get_session` to include `recent_errors` array
- [ ] Wire hook in `CLAUDE_SETUP.md`
- [ ] Test: trigger a failing tool, verify error appears in `get_session`

---

## MEDIUM PRIORITY — Search & Intelligence

### M1. Upgrade BM25 with Stemming and Synonym Expansion

agentmemory uses BM25 with k1=1.2, b=0.75, plus stemming and synonyms at 0.7× weight. Continuum uses FTS5's built-in tokenizer with no stemming.

**Practical impact:** "Running" doesn't find "run". "Authentication" doesn't find "auth". "Component" doesn't find "components".

**Approach:** Pre-process symbol names at index time to store stemmed and split forms.

```typescript
// In IncrementalParser.ts — when inserting into symbols_fts
function expandSymbolName(name: string): string {
  // camelCase → individual words: getUserById → "getUserById get user by id"
  const words = name
    .replace(/([A-Z])/g, ' $1')      // camelCase split
    .replace(/[_-]+/g, ' ')          // snake_case / kebab-case split
    .toLowerCase()
    .split(' ')
    .filter(w => w.length > 1);

  const unique = [...new Set([name.toLowerCase(), ...words])];
  return unique.join(' ');
}

// Store expanded name in FTS:
insertFts.run(expandSymbolName(s.name), s.kind, filePath);
// But keep original name in symbols table for JOIN accuracy
```

**Fix the JOIN:** Since FTS now stores expanded text, the `s.name = symbols_fts.name` JOIN breaks. Fix by joining on `file_path + rowid` instead:

```sql
-- Change FTS table to be content-based with rowid tracking
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name_tokens,    -- expanded/stemmed tokens for search
  kind,
  file_path,
  content='symbols',
  content_rowid='id'
);
```

This is a schema change requiring a full reindex. Worth it.

**Checklist:**
- [ ] Implement `expandSymbolName()` utility function
- [ ] Change `symbols_fts` to content-based FTS5 table (schema migration)
- [ ] Update insert/delete in `IncrementalParser.ts` to use `name_tokens`
- [ ] Fix `KnowledgeEngine.searchSymbols()` FTS query to join on rowid
- [ ] Test: "getUserById" found by searching "get", "user", "byid", "getUser"
- [ ] Test: "AuthComponent" found by searching "auth", "component"
- [ ] Run reindex after schema change
- [ ] Benchmark: verify < 20ms search latency maintained

---

### M2. Vector Search (Semantic) — Off by Default

agentmemory defaults `EMBEDDING_PROVIDER` to auto-detect and uses `@xenova/transformers` locally. We implement the same, but **off by default** to preserve zero-infrastructure guarantee.

The key insight from their `vector-index.ts`:
- Embeddings stored as `Float32Array` → serialized to `base64` JSON for persistence
- Cosine similarity: `dot / (√normA × √normB)`
- In-memory `Map<obsId, { embedding: Float32Array, sessionId: string }>`
- Validates dimensions on load to catch provider-change corruption
- Caps heap at configurable size (default 20 results)

**New table:**

```sql
CREATE TABLE IF NOT EXISTS symbol_embeddings (
  symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  embedding   TEXT    NOT NULL,  -- base64-encoded Float32Array
  model       TEXT    NOT NULL,  -- e.g. 'all-MiniLM-L6-v2'
  dimensions  INTEGER NOT NULL,  -- validated on load
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

**`src/search/EmbeddingService.ts`:**

```typescript
export class EmbeddingService {
  private extractor: any = null;
  private readonly model = 'Xenova/all-MiniLM-L6-v2'; // 384 dims, 25MB
  private dimensions: number | null = null;

  isEnabled(): boolean {
    return process.env.EMBEDDING_MODEL === 'local';
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this.isEnabled()) return null;
    if (!this.extractor) {
      const { pipeline } = await import('@xenova/transformers');
      this.extractor = await pipeline('feature-extraction', this.model);
    }
    const out = await this.extractor(text, { pooling: 'mean', normalize: true });
    const vec = new Float32Array(out.data.buffer, out.data.byteOffset, out.data.byteLength / 4);
    if (!this.dimensions) this.dimensions = vec.length;
    else if (vec.length !== this.dimensions) throw new Error('Dimension mismatch');
    return vec;
  }

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }

  serializeEmbedding(vec: Float32Array): string {
    // Node Buffer pool fix (from agentmemory): pass explicit byteOffset + byteLength
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64');
  }

  deserializeEmbedding(b64: string): Float32Array {
    const buf = Buffer.from(b64, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
}
```

**RRF Fusion in `KnowledgeEngine.searchSymbols()`:**

```typescript
// After FTS + LIKE results are gathered:
if (embeddingService.isEnabled()) {
  const qVec = await embeddingService.embed(query);
  if (qVec) {
    const vectorResults = await vectorSearch(qVec, limit);
    results = reciprocalRankFusion(
      [ftsResults, likeResults, vectorResults],
      [0.4, 0.3, 0.6]  // BM25, LIKE, Vector weights
    );
  }
}

function reciprocalRankFusion<T extends { file_path: string; name: string }>(
  rankings: T[][], weights: number[]
): T[] {
  const K = 60;
  const scores = new Map<string, { item: T; score: number }>();

  rankings.forEach((ranking, ri) => {
    ranking.forEach((item, rank) => {
      const key = `${item.name}|${item.file_path}`;
      const rrf = weights[ri] / (K + rank + 1);
      const existing = scores.get(key);
      scores.set(key, {
        item,
        score: (existing?.score ?? 0) + rrf,
      });
    });
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(v => v.item);
}
```

**Checklist:**
- [ ] Add `symbol_embeddings` table to `schema.sql`
- [ ] Create `src/search/EmbeddingService.ts`
- [ ] Background embedding after parse (non-blocking, queue-based)
- [ ] `EMBEDDING_MODEL=local` env var gate (default: disabled)
- [ ] `VECTOR_WEIGHT=0.6`, `BM25_WEIGHT=0.4` env vars
- [ ] RRF fusion in `KnowledgeEngine.searchSymbols()`
- [ ] Dimension validation on load (catches provider changes)
- [ ] Add `@xenova/transformers` as optional peer dep
- [ ] Add `embedding_status` to `health_check` (model loaded, vectors indexed, coverage%)
- [ ] Test: disabled by default — no startup delay, no extra deps needed
- [ ] Test: `verify_jwt` found when searching "user authentication"
- [ ] Benchmark embedding throughput (target: 100 symbols/sec)

---

### M3. Knowledge Graph — Entity Extraction

agentmemory has 13 GraphNode types and 17 GraphEdge relationship types. Our `relationships` table is a start but very limited.

**Expand `relationships` table with proper graph semantics:**

```sql
-- Expand existing relationships table
ALTER TABLE relationships ADD COLUMN weight REAL DEFAULT 1.0;
ALTER TABLE relationships ADD COLUMN context TEXT;   -- why this relationship exists

-- New: graph_nodes for cross-file entity tracking
CREATE TABLE IF NOT EXISTS graph_nodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  node_type  TEXT    NOT NULL,  -- file|function|class|concept|error|decision|pattern
  file_path  TEXT,
  project    TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(name, node_type, file_path)
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_name ON graph_nodes(name);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(node_type);
```

**New `find_related_files` implementation:**

Currently it's just `LIKE '%query%'`. Upgrade it to traverse the graph:

```typescript
// Step 1: find nodes matching query
// Step 2: traverse edges (imports/calls/extends) one hop out
// Step 3: return all files that contain those connected nodes
```

**Checklist:**
- [ ] Add `ALTER TABLE` migrations for `weight` and `context` columns
- [ ] Add `graph_nodes` table to `schema.sql`
- [ ] Populate `graph_nodes` from `symbols` table at parse time
- [ ] Update import extraction to create `graph_nodes` entries
- [ ] Upgrade `find_related_files` to do 1-hop graph traversal
- [ ] Add `GRAPH_EXTRACTION_ENABLED=false` env var (default off, no overhead)
- [ ] Add graph stats to `health_check`

---

## MEDIUM PRIORITY — New MCP Tools

### N1. `smart_search` — Unified Search Across Everything

agentmemory's most-used tool: one query that searches symbols + session history + decisions + files. Continuum requires 3 separate tool calls.

```typescript
server.tool('smart_search',
  'Search everything at once — symbols, session tasks, touched files, and prior decisions. ' +
  'Use this as your first query before calling more specific tools.',
  {
    query: z.string(),
    limit: z.number().optional().default(20),
  },
  async (input) => {
    const [symbols, taskMatches, fileMatches] = await Promise.all([
      knowledge.searchSymbols(input.query, 10),
      session.searchTasks(input.query),        // search task goals + decisions text
      session.searchTouchedFiles(input.query), // search file paths
    ]);
    return { symbols, relevant_tasks: taskMatches, relevant_files: fileMatches };
  }
);
```

**New `SessionEngine` methods:**

```typescript
searchTasks(query: string): { goal: string; decisions: string[]; saved_at: number }[] {
  return this.db.prepare(`
    SELECT goal, decisions, saved_at FROM tasks
    WHERE session_id = ? AND (goal LIKE ? OR decisions LIKE ?)
    ORDER BY saved_at DESC LIMIT 5
  `).all(this.sessionId, `%${query}%`, `%${query}%`);
}

searchTouchedFiles(query: string): TouchedFile[] {
  return this.db.prepare(`
    SELECT path, action, MAX(touched_at) as touched_at
    FROM touched_files
    WHERE session_id = ? AND path LIKE ?
    GROUP BY path ORDER BY touched_at DESC LIMIT 10
  `).all(this.sessionId, `%${query}%`);
}
```

**Checklist:**
- [ ] Add `smart_search` tool to McpServer.ts
- [ ] Add `searchTasks()` and `searchTouchedFiles()` to SessionEngine
- [ ] Update README tools table
- [ ] Test: single query returns symbols + tasks + files

---

### N2. `enrich_context` — Full Picture Before Editing a File

agentmemory's `/enrich` endpoint — before touching a file, get everything known about it.

```typescript
server.tool('enrich_context',
  'Before editing a file, get its full picture: symbols defined, files that import it, ' +
  'recent session activity, and related task decisions. Reduces the need to read the file first.',
  { file_path: z.string() },
  async (input) => {
    const db = getDb();

    const [symbols, importedBy, recentActivity] = await Promise.all([
      // Symbols defined in this file
      knowledge.getFileSummary(input.file_path),

      // Files that import this file (via relationships table)
      db.prepare(`
        SELECT DISTINCT f.path, f.language
        FROM relationships r
        JOIN symbols s ON r.from_id = s.id
        JOIN files f ON s.file_id = f.id
        WHERE r.to_file LIKE ? AND r.kind = 'imports'
        LIMIT 20
      `).all(`%${input.file_path.replace(/\.ts$/, '')}%`) as { path: string; language: string }[],

      // Recent session touches for this file
      db.prepare(`
        SELECT action, touched_at FROM touched_files
        WHERE session_id = ? AND path LIKE ?
        ORDER BY touched_at DESC LIMIT 5
      `).all(session.getSessionId(), `%${input.file_path}%`) as TouchedFile[],
    ]);

    return {
      file: input.file_path,
      symbols,
      imported_by: importedBy,
      recent_activity: recentActivity,
    };
  }
);
```

**Checklist:**
- [ ] Add `enrich_context` tool to McpServer.ts
- [ ] Test on Angular component (should return TS + HTML + SCSS all related)
- [ ] Update README

---

### N3. `list_tables` — Schema Discovery

`get_schema` requires knowing the table name upfront. No way to discover them.

```typescript
server.tool('list_tables',
  'List all tables in the connected database. Use before get_schema to discover table names.',
  {},
  async () => {
    if (!schema.isEnabled()) return { error: 'DB_TYPE not configured' };
    const tables = await schema.listTables();
    return { count: tables.length, tables };
  }
);
```

**Checklist:**
- [ ] Add tool (SchemaReader already has `listTables()`)
- [ ] Update README — tool count now 14+

---

### N4. `forget` — Delete with Audit Trail

```typescript
server.tool('forget',
  'Remove a symbol, task, or file from the index permanently. ' +
  'Use to remove accidentally indexed secrets or stale entries. Writes an audit log entry.',
  {
    kind: z.enum(['symbol', 'task', 'file']),
    identifier: z.string().describe('Symbol name, task ID (number), or file path'),
    reason: z.string().optional(),
  },
  async (input) => {
    // Delete + write to audit_log table
  }
);
```

**Checklist:**
- [ ] Add `audit_log` table to `schema.sql`
- [ ] Implement `forget` tool
- [ ] Cascade delete: symbol → symbols_fts, file → symbols + FTS + relationships
- [ ] Always write audit entry before deletion
- [ ] Update README

---

## LOWER PRIORITY — Developer Experience

### L1. `status` CLI Command

agentmemory has a real-time viewer at port 3113. We don't need that complexity — a good CLI status command covers 90% of the use case.

```bash
npx continuum-ai-mcp status
npx continuum-ai-mcp status --json
npx continuum-ai-mcp status --watch   # poll every 5s
```

**Output:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Continuum v1.1.0  ·  knowledge.db (52MB)  ·  boot #12
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  SESSION   2d4a602a  ·  4h ago  ·  RESUMED  ·  2 compactions survived
  GOAL      Implement auth refactor — JWT refresh rotation

  SYMBOLS   136,458  across  6,107  files
  ├─ typescript    68,274   (1,492 files)
  ├─ csharp        42,666   (1,788 files)
  ├─ sql            1,819   (2,159 files)
  └─ html/css/scss 22,159    (647 files)

  RECENT TOUCHES
  ├─ modified  src/auth/AuthService.ts         2m ago
  ├─ modified  src/auth/JwtHelper.ts           8m ago
  └─ created   tests/auth.test.ts              12m ago

  LAST TASK    "JWT refresh token rotation"    ·  saved 15m ago
  LAST ERROR   none in current session

  EMBEDDING    disabled  (set EMBEDDING_MODEL=local to enable)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Checklist:**
- [ ] Add `status` command to `src/cli/index.ts`
- [ ] Read-only DB open for status (won't lock MCP server)
- [ ] `--json` flag for machine-readable output
- [ ] `--watch` flag for live polling (5s interval)
- [ ] Test: works even if MCP server not running

---

### L2. Multi-Agent Support

agentmemory had a **security bug in v0.9.27** — agents could read each other's memories through search. Design ours correctly from the start.

**Schema additions (migrations only — no table recreate):**

```sql
ALTER TABLE sessions ADD COLUMN agent_id TEXT DEFAULT 'default';
ALTER TABLE touched_files ADD COLUMN agent_id TEXT DEFAULT 'default';
ALTER TABLE tasks ADD COLUMN agent_id TEXT DEFAULT 'default';
```

**Enforcement in `SessionEngine`:**

```typescript
const AGENT_ID = process.env.AGENT_ID || 'default';
const AGENT_SCOPE = process.env.AGENT_SCOPE || 'isolated'; // 'isolated' | 'shared'

// In isolated mode, all queries filter by agent_id
// In shared mode, queries return all agents' data (tagged)
```

**Critical:** Prevent the isolation bypass from agentmemory's bug — always parameterize `agent_id` in WHERE clauses, never string-interpolate.

**Checklist:**
- [ ] Add `agent_id` column migrations (sessions, touched_files, tasks)
- [ ] Add `AGENT_ID` env var (default: `'default'`)
- [ ] Add `AGENT_SCOPE` env var: `'isolated'` (default) | `'shared'`
- [ ] In `isolated` mode: ALL queries filter `WHERE agent_id = ?` (parameterized)
- [ ] In `shared` mode: queries return all, tagged with `agent_id`
- [ ] Security test: with two agent IDs and isolated scope, verify no cross-read
- [ ] Document in README

---

### L3. Privacy Filtering

agentmemory sanitizes to 8000 chars max and strips base64 images. Apply to symbol `signature` field.

```typescript
const REDACT_PATTERNS = [
  { re: /['"`](sk-[A-Za-z0-9]{20,})['"`]/g, label: 'OPENAI_KEY' },
  { re: /['"`](ghp_[A-Za-z0-9]{36})['"`]/g, label: 'GITHUB_TOKEN' },
  { re: /['"`](xoxb-[A-Za-z0-9-]{24,})['"`]/g, label: 'SLACK_TOKEN' },
  { re: /password\s*[:=]\s*['"`][^'"` ]{4,}['"`]/gi, label: 'PASSWORD' },
  { re: /api[_-]?key\s*[:=]\s*['"`][^'"` ]{8,}['"`]/gi, label: 'API_KEY' },
  { re: /secret\s*[:=]\s*['"`][^'"` ]{8,}['"`]/gi, label: 'SECRET' },
  { re: /bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, label: 'BEARER_TOKEN' },
];

function sanitizeSignature(sig: string): string {
  if (!process.env.PRIVACY_FILTERING || process.env.PRIVACY_FILTERING === 'true') {
    let s = sig.slice(0, 8000); // hard cap, matches agentmemory
    for (const { re, label } of REDACT_PATTERNS) {
      s = s.replace(re, `[REDACTED:${label}]`);
    }
    return s;
  }
  return sig.slice(0, 8000);
}
```

**Checklist:**
- [ ] Add `sanitizeSignature()` to `IncrementalParser.ts`
- [ ] Apply to all `signature` values before DB insert
- [ ] Add `PRIVACY_FILTERING=true` env var (default on)
- [ ] Test known secret patterns are redacted
- [ ] Verify performance impact is negligible (regex on 120-char strings)

---

### L4. Test Coverage Completion

New tools and features need tests before publish.

**Checklist:**
- [ ] `tests/hooks.test.ts` — test `pre-compact.js` outputs correct context format
- [ ] `tests/hooks.test.ts` — test `stop.js` writes to `session_summaries`
- [ ] `tests/hooks.test.ts` — test `post-tool-use.js` records file touches
- [ ] `tests/session.test.ts` — test session resume with `SESSION_RESUME_HOURS=4`
- [ ] `tests/session.test.ts` — test `consolidateSession()` writes correct summary
- [ ] `tests/session.test.ts` — test `pruneOldTasks()` caps at MAX_TASKS_PER_SESSION
- [ ] `tests/search.test.ts` — test stemmed FTS: "component" finds "Components"
- [ ] `tests/search.test.ts` — test RRF fusion deduplicates correctly
- [ ] `tests/tools.test.ts` — test `smart_search` returns symbols + tasks + files
- [ ] `tests/tools.test.ts` — test `enrich_context` returns imported_by correctly
- [ ] `tests/tools.test.ts` — test `forget` cascades deletion correctly
- [ ] `tests/multi-agent.test.ts` — test `isolated` scope prevents cross-agent reads
- [ ] Coverage target: ≥ 85% lines

---

### L5. README and Package Cleanup

**Checklist:**
- [ ] Replace all `yourusername` with real GitHub org/repo
- [ ] Fix CI badge URL
- [ ] Verify `.env.example` exists and covers all env vars
- [ ] Update architecture diagram: `13 MCP Tools` → correct count after additions
- [ ] Bump `package.json` version: `1.0.2` → `1.1.0`
- [ ] Add "Hooks Setup" section to README with copy-paste config
- [ ] Add "Performance" section with benchmarked numbers
- [ ] Add `.claude/settings.json` example with all hooks wired

---

## Complete Implementation Checklist

### CRITICAL (Do First)
- [ ] C1: PreCompact hook (`scripts/hooks/pre-compact.js`)
- [ ] C2: Stop hook (`scripts/hooks/stop.js`) + `session_summaries` table
- [ ] C3: PostToolUse hook (`scripts/hooks/post-tool-use.js`)

### HIGH PRIORITY
- [ ] H1: Session resume on restart (`SESSION_RESUME_HOURS`)
- [ ] H2: Session summaries table + consolidation on shutdown
- [ ] H3: Task garbage collection (`MAX_TASKS_PER_SESSION`)
- [ ] H4: PostToolFailure hook + `tool_errors` table

### MEDIUM PRIORITY — Search
- [ ] M1: BM25 improvement with stemming/expansion (reindex required)
- [ ] M2: Vector search via `@xenova/transformers` (opt-in)
- [ ] M3: Knowledge graph expansion + `graph_nodes` table

### MEDIUM PRIORITY — New Tools
- [ ] N1: `smart_search` — unified search
- [ ] N2: `enrich_context` — full file picture
- [ ] N3: `list_tables` — schema discovery
- [ ] N4: `forget` — delete with audit trail

### LOWER PRIORITY — DX
- [ ] L1: `status` CLI command
- [ ] L2: Multi-agent support (`AGENT_ID` + `AGENT_SCOPE`)
- [ ] L3: Privacy filtering on signatures
- [ ] L4: Test coverage ≥ 85%
- [ ] L5: README + package cleanup

---

## Recommended Build Order

```
Sprint 1 (Week 1)  — Context Survival
  C1 PreCompact hook    → context survives compaction TODAY
  C3 PostToolUse hook   → auto-capture without manual save_task
  H1 Session resume     → context survives server restarts

Sprint 2 (Week 2)  — Memory Depth
  C2 Stop hook          → session consolidation on close
  H2 session_summaries  → get_recent_sessions shows real summaries
  H3 Task GC            → prevent unbounded growth
  H4 PostToolFailure    → error visibility in get_session

Sprint 3 (Week 3)  — Search Quality
  M1 BM25 stemming      → "component" finds "Components"
  N1 smart_search       → unified single-query search
  N2 enrich_context     → full file picture before editing

Sprint 4 (Week 4)  — Polish + Publish
  L1 status CLI         → developer visibility
  L3 Privacy filtering  → responsible defaults
  L4 Test coverage      → ≥ 85% before publish
  L5 README cleanup     → no more yourusername placeholders
  Version bump 1.1.0

Sprint 5 (Week 5+) — Advanced
  M2 Vector search      → semantic "user auth" finds verify_jwt
  L2 Multi-agent        → team usage
  M3 Knowledge graph    → full import/call traversal
  N3 list_tables        → schema discovery
  N4 forget + audit     → data hygiene
```

---

## What Continuum Does Better — Do Not Change

| Strength | Why |
|---|---|
| **Symbol-first architecture** | agentmemory has zero code understanding — it knows you *read* a file, not *what's in it*. 136k symbols is Continuum's core moat. |
| **Zero infrastructure** | 1 process, 1 SQLite, no ports, no Docker, no LLM required. agentmemory needs 4 ports + workers + optional LLM. |
| **File watcher** | Proactive — knows about files before the AI touches them. agentmemory only learns via tool calls. |
| **Live DB schema** | `get_schema` + `list_tables` for MSSQL/Postgres/MySQL — no equivalent in agentmemory. |
| **Language depth** | 17 languages with bracket notation, UTF-16, Angular @Component, import graph. Purpose-built for real codebases. |
| **Offline-first** | Everything works with zero network. agentmemory degrades gracefully but prefers a server. |
| **Single config file** | One `.env` file. agentmemory has 40+ env vars across 4 subsystems. |

---

*Document version: 2.0*
*Source: agentmemory v0.9.27 source analysis (hooks/, state/, config.ts, types.ts, changelog)*
*Continuum version at time of writing: 1.0.2*
*Last updated: 2026-07-03*
