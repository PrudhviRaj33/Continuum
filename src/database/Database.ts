import BetterSqlite3 from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { resolveDbPath, detectProjectRoot } from '../utils/projectRoot';

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db: BetterSqlite3.Database | null = null;

/**
 * Resolve the DB path lazily, on first actual use — never at module-import time.
 *
 * Why this matters: with ESM-style `import` (as used by tsx/esbuild), import
 * statements are hoisted above other top-level code in the same file, so a module-level
 * `const DB_PATH = resolveDbPath(...)` would evaluate BEFORE any test (or caller) gets
 * a chance to set process.env.DB_PATH — silently resolving to the wrong project root
 * every time. Computing it inside getDb() guarantees env vars are fully settled first.
 */
function resolveActiveDbPath(): string {
  // Precedence must match resolveWatchPaths() exactly, or the DB and the
  // watcher could disagree on which project root is authoritative:
  // WATCH_PATHS > CLAUDE_PROJECT_DIR (auto-injected by Claude Code) > PROJECT_ROOT > auto-detect
  const projectRoot = process.env.WATCH_PATHS
    ? path.resolve(process.env.WATCH_PATHS.split(',')[0].trim())
    : process.env.CLAUDE_PROJECT_DIR
    ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
    : process.env.PROJECT_ROOT
    ? path.resolve(process.env.PROJECT_ROOT)
    : detectProjectRoot(process.cwd());

  return resolveDbPath(projectRoot);
}

function applyPragmasAndSchema(instance: BetterSqlite3.Database): void {
  instance.pragma('journal_mode = WAL');
  instance.pragma('busy_timeout = 5000');
  instance.pragma('foreign_keys = ON');
  instance.pragma('cache_size = -16000');
  instance.pragma('temp_store = MEMORY');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  instance.exec(schema);

  // Incremental migrations — safe to run on every startup
  runMigrations(instance);
}

