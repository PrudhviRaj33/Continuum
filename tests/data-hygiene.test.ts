import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// Isolate DB for tests — DB_PATH is read lazily inside getDb(), so setting it
// here (before first getDb() call) is sufficient even under ESM import hoisting.
const TEST_DB_PATH = path.join(os.tmpdir(), `continuum-hygiene-test-${crypto.randomUUID()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.LOG_LEVEL = 'error';

import { IncrementalParser } from '../src/parser/IncrementalParser';
import { getDb, closeDb } from '../src/database/Database';

const parser = new IncrementalParser();
let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuum-hygiene-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  fs.unlink(TEST_DB_PATH).catch(() => { /* ignore */ });
});

describe('Data hygiene — no stale symbols/FTS survive a delete', () => {
  it('removeFile() cleans files, symbols, AND symbols_fts (no orphans)', async () => {
    const filePath = path.join(tempDir, 'temp.ts');
    await fs.writeFile(filePath, 'export function willBeDeleted() {}\n', 'utf-8');
    await parser.parseFile(filePath);

    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(filePath) as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM symbols_fts WHERE file_path = ?').get(filePath) as { n: number }).n).toBe(1);

    parser.removeFile(filePath);

    expect((db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(filePath) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM symbols WHERE file_id IN (SELECT id FROM files WHERE path = ?)').get(filePath) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM symbols_fts WHERE file_path = ?').get(filePath) as { n: number }).n).toBe(0);
  });

  it('sweepOrphans() purges files deleted while the watcher was offline', async () => {
    const filePath = path.join(tempDir, 'ghost.ts');
    await fs.writeFile(filePath, 'export function ghost() {}\n', 'utf-8');
    await parser.parseFile(filePath);

    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(filePath) as { n: number }).n).toBe(1);

    // Simulate the file vanishing without an 'unlink' event ever firing
    await fs.rm(filePath);

    const removed = await parser.sweepOrphans();
    expect(removed).toBeGreaterThanOrEqual(1);

    expect((db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(filePath) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM symbols_fts WHERE file_path = ?').get(filePath) as { n: number }).n).toBe(0);
  });

  it('parseFile() treats ENOENT (file vanished mid-parse) as a delete, not a silent skip', async () => {
    const filePath = path.join(tempDir, 'vanishing.ts');
    await fs.writeFile(filePath, 'export function vanishing() {}\n', 'utf-8');
    await parser.parseFile(filePath);

    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(filePath) as { n: number }).n).toBe(1);

    await fs.rm(filePath);
    await parser.parseFile(filePath); // should not throw, should clean up

    expect((db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(filePath) as { n: number }).n).toBe(0);
  });
});

describe('Data hygiene — FTS5 ranked search actually returns results', () => {
  it('symbols_fts is self-contained (not content=\'\') so the ranked-search JOIN can match', async () => {
    const filePath = path.join(tempDir, 'searchable.ts');
    await fs.writeFile(filePath, 'export function findUniqueSymbolXyz() {}\n', 'utf-8');
    await parser.parseFile(filePath);

    const db = getDb();

    // Same JOIN shape used in KnowledgeEngine.searchSymbols() — this must return
    // a row. On a contentless (content='') FTS5 table it always returns zero,
    // which was the actual production bug: FTS ranking silently never matched.
    const rows = db.prepare(`
      SELECT s.name, s.kind, f.path AS file_path
      FROM symbols_fts
      JOIN symbols s ON s.name = symbols_fts.name AND s.kind = symbols_fts.kind
      JOIN files f ON f.path = symbols_fts.file_path
      WHERE symbols_fts MATCH ?
    `).all('findUniqueSymbolXyz') as { name: string }[];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].name).toBe('findUniqueSymbolXyz');
  });
});
