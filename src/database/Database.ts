import BetterSqlite3 from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = process.env.DB_PATH || './knowledge.db';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db: BetterSqlite3.Database | null = null;

export function getDb(): BetterSqlite3.Database {
  if (!db) {
    db = new BetterSqlite3(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.pragma('cache_size = -16000'); // 16 MB page cache
    db.pragma('temp_store = MEMORY');

    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    db.exec(schema);

    // Seed metadata on first boot
    const versionCheck = db
      .prepare("SELECT value FROM metadata WHERE key = 'version'")
      .get() as { value: string } | undefined;

    if (!versionCheck) {
      const now = Math.floor(Date.now() / 1000);
      db.prepare("INSERT OR IGNORE INTO metadata VALUES ('version', '1.0.0')").run();
      db.prepare(`INSERT OR IGNORE INTO metadata VALUES ('first_started', '${now}')`).run();
    }

    db.prepare(
      `INSERT OR REPLACE INTO metadata VALUES ('last_started', '${Math.floor(Date.now() / 1000)}')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO metadata VALUES ('boot_count',
        CAST((COALESCE((SELECT value FROM metadata WHERE key='boot_count'), 0)) AS INTEGER) + 1
      )`
    ).run();
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
