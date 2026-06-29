import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const TEST_DB_PATH = path.join(os.tmpdir(), `continuum-session-test-${crypto.randomUUID()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.LOG_LEVEL = 'error';

import { SessionEngine } from '../src/session/SessionEngine';
import { getDb, closeDb } from '../src/database/Database';

let session: SessionEngine;

beforeAll(() => {
  session = new SessionEngine();
});

afterAll(() => {
  closeDb();
  try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
});

describe('SessionEngine', () => {
  it('creates a session with a valid UUID', () => {
    const id = session.getSessionId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('session exists in the database', () => {
    const db = getDb();
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.getSessionId());
    expect(row).toBeDefined();
  });

  it('records a file touch', () => {
    session.recordFileTouch('/fake/path/app.ts', 'modified');
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM touched_files WHERE session_id = ? AND path = ?')
      .get(session.getSessionId(), '/fake/path/app.ts');
    expect(row).toBeDefined();
  });

  it('deduplicates rapid file touches within 5s', () => {
    const testPath = '/fake/path/dedup.ts';
    session.recordFileTouch(testPath, 'modified');
    session.recordFileTouch(testPath, 'modified');
    session.recordFileTouch(testPath, 'modified');

    const db = getDb();
    const count = (
      db
        .prepare('SELECT COUNT(*) AS c FROM touched_files WHERE session_id = ? AND path = ? AND action = ?')
        .get(session.getSessionId(), testPath, 'modified') as { c: number }
    ).c;

    expect(count).toBe(1);
  });

  it('saves a task with all fields', () => {
    const taskId = session.saveTask({
      goal: 'Build user authentication',
      decisions: ['Use JWT tokens', 'Store refresh tokens in Redis'],
      next_steps: ['Implement /login endpoint', 'Add middleware'],
      open_questions: ['Token expiry: 15 min or 1 hour?'],
    });
    expect(taskId).toBeGreaterThan(0);
  });

  it('retrieves session with latest task', () => {
    const state = session.getSession();
    expect(state.session_id).toBe(session.getSessionId());
    expect(state.latest_task?.goal).toBe('Build user authentication');
    expect(state.latest_task?.decisions).toContain('Use JWT tokens');
    expect(state.latest_task?.next_steps.length).toBeGreaterThan(0);
  });

  it('getTouchedFiles returns distinct paths', () => {
    const files = session.getTouchedFiles();
    const paths = files.map((f) => f.path);
    const uniquePaths = [...new Set(paths)];
    expect(paths.length).toBe(uniquePaths.length);
  });

  it('recordCompaction increments the counter', () => {
    const db = getDb();
    const before = (
      db
        .prepare('SELECT compaction_count FROM sessions WHERE id = ?')
        .get(session.getSessionId()) as { compaction_count: number }
    ).compaction_count;

    session.recordCompaction();

    const after = (
      db
        .prepare('SELECT compaction_count FROM sessions WHERE id = ?')
        .get(session.getSessionId()) as { compaction_count: number }
    ).compaction_count;

    expect(after).toBe(before + 1);
  });

  it('getUptimeSeconds returns a non-negative number', () => {
    expect(session.getUptimeSeconds()).toBeGreaterThanOrEqual(0);
  });
});
