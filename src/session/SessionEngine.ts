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
    logger.info({ sessionId: id }, 'Session started');
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
        WHERE session_id = ?
        GROUP BY path
        ORDER BY touched_at DESC
        LIMIT 100
      `)
      .all(this.sessionId) as TouchedFile[];

    const latestTask = db
      .prepare(`
        SELECT * FROM tasks
        WHERE session_id = ?
        ORDER BY saved_at DESC
        LIMIT 1
      `)
      .get(this.sessionId) as
      | {
          goal: string;
          decisions: string;
          next_steps: string;
          open_questions: string;
        }
      | undefined;

    return {
      session_id: session.id,
      goal: session.goal,
      started_at: session.started_at,
      compaction_count: session.compaction_count,
      touched_files: touched,
      latest_task: latestTask
        ? {
            goal: latestTask.goal,
            decisions: JSON.parse(latestTask.decisions || '[]') as string[],
            next_steps: JSON.parse(latestTask.next_steps || '[]') as string[],
            open_questions: JSON.parse(latestTask.open_questions || '[]') as string[],
          }
        : null,
    };
  }

  /** Distinct files touched this session — useful for impact analysis. */
  getTouchedFiles(): TouchedFile[] {
    const db = getDb();
    return db
      .prepare(`
        SELECT path, action, MAX(touched_at) as touched_at
        FROM touched_files
        WHERE session_id = ?
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
