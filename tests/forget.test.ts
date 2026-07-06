import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const TEST_DB_PATH = path.join(os.tmpdir(), `continuum-forget-test-${crypto.randomUUID()}.db`);
process.env.DB_PATH  = TEST_DB_PATH;
process.env.LOG_LEVEL = 'error';

import { IncrementalParser } from '../src/parser/IncrementalParser';
import { getDb, closeDb } from '../src/database/Database';

const parser = new IncrementalParser();
let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuum-forget-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  fs.unlink(TEST_DB_PATH).catch(() => {});
});

// ── forgetFile ──────────────────────────────────────────────────────────────

describe('forgetFile()', () => {
  it('removes file from files, symbols, and symbols_fts', async () => {
    const fp = path.join(tempDir, 'secret.ts');
    await fs.writeFile(fp, 'export function getKey() {}\n', 'utf-8');
    await parser.parseFile(fp);

    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(fp) as {n:number}).n).toBe(1);

    const result = parser.forgetFile(fp, 'secret file', 'sess-1');

    expect(result.files).toBe(1);
    expect(result.symbols).toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(fp) as {n:number}).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM symbols_fts WHERE file_path = ?').get(fp) as {n:number}).n).toBe(0);
  });

  it('writes a forget_log entry with correct fields', async () => {
    const fp = path.join(tempDir, 'logged.ts');
    await fs.writeFile(fp, 'export function logMe() {}\n', 'utf-8');
    await parser.parseFile(fp);
    parser.forgetFile(fp, 'test reason', 'sess-abc');

    const db = getDb();
    const row = db.prepare("SELECT * FROM forget_log WHERE target_value = ? AND target_type = 'file'")
      .get(fp) as {reason:string;session_id:string;symbols_removed:number;files_removed:number};

    expect(row).toBeDefined();
    expect(row.reason).toBe('test reason');
    expect(row.session_id).toBe('sess-abc');
    expect(row.files_removed).toBe(1);
    expect(row.symbols_removed).toBeGreaterThanOrEqual(1);
  });

  it('returns files:0 when file was not indexed but still logs', () => {
    const result = parser.forgetFile('/nonexistent/file.ts', 'cleanup');
    expect(result.files).toBe(0);
    expect(result.symbols).toBe(0);

    const db = getDb();
    const row = db.prepare("SELECT files_removed FROM forget_log WHERE target_value = '/nonexistent/file.ts'").get() as {files_removed:number}|undefined;
    expect(row).toBeDefined();
    expect(row?.files_removed).toBe(0);
  });

  it('re-indexing a forgotten file re-adds it', async () => {
    const fp = path.join(tempDir, 'comes-back.ts');
    await fs.writeFile(fp, 'export function comesBack() {}\n', 'utf-8');
    await parser.parseFile(fp);
    parser.forgetFile(fp, 'test');

    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(fp) as {n:number}).n).toBe(0);

    await parser.parseFile(fp);
    expect((db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(fp) as {n:number}).n).toBe(1);
  });
});

// ── forgetPattern ───────────────────────────────────────────────────────────

describe('forgetPattern()', () => {
  it('removes all files matching a glob, leaves non-matching files', async () => {
    for (const name of ['a.generated.ts', 'b.generated.ts', 'keep.ts']) {
      const fp = path.join(tempDir, name);
      await fs.writeFile(fp, `export function fn_${name.replace(/\W/g,'_')}() {}\n`, 'utf-8');
      await parser.parseFile(fp);
    }

    const result = parser.forgetPattern('**/*.generated.ts', 'generated files');

    expect(result.files).toBe(2);
    expect(result.matched).toHaveLength(2);
    expect(result.matched.every(p => p.endsWith('.generated.ts'))).toBe(true);

    const db = getDb();
    const keepPath = path.join(tempDir, 'keep.ts');
    expect((db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(keepPath) as {n:number}).n).toBe(1);
  });

  it('writes a pattern-level entry to forget_log', async () => {
    const fp = path.join(tempDir, 'x.gen.ts');
    await fs.writeFile(fp, 'export function g() {}\n', 'utf-8');
    await parser.parseFile(fp);
    parser.forgetPattern('**/*.gen.ts', 'auto-cleanup', 'sess-pat');

    const db = getDb();
    const row = db.prepare("SELECT * FROM forget_log WHERE target_type='pattern' AND target_value='**/*.gen.ts'")
      .get() as {session_id:string;files_removed:number}|undefined;
    expect(row).toBeDefined();
    expect(row?.session_id).toBe('sess-pat');
    expect(row?.files_removed).toBeGreaterThanOrEqual(1);
  });
});

// ── forget_log ordering ─────────────────────────────────────────────────────

describe('forget_log ordering', () => {
  it('newest entries come first', async () => {
    for (const label of ['alpha', 'beta', 'gamma']) {
      const fp = path.join(tempDir, `${label}.ts`);
      await fs.writeFile(fp, `export function fn() {}\n`, 'utf-8');
      await parser.parseFile(fp);
      parser.forgetFile(fp, label);
    }

    const db = getDb();
    const rows = db.prepare(
      "SELECT reason FROM forget_log WHERE reason IN ('alpha','beta','gamma') ORDER BY forgotten_at DESC, id DESC"
    ).all() as {reason:string}[];

    expect(rows[0].reason).toBe('gamma');
    expect(rows[rows.length - 1].reason).toBe('alpha');
  });
});
