import { getDb } from '../database/Database';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

export interface TaskState {
  goal: string;
  decisions: string[];
  next_steps: string[];
  open_questions: string[];
}

export interface TouchedFile {
  path: string;
  action: string;
  touched_at: number;
}

export interface SessionState {
  session_id: string;
  goal: string | null;
  started_at: number;
  compaction_count: number;
  touched_files: TouchedFile[];
  latest_task: TaskState | null;
  recent_tasks: TaskState[];
}

export class SessionEngine {
  private readonly sessionId: string;
  private readonly startTime: number;

  constructor() {
    this.startTime = Math.floor(Date.now() / 1000);
    this.sessionId = this.initSession();
  }

  private initSession(): string {
    const db = getDb();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO sessions (id, started_at, updated_at)
      VALUES (?, unixepoch(), unixepoch())
    `).run(id);

    // Garbage Collection: Physically delete touched files older than 24 hours
    // to prevent infinite database bloat over months of usage.
    const pruneResult = db.prepare(`
      DELETE FROM touched_files WHERE touched_at <= unixepoch() - 86400
    `).run();

    logger.info({ sessionId: id, prunedStaleFiles: pruneResult.changes }, 'Session started and stale memory pruned');
    return id;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getUptimeSeconds(): number {
    return Math.floor(Date.now() / 1000) - this.startTime;
  }

  /**
   * Record a file being touched. Action 'opened' is separate from watcher events.
   * Skips duplicate entries within 5 seconds (debounce for rapid saves).
   */
  recordFileTouch(
    filePath: string,
    action: 'opened' | 'modified' | 'created' | 'deleted'
  ): void {
    const db = getDb();

    // Debounce: skip if same file+action recorded in last 5 seconds
    const recent = db
      .prepare(`
        SELECT id FROM touched_files
        WHERE session_id = ? AND path = ? AND action = ?
          AND touched_at > unixepoch() - 5
      `)
      .get(this.sessionId, filePath, action);

    if (recent) return;

    db.prepare(`
      INSERT INTO touched_files (session_id, path, action, touched_at)
      VALUES (?, ?, ?, unixepoch())
    `).run(this.sessionId, filePath, action);

    db.prepare(`
      UPDATE sessions SET updated_at = unixepoch() WHERE id = ?
    `).run(this.sessionId);
  }

  /** Save structured task state. Returns the task ID. */
  saveTask(task: TaskState): number {
    const db = getDb();
    const result = db
      .prepare(`
        INSERT INTO tasks (session_id, goal, decisions, next_steps, open_questions, saved_at)
        VALUES (?, ?, ?, ?, ?, unixepoch())
      `)
      .run(
        this.sessionId,
        task.goal,
        JSON.stringify(task.decisions),
        JSON.stringify(task.next_steps),
        JSON.stringify(task.open_questions)
      );

    db.prepare(`UPDATE sessions SET goal = ?, updated_at = unixepoch() WHERE id = ?`).run(
      task.goal,
      this.sessionId
    );

    logger.info({ sessionId: this.sessionId, taskId: result.lastInsertRowid }, 'Task saved');
    return Number(result.lastInsertRowid);
  }

  /** Full session state — the primary recovery payload after compaction. */
  getSession(): SessionState {
    const db = getDb();

    const session = db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(this.sessionId) as {
        id: string;
        goal: string | null;
        started_at: number;
        compaction_count: number;
      };

    const touched = db
      .prepare(`
        SELECT path, action, MAX(touched_at) as touched_at
        FROM touched_files
        WHERE session_id = ? AND touched_at > unixepoch() - 86400
        GROUP BY path
        ORDER BY touched_at DESC
        LIMIT 100
      `)
      .all(this.sessionId) as TouchedFile[];

    type RawTask = { goal: string; decisions: string; next_steps: string; open_questions: string; saved_at: number };
    const parseTask = (t: RawTask): TaskState => ({
      goal: t.goal,
      decisions: JSON.parse(t.decisions || '[]') as string[],
      next_steps: JSON.parse(t.next_steps || '[]') as string[],
      open_questions: JSON.parse(t.open_questions || '[]') as string[],
    });

    const recentTasks = (db
      .prepare(`
        SELECT goal, decisions, next_steps, open_questions, saved_at
        FROM tasks
        WHERE session_id = ?
        ORDER BY saved_at DESC
        LIMIT 5
      `)
      .all(this.sessionId) as RawTask[]).map(parseTask);

    return {
      session_id: session.id,
      goal: session.goal,
      started_at: session.started_at,
      compaction_count: session.compaction_count,
      touched_files: touched,
      latest_task: recentTasks[0] ?? null,
      recent_tasks: recentTasks,
    };
  }

  /** Distinct files touched this session — useful for impact analysis. */
  getTouchedFiles(): TouchedFile[] {
    const db = getDb();
    return db
      .prepare(`
        SELECT path, action, MAX(touched_at) as touched_at
        FROM touched_files
        WHERE session_id = ? AND touched_at > unixepoch() - 86400
        GROUP BY path
        ORDER BY touched_at DESC
      `)
      .all(this.sessionId) as TouchedFile[];
  }

  recordCompaction(): void {
    const db = getDb();
    db.prepare(`
      UPDATE sessions
      SET compaction_count = compaction_count + 1, updated_at = unixepoch()
      WHERE id = ?
    `).run(this.sessionId);
    logger.info({ sessionId: this.sessionId }, 'Context compaction recorded');
  }
}
