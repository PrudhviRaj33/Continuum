import BetterSqlite3 from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = process.env.DB_PATH || './knowledge.db';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db: BetterSqlite3.Database | null = null;

function applyPragmasAndSchema(instance: BetterSqlite3.Database): void {
  instance.pragma('journal_mode = WAL');
  instance.pragma('busy_timeout = 5000');
  instance.pragma('foreign_keys = ON');
  instance.pragma('cache_size = -16000');
  instance.pragma('temp_store = MEMORY');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  instance.exec(schema);
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
    db = openDb(DB_PATH);
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
