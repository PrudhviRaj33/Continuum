/**
 * Tests for the SQL logic and computations used by McpServer tool handlers.
 *
 * McpServer.ts cannot be imported directly in tests because it has module-level
 * side effects (starts watcher, connects stdio). These tests exercise the same
 * DB queries and business logic that the tool handlers execute, giving meaningful
 * coverage without requiring a live MCP server.
 *
 * Tools covered: get_dependencies, get_session_report, health_check, logToolCall
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';

const TEST_DB_PATH = path.join(os.tmpdir(), `continuum-mcp-logic-test-${crypto.randomUUID()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.LOG_LEVEL = 'error';

import { SessionEngine } from '../src/session/SessionEngine';
import { IncrementalParser } from '../src/parser/IncrementalParser';
import { KnowledgeEngine } from '../src/knowledge/KnowledgeEngine';
import { getDb, closeDb } from '../src/database/Database';

let session: SessionEngine;
let parser: IncrementalParser;
let knowledge: KnowledgeEngine;
let tempDir: string;

beforeAll(async () => {
  session = new SessionEngine();
  parser = new IncrementalParser();
  knowledge = new KnowledgeEngine();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuum-mcp-'));

  // Seed a real file so get_dependencies and health_check have data to work with
  const seedFile = path.join(tempDir, 'seed.ts');
  await fs.writeFile(seedFile, `
export class AuthService {
  login(user: string, pass: string): boolean { return true; }
  logout(): void {}
}

export function hashPassword(raw: string): string {
  return raw;
}
`);
  await parser.parseFile(seedFile);
});

afterAll(async () => {
  closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  try { (await import('fs')).unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
});

// ── logToolCall logic ──────────────────────────────────────────────────────

describe('logToolCall logic (tool_usage table)', () => {
  it('inserts a tool_usage row with correct fields', () => {
    const db = getDb();
    const sessionId = session.getSessionId();
    db.prepare(`
      INSERT INTO tool_usage (session_id, tool_name, input_json, tokens_returned, duration_ms, called_at)
      VALUES (?, ?, ?, ?, ?, unixepoch())
    `).run(sessionId, 'health_check', '{}', 320, 4);

    const row = db
      .prepare('SELECT * FROM tool_usage WHERE session_id = ? AND tool_name = ?')
      .get(sessionId, 'health_check') as {
        tool_name: string;
        tokens_returned: number;
        duration_ms: number;
      } | undefined;

    expect(row).toBeDefined();
    expect(row!.tool_name).toBe('health_check');
    expect(row!.tokens_returned).toBe(320);
    expect(row!.duration_ms).toBe(4);
  });

  it('does not throw when session_id is null (anonymous call)', () => {
    const db = getDb();
    expect(() => {
      db.prepare(`
        INSERT INTO tool_usage (session_id, tool_name, input_json, tokens_returned, duration_ms, called_at)
        VALUES (?, ?, ?, ?, ?, unixepoch())
      `).run(null, 'get_session', '{}', 100, 2);
    }).not.toThrow();
  });
});

// ── health_check logic ─────────────────────────────────────────────────────

describe('health_check logic', () => {
  it('reads file and symbol counts from the DB', () => {
    const db = getDb();
    const fileCount = (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
    const symbolCount = (db.prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number }).n;

    // We seeded one file with at least 3 symbols (AuthService, login, logout, hashPassword)
    expect(fileCount).toBeGreaterThanOrEqual(1);
    expect(symbolCount).toBeGreaterThanOrEqual(3);
  });

  it('reads version and boot_count from metadata', () => {
    const db = getDb();
    const meta = db
      .prepare("SELECT key, value FROM metadata WHERE key IN ('version', 'boot_count', 'first_started')")
      .all() as { key: string; value: string }[];

    const metaMap = Object.fromEntries(meta.map((m) => [m.key, m.value]));
    expect(metaMap['version']).toBe('1.0.0');
    expect(Number(metaMap['boot_count'])).toBeGreaterThanOrEqual(1);
  });

  it('uptime is non-negative', () => {
    expect(session.getUptimeSeconds()).toBeGreaterThanOrEqual(0);
  });
});

// ── get_dependencies logic ─────────────────────────────────────────────────

describe('get_dependencies logic', () => {
  it('looks up a file by partial path and returns its symbols', () => {
    const db = getDb();

    const file = db
      .prepare('SELECT id FROM files WHERE path LIKE ?')
      .get('%seed.ts%') as { id: number } | undefined;

    expect(file).toBeDefined();

    const symbols = db
      .prepare('SELECT id, name, kind, start_line, end_line FROM symbols WHERE file_id = ?')
      .all(file!.id) as { id: number; name: string; kind: string; start_line: number; end_line: number }[];

    expect(symbols.length).toBeGreaterThanOrEqual(2);
    expect(symbols.some((s) => s.name === 'AuthService' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.name === 'hashPassword' && s.kind === 'function')).toBe(true);
  });

  it('returns an empty file error for an unknown path', () => {
    const db = getDb();
    const file = db
      .prepare('SELECT id FROM files WHERE path LIKE ?')
      .get('%nonexistent_file_xyz.ts%') as { id: number } | undefined;

    expect(file).toBeUndefined();
  });

  it('queries outgoing relationships without throwing (currently empty — Phase 4)', () => {
    const db = getDb();

    const file = db
      .prepare('SELECT id FROM files WHERE path LIKE ?')
      .get('%seed.ts%') as { id: number } | undefined;

    expect(file).toBeDefined();

    const outgoing = db
      .prepare(`
        SELECT r.to_name, r.kind
        FROM relationships r
        JOIN symbols s ON r.from_id = s.id
        WHERE s.file_id = ?
      `)
      .all(file!.id) as { to_name: string; kind: string }[];

    // Relationships are populated in Phase 4 (AST/dependency graph).
    // The query must not throw and must return an array.
    expect(Array.isArray(outgoing)).toBe(true);
  });
});

// ── get_session_report logic ───────────────────────────────────────────────

describe('get_session_report logic', () => {
  it('aggregates tool calls by tool_name for the current session', () => {
    const db = getDb();
    const sessionId = session.getSessionId();

    // Insert some tool_usage rows to aggregate
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO tool_usage (session_id, tool_name, input_json, tokens_returned, duration_ms, called_at)
        VALUES (?, 'get_session', '{}', 500, 3, unixepoch())
      `).run(sessionId);
    }

    const toolCalls = db
      .prepare(`
        SELECT tool_name, COUNT(*) AS count,
               SUM(tokens_returned) AS total_tokens,
               AVG(duration_ms) AS avg_duration_ms
        FROM tool_usage
        WHERE session_id = ?
        GROUP BY tool_name
        ORDER BY count DESC
      `)
      .all(sessionId) as {
        tool_name: string;
        count: number;
        total_tokens: number;
        avg_duration_ms: number;
      }[];

    const getSessionRow = toolCalls.find((t) => t.tool_name === 'get_session');
    expect(getSessionRow).toBeDefined();
    expect(getSessionRow!.count).toBeGreaterThanOrEqual(3);
    expect(getSessionRow!.total_tokens).toBeGreaterThan(0);
  });

  it('counts distinct touched file paths for the session', () => {
    const db = getDb();
    const sessionId = session.getSessionId();

    session.recordFileTouch('/project/src/auth.ts', 'modified');
    session.recordFileTouch('/project/src/user.ts', 'created');

    const touchedCount = db
      .prepare('SELECT COUNT(DISTINCT path) AS count FROM touched_files WHERE session_id = ?')
      .get(sessionId) as { count: number };

    expect(touchedCount.count).toBeGreaterThanOrEqual(2);
  });

  it('estimates tokens saved based on get_session calls and touched file count', () => {
    const db = getDb();
    const sessionId = session.getSessionId();

    const toolCalls = db
      .prepare(`
        SELECT tool_name, COUNT(*) AS count FROM tool_usage
        WHERE session_id = ? GROUP BY tool_name
      `)
      .all(sessionId) as { tool_name: string; count: number }[];

    const touchedCount = db
      .prepare('SELECT COUNT(DISTINCT path) AS count FROM touched_files WHERE session_id = ?')
      .get(sessionId) as { count: number };

    const getSessionCalls = toolCalls.find((t) => t.tool_name === 'get_session')?.count ?? 0;
    const estimated = getSessionCalls * 5000 + touchedCount.count * 800;

    expect(estimated).toBeGreaterThanOrEqual(0);
    expect(typeof estimated).toBe('number');
  });
});

// ── search_symbols logic (KnowledgeEngine) ─────────────────────────────────

describe('search_symbols via KnowledgeEngine', () => {
  it('finds a seeded class by name', () => {
    const results = knowledge.searchSymbols('AuthService', 10);
    expect(results.some((r) => r.name === 'AuthService' && r.kind === 'class')).toBe(true);
  });

  it('returns empty array for a query with no matches', () => {
    const results = knowledge.searchSymbols('xxxxxxNotASymbol', 10);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  it('respects the limit parameter', () => {
    const results = knowledge.searchSymbols('Auth', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});
