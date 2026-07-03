-- ─────────────────────────────────────────────────────────────────────────────
-- Continuum v1.0 — SQLite Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Server metadata (version, boot tracking)
CREATE TABLE IF NOT EXISTS metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Files indexed from watched directories
CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path         TEXT    NOT NULL UNIQUE,
  language     TEXT,                 -- 'typescript' | 'python' | 'rust' | ...
  last_parsed  INTEGER,              -- unix epoch
  hash         TEXT,                 -- MD5 of file content for dedup
  size_bytes   INTEGER,
  symbol_count INTEGER DEFAULT 0,
  created_at   INTEGER DEFAULT (unixepoch()),
  updated_at   INTEGER DEFAULT (unixepoch())
);

-- Symbols extracted from files (classes, functions, methods, etc.)
CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL, -- class | function | method | interface | enum | struct | trait | module | property | constructor
  start_line  INTEGER,
  end_line    INTEGER,
  signature   TEXT,             -- first ~120 chars of the definition
  created_at  INTEGER DEFAULT (unixepoch())
);

-- Full-text search index over symbol names (SQLite FTS5)
-- Self-contained (not contentless): column values must be readable via JOIN
-- for search ranking to work. A contentless (content='') table cannot be
-- read outside a MATCH clause, which silently breaks the ranked-search JOIN.
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name,
  kind,
  file_path
);

-- Relationships between symbols (imports, calls, extends, implements)
-- NOTE: This table is schema-reserved for Phase 4 (Dependency Graphing via Tree-sitter/AST).
-- The get_dependencies tool queries it today and returns an empty array until Phase 4 populates it.
-- Do not remove — it is intentional scaffolding, not dead code.
CREATE TABLE IF NOT EXISTS relationships (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_name   TEXT    NOT NULL,
  kind      TEXT    NOT NULL, -- calls | imports | extends | implements | uses
  created_at INTEGER DEFAULT (unixepoch())
);

-- Active coding sessions
CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT    PRIMARY KEY,   -- UUID
  goal             TEXT,
  started_at       INTEGER DEFAULT (unixepoch()),
  updated_at       INTEGER DEFAULT (unixepoch()),
  compaction_count INTEGER DEFAULT 0
);

-- Files touched during a session (opened, modified, created, deleted)
CREATE TABLE IF NOT EXISTS touched_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path       TEXT    NOT NULL,
  action     TEXT    NOT NULL, -- opened | modified | created | deleted
  touched_at INTEGER DEFAULT (unixepoch())
);

-- Structured task state saved by AI during a session
CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  goal           TEXT,
  decisions      TEXT,          -- JSON array of strings
  next_steps     TEXT,          -- JSON array of strings
  open_questions TEXT,          -- JSON array of strings
  saved_at       INTEGER DEFAULT (unixepoch())
);

-- Manual feature-to-file mappings (populated by AI via register_feature tool)
CREATE TABLE IF NOT EXISTS features (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  layer       TEXT    NOT NULL, -- controller | service | repository | ui | test | db | model
  file_path   TEXT    NOT NULL,
  description TEXT,
  created_at  INTEGER DEFAULT (unixepoch())
);

-- Cached live database schema (populated by get_schema tool)
CREATE TABLE IF NOT EXISTS schema_cache (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name  TEXT    NOT NULL UNIQUE,
  schema_json TEXT    NOT NULL,
  cached_at   INTEGER DEFAULT (unixepoch())
);

-- Consolidated session summaries written by the Stop hook on session end
CREATE TABLE IF NOT EXISTS session_summaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  goal          TEXT,
  key_decisions TEXT,   -- JSON array, max 10 items
  resume_steps  TEXT,   -- JSON array, max 3 items
  files_count   INTEGER DEFAULT 0,
  task_count    INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id);

-- Tool errors captured by PostToolFailure hook
CREATE TABLE IF NOT EXISTS tool_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  tool_name   TEXT    NOT NULL,
  input_json  TEXT,
  error_msg   TEXT,
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tool_errors_session ON tool_errors(session_id, occurred_at);

-- Every MCP tool call logged for observability
CREATE TABLE IF NOT EXISTS tool_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT,
  tool_name       TEXT    NOT NULL,
  input_json      TEXT,
  tokens_returned INTEGER,
  duration_ms     INTEGER,
  called_at       INTEGER DEFAULT (unixepoch())
);

-- ─── Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_symbols_file      ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name      ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind      ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_touched_session   ON touched_files(session_id);
CREATE INDEX IF NOT EXISTS idx_touched_path      ON touched_files(path);
CREATE INDEX IF NOT EXISTS idx_features_name     ON features(name);
CREATE INDEX IF NOT EXISTS idx_files_language    ON files(language);
CREATE INDEX IF NOT EXISTS idx_tool_session      ON tool_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_name         ON tool_usage(tool_name);