function runMigrations(instance: BetterSqlite3.Database): void {
  // Add to_file column to relationships for storing the import module path
  try { instance.exec(`ALTER TABLE relationships ADD COLUMN to_file TEXT`); } catch { /* already exists */ }

  // Add parser column to files to track which extractor produced the symbols
  // 'regex' (default) | 'treesitter' — enables mixed-index visibility in status/reindex
  try { instance.exec(`ALTER TABLE files ADD COLUMN parser TEXT DEFAULT 'regex'`); } catch { /* already exists */ }

  migrateContentlessFts(instance);
  migrateFtsAddTokens(instance);

  // session_summaries — written by Stop hook on session end
  try {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT    NOT NULL,
        goal          TEXT,
        key_decisions TEXT,
        resume_steps  TEXT,
        files_count   INTEGER DEFAULT 0,
        task_count    INTEGER DEFAULT 0,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    instance.exec(`CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id)`);
  } catch { /* already exists */ }

  // tool_errors — written by PostToolFailure hook
  try {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS tool_errors (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT    NOT NULL,
        tool_name   TEXT    NOT NULL,
        input_json  TEXT,
        error_msg   TEXT,
        occurred_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    instance.exec(`CREATE INDEX IF NOT EXISTS idx_tool_errors_session ON tool_errors(session_id, occurred_at)`);
  } catch { /* already exists */ }

  // forget_log — audit trail for forget() calls
  try {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS forget_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type     TEXT    NOT NULL,
        target_value    TEXT    NOT NULL,
        reason          TEXT,
        session_id      TEXT,
        forgotten_at    INTEGER DEFAULT (unixepoch()),
        symbols_removed INTEGER DEFAULT 0,
        files_removed   INTEGER DEFAULT 0
      )
    `);
    instance.exec(`CREATE INDEX IF NOT EXISTS idx_forget_log_time ON forget_log(forgotten_at DESC)`);
    instance.exec(`CREATE INDEX IF NOT EXISTS idx_forget_log_type ON forget_log(target_type, forgotten_at DESC)`);
  } catch { /* already exists */ }
}

/**
 * Repair symbols_fts if it was created in the old contentless mode (content='').
 * Contentless FTS5 tables cannot have their own columns read outside a MATCH
 * clause, which silently broke the ranked-search JOIN in KnowledgeEngine —
 * searchSymbols() was falling back to LIKE-only matching for every query.
 * This drops the old index and rebuilds it as self-contained from the
 * symbols/files tables (the source of truth), which is a pure re-derivation —
 * no user data is lost.
 */
function migrateContentlessFts(instance: BetterSqlite3.Database): void {
  const existing = instance
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'symbols_fts'")
    .get() as { sql: string } | undefined;

  if (!existing || !existing.sql.includes("content=''")) return; // already fixed or fresh install

  process.stderr.write(
    '[Continuum] Migrating symbols_fts to self-contained FTS5 (fixes broken ranked search)...\n'
  );

  instance.exec('DROP TABLE symbols_fts');
  instance.exec(`
    CREATE VIRTUAL TABLE symbols_fts USING fts5(
      name,
      kind,
      file_path
    )
  `);

  instance.exec(`
    INSERT INTO symbols_fts (name, kind, file_path)
    SELECT s.name, s.kind, f.path
    FROM symbols s
    JOIN files f ON s.file_id = f.id
  `);

  const count = (instance.prepare('SELECT COUNT(*) AS n FROM symbols_fts').get() as { n: number }).n;
  process.stderr.write(`[Continuum] symbols_fts rebuilt with ${count} entries.\n`);
}

/**
 * Split a camelCase / PascalCase / snake_case identifier into lowercase tokens.
 * Used to populate name_tokens in symbols_fts for substring search.
 *
 * Examples:
 *   getUserById   → "get user by id"
 *   MyHTTPClient  → "my http client"
 *   parse_file    → "parse file"
 *
 * Exported so IncrementalParser can import it (single source of truth).
 */
export function splitCamelCase(name: string): string {
  return name
    .replace(/_/g, ' ')                          // snake_case → spaces
    .replace(/([a-z])([A-Z])/g, '$1 $2')         // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // HTTPClient → HTTP Client
    .toLowerCase()
    .trim();
}

/**
 * Add name_tokens column to symbols_fts.
 *
 * FTS5 virtual tables do NOT support ALTER TABLE ADD COLUMN, so this must
 * DROP + recreate + re-populate the entire table. Uses the same safe pattern
 * as migrateContentlessFts(). Idempotent — skips if already migrated.
 */
function migrateFtsAddTokens(instance: BetterSqlite3.Database): void {
  // Detect if name_tokens already exists by inspecting the stored DDL
  const existing = instance
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'symbols_fts' AND type = 'table'")
    .get() as { sql: string } | undefined;

  if (!existing || existing.sql.includes('name_tokens')) return; // fresh install or already migrated

  process.stderr.write(
    '[Continuum] Migrating symbols_fts: adding name_tokens for camelCase search...\n'
  );

  // Snapshot existing rows before DROP
  const rows = instance
    .prepare('SELECT name, kind, file_path FROM symbols_fts')
    .all() as { name: string; kind: string; file_path: string }[];

  instance.exec('DROP TABLE symbols_fts');
  instance.exec(`
    CREATE VIRTUAL TABLE symbols_fts USING fts5(
      name,
      name_tokens,
      kind,
      file_path,
      tokenize = 'unicode61'
    )
  `);

  const insert = instance.prepare(
    'INSERT INTO symbols_fts (name, name_tokens, kind, file_path) VALUES (?, ?, ?, ?)'
  );
  instance.transaction(() => {
    for (const r of rows) {
      insert.run(r.name, splitCamelCase(r.name), r.kind, r.file_path);
    }
  })();

  process.stderr.write(
    `[Continuum] symbols_fts rebuilt with name_tokens: ${rows.length} entries.\n`
  );
}

function seedMetadata(instance: BetterSqlite3.Database): void {
  const versionCheck = instance
    .prepare("SELECT value FROM metadata WHERE key = 'version'")
    .get() as { value: string } | undefined;

  if (!versionCheck) {
    const now = Math.floor(Date.now() / 1000);
    instance.prepare("INSERT OR IGNORE INTO metadata VALUES ('version', '1.0.0')").run();
    instance.prepare(`INSERT OR IGNORE INTO metadata VALUES ('first_started', '${now}')`).run();
  }

  instance
    .prepare(`INSERT OR REPLACE INTO metadata VALUES ('last_started', '${Math.floor(Date.now() / 1000)}')`)
    .run();
  instance
    .prepare(
      `INSERT OR REPLACE INTO metadata VALUES ('boot_count',
        CAST((COALESCE((SELECT value FROM metadata WHERE key='boot_count'), 0)) AS INTEGER) + 1
      )`
    )
    .run();
}

function isCorrupt(dbPath: string): boolean {
  try {
    const probe = new BetterSqlite3(dbPath, { readonly: true });
    const result = probe.pragma('integrity_check') as { integrity_check: string }[];
    probe.close();
    return result[0]?.integrity_check !== 'ok';
  } catch {
    return true;
  }
}

function quarantineCorruptDb(dbPath: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const quarantinePath = `${dbPath}.corrupted.${timestamp}`;
  // Move all SQLite files (main + WAL + SHM)
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${dbPath}${suffix}`;
    if (fs.existsSync(src)) {
      fs.renameSync(src, `${quarantinePath}${suffix}`);
    }
  }
  return quarantinePath;
}

function openDb(dbPath: string): BetterSqlite3.Database {
  const dbExists = fs.existsSync(dbPath);

  if (dbExists && isCorrupt(dbPath)) {
    try {
      const quarantinePath = quarantineCorruptDb(dbPath);
      process.stderr.write(
        `[Continuum] WARNING: knowledge.db was corrupted and has been moved to:\n` +
        `  ${quarantinePath}\n` +
        `[Continuum] A fresh database has been initialized. Symbol index will rebuild on next file watch cycle.\n`
      );
    } catch (renameErr) {
      // Rename failed (permissions, cross-device). Exit with a clear message rather than
      // silently overwriting or looping — the user must resolve the file manually.
      const message = renameErr instanceof Error ? renameErr.message : String(renameErr);
      process.stderr.write(
        `[Continuum] FATAL: knowledge.db is corrupted and could not be quarantined.\n` +
        `  Reason: ${message}\n` +
        `  Manually delete or move ${dbPath} and restart.\n`
      );
      process.exit(1);
    }
  }

  try {
    const instance = new BetterSqlite3(dbPath);
    applyPragmasAndSchema(instance);
    seedMetadata(instance);
    return instance;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[Continuum] FATAL: Could not open database at ${dbPath}\n` +
      `  Reason: ${message}\n` +
      `  Check file permissions or delete the file to start fresh.\n`
    );
    process.exit(1);
  }
}

export function getDb(): BetterSqlite3.Database {
  if (!db) {
    db = openDb(resolveActiveDbPath());
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
      db = null;
    } catch {
      // already closed
    }
  }
}
