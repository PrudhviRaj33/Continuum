import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// We test IncrementalParser's symbol extraction logic directly
// by creating temp files and running the parser against a test DB

// Isolate DB for tests
const TEST_DB_PATH = path.join(os.tmpdir(), `continuum-test-${crypto.randomUUID()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.LOG_LEVEL = 'error'; // suppress logs during tests

import { IncrementalParser } from '../src/parser/IncrementalParser';
import { getDb, closeDb } from '../src/database/Database';

const parser = new IncrementalParser();
let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuum-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// Helper to write a temp file and parse it, returning symbols
async function parseContent(filename: string, content: string) {
  const filePath = path.join(tempDir, filename);
  await fs.writeFile(filePath, content, 'utf-8');
  await parser.parseFile(filePath);

  const db = getDb();
  const file = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number } | undefined;
  if (!file) return [];

  return db
    .prepare('SELECT name, kind FROM symbols WHERE file_id = ? ORDER BY start_line')
    .all(file.id) as { name: string; kind: string }[];
}

describe('IncrementalParser — TypeScript', () => {
  it('extracts a class', async () => {
    const symbols = await parseContent('test.ts', `
export class UserService {
  constructor() {}
}
`);
    expect(symbols.some((s) => s.name === 'UserService' && s.kind === 'class')).toBe(true);
  });

  it('extracts an interface', async () => {
    const symbols = await parseContent('iface.ts', `
export interface IRepository<T> {
  findById(id: string): Promise<T>;
}
`);
    expect(symbols.some((s) => s.name === 'IRepository' && s.kind === 'interface')).toBe(true);
  });

  it('extracts a function', async () => {
    const symbols = await parseContent('fn.ts', `
export async function fetchUser(id: string): Promise<User> {
  return db.find(id);
}
`);
    expect(symbols.some((s) => s.name === 'fetchUser' && s.kind === 'function')).toBe(true);
  });

  it('extracts an enum', async () => {
    const symbols = await parseContent('enum.ts', `
export enum Status {
  Active = 'ACTIVE',
  Inactive = 'INACTIVE',
}
`);
    expect(symbols.some((s) => s.name === 'Status' && s.kind === 'enum')).toBe(true);
  });
});

describe('IncrementalParser — Python', () => {
  it('extracts a class', async () => {
    const symbols = await parseContent('app.py', `
class UserService:
    def __init__(self):
        pass
`);
    expect(symbols.some((s) => s.name === 'UserService' && s.kind === 'class')).toBe(true);
  });

  it('extracts functions', async () => {
    const symbols = await parseContent('utils.py', `
def fetch_user(user_id):
    return db.find(user_id)

async def create_user(data):
    return db.create(data)
`);
    expect(symbols.some((s) => s.name === 'fetch_user' && s.kind === 'function')).toBe(true);
    expect(symbols.some((s) => s.name === 'create_user' && s.kind === 'function')).toBe(true);
  });
});

describe('IncrementalParser — Rust', () => {
  it('extracts structs, enums, and traits', async () => {
    const symbols = await parseContent('main.rs', `
pub struct User {
    pub id: u64,
}

pub enum Status {
    Active,
    Inactive,
}

pub trait Repository {
    fn find(&self, id: u64) -> Option<User>;
}

pub fn main() {
    println!("Hello");
}
`);
    expect(symbols.some((s) => s.name === 'User' && s.kind === 'struct')).toBe(true);
    expect(symbols.some((s) => s.name === 'Status' && s.kind === 'enum')).toBe(true);
    expect(symbols.some((s) => s.name === 'Repository' && s.kind === 'trait')).toBe(true);
    expect(symbols.some((s) => s.name === 'main' && s.kind === 'function')).toBe(true);
  });
});

describe('IncrementalParser — SQL', () => {
  it('extracts CREATE TABLE names', async () => {
    const symbols = await parseContent('schema.sql', `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE VIEW active_users AS
  SELECT * FROM users WHERE active = 1;
`);
    expect(symbols.some((s) => s.name === 'users' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.name === 'active_users' && s.kind === 'interface')).toBe(true);
  });
});

describe('IncrementalParser — deduplication', () => {
  it('skips unchanged files (hash dedup)', async () => {
    const filePath = path.join(tempDir, 'dedup.ts');
    const content = 'export class Foo {}';
    await fs.writeFile(filePath, content);

    await parser.parseFile(filePath);
    const db = getDb();
    const file1 = db.prepare('SELECT last_parsed FROM files WHERE path = ?').get(filePath) as { last_parsed: number };

    // Parse again — should skip
    await parser.parseFile(filePath);
    const file2 = db.prepare('SELECT last_parsed FROM files WHERE path = ?').get(filePath) as { last_parsed: number };

    expect(file1.last_parsed).toBe(file2.last_parsed);
  });

  it('re-parses when file content changes', async () => {
    const filePath = path.join(tempDir, 'change.ts');
    await fs.writeFile(filePath, 'export class Foo {}');
    await parser.parseFile(filePath);

    await fs.writeFile(filePath, 'export class Foo {}\nexport class Bar {}');
    await parser.parseFile(filePath);

    const db = getDb();
    const file = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number };
    const symbols = db.prepare('SELECT name FROM symbols WHERE file_id = ?').all(file.id) as { name: string }[];

    expect(symbols.some((s) => s.name === 'Bar')).toBe(true);
  });
});

// Cleanup DB after all tests
import { afterAll } from 'vitest';
afterAll(() => {
  closeDb();
  try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
});
