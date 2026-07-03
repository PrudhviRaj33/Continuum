import BetterSqlite3 from 'better-sqlite3';
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

export interface RecentSessionSummary {
  session_id: string;
  goal: string | null;
  started_at: number;
  updated_at: number;
  compaction_count: number;
  files_touched: number;
  last_task_goal: string | null;
  summary: string | null;
  key_decisions: string[];
  resume_steps: string[];
}

export interface SessionState {
  session_id: string;
  goal: string | null;
  started_at: number;
  compaction_count: number;
  resumed: boolean;
  touched_files: TouchedFile[];
  latest_task: TaskState | null;
  recent_tasks: TaskState[];
  recent_errors: { tool_name: string; error_msg: string; occurred_at: number }[];
}

export class SessionEngine {
  private readonly sessionId: string;
  private readonly startTime: number;

  private readonly resumed: boolean;

  constructor() {
    this.startTime = Math.floor(Date.now() / 1000);
    const { id, resumed } = this.initSession();
    this.sessionId = id;
    this.resumed = resumed;
  }

  private initSession(): { id: string; resumed: boolean } {
    const db = getDb();

    // Session resume: if the most recent session was active within SESSION_RESUME_HOURS,
    // reuse it so context survives server restarts (e.g. npx tsx hot-reload, IDE restart).
    // Set SESSION_RESUME_HOURS=0 to always start a fresh session.
    const resumeHours = parseInt(process.env.SESSION_RESUME_HOURS || '4', 10);
    if (resumeHours > 0) {
      const cutoff = Math.floor(Date.now() / 1000) - resumeHours * 3600;
      const recent = db.prepare(
        'SELECT id FROM sessions WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 1'
      ).get(cutoff) as { id: string } | undefined;

      if (recent) {
        logger.info({ sessionId: recent.id, resumeHours }, 'Resumed recent session');
        return { id: recent.id, resumed: true };
      }
    }

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
    return { id, resumed: false };
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

    this.pruneOldTasks(db);

    logger.info({ sessionId: this.sessionId, taskId: result.lastInsertRowid }, 'Task saved');
    return Number(result.lastInsertRowid);
  }

  /**
   * When tasks exceed MAX_TASKS_PER_SESSION, collapse the oldest ones into a single
   * consolidated entry so the session table doesn't grow without bound.
   * Deterministic — no LLM needed.
   */
  private pruneOldTasks(db: BetterSqlite3.Database): void {
    const MAX_TASKS = parseInt(process.env.MAX_TASKS_PER_SESSION || '15', 10);

    const count = (db.prepare(
      'SELECT COUNT(*) AS n FROM tasks WHERE session_id = ?'
    ).get(this.sessionId) as { n: number }).n;

    if (count <= MAX_TASKS) return;

    const toRemove = count - MAX_TASKS + 1; // collapse oldest N+1 into 1

    type RawTask = { goal: string; decisions: string; next_steps: string; open_questions: string };
    const oldest = db.prepare(`
      SELECT goal, decisions, next_steps, open_questions FROM tasks
      WHERE session_id = ? ORDER BY saved_at ASC LIMIT ?
    `).all(this.sessionId, toRemove) as RawTask[];

    const mergedDecisions = [
      ...new Set(oldest.flatMap(t => {
        try { return JSON.parse(t.decisions || '[]') as string[]; } catch { return []; }
      })),
    ];

    const last = oldest[oldest.length - 1];

    db.transaction(() => {
      db.prepare(`
        DELETE FROM tasks WHERE id IN (
          SELECT id FROM tasks WHERE session_id = ? ORDER BY saved_at ASC LIMIT ?
        )
      `).run(this.sessionId, toRemove);

      db.prepare(`
        INSERT INTO tasks (session_id, goal, decisions, next_steps, open_questions, saved_at)
        VALUES (?, ?, ?, ?, ?, unixepoch())
      `).run(
        this.sessionId,
        `[Consolidated] ${last.goal}`,
        JSON.stringify(mergedDecisions),
        last.next_steps,
        last.open_questions
      );
    })();

    logger.info({ sessionId: this.sessionId, collapsed: toRemove }, 'Old tasks pruned and consolidated');
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

    const recentErrors = db.prepare(`
      SELECT tool_name, error_msg, occurred_at FROM tool_errors
      WHERE session_id = ? ORDER BY occurred_at DESC LIMIT 5
    `).all(this.sessionId) as { tool_name: string; error_msg: string; occurred_at: number }[];

    return {
      session_id: session.id,
      goal: session.goal,
      started_at: session.started_at,
      compaction_count: session.compaction_count,
      resumed: this.resumed,
      touched_files: touched,
      latest_task: recentTasks[0] ?? null,
      recent_tasks: recentTasks,
      recent_errors: recentErrors,
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

  /** Last N completed sessions (excluding current) with summary info. */
  getRecentSessions(limit = 5): RecentSessionSummary[] {
    const db = getDb();
    type RawRow = {
      session_id: string; goal: string | null; started_at: number; updated_at: number;
      compaction_count: number; files_touched: number; last_task_goal: string | null;
      summary_goal: string | null; key_decisions: string | null; resume_steps: string | null;
    };
    const rows = db.prepare(`
      SELECT
        s.id                 AS session_id,
        s.goal,
        s.started_at,
        s.updated_at,
        s.compaction_count,
        COUNT(tf.id)         AS files_touched,
        (SELECT t.goal FROM tasks t WHERE t.session_id = s.id ORDER BY t.saved_at DESC LIMIT 1) AS last_task_goal,
        ss.goal              AS summary_goal,
        ss.key_decisions,
        ss.resume_steps
      FROM sessions s
      LEFT JOIN touched_files tf ON tf.session_id = s.id
      LEFT JOIN session_summaries ss ON ss.session_id = s.id
      WHERE s.id != ?
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT ?
    `).all(this.sessionId, limit) as RawRow[];

    return rows.map(r => ({
      session_id:       r.session_id,
      goal:             r.goal,
      started_at:       r.started_at,
      updated_at:       r.updated_at,
      compaction_count: r.compaction_count,
      files_touched:    r.files_touched,
      last_task_goal:   r.last_task_goal,
      summary:          r.summary_goal,
      key_decisions:    JSON.parse(r.key_decisions || '[]') as string[],
      resume_steps:     JSON.parse(r.resume_steps  || '[]') as string[],
    }));
  }

  /**
   * Consolidate this session on shutdown — collapse all tasks into a summary row.
   * Called by the Stop hook and SIGTERM handler. Deterministic, no LLM needed.
   */
  consolidateSession(): void {
    const db = getDb();
    type RawTask = { goal: string; decisions: string; next_steps: string };

    const tasks = db.prepare(`
      SELECT goal, decisions, next_steps FROM tasks
      WHERE session_id = ? ORDER BY saved_at ASC
    `).all(this.sessionId) as RawTask[];

    if (tasks.length === 0) return;

    const allDecisions = [
      ...new Set(
        tasks.flatMap(t => {
          try { return JSON.parse(t.decisions || '[]') as string[]; } catch { return []; }
        })
      ),
    ].slice(0, 10);

    const lastTask = tasks[tasks.length - 1];
    let resumeSteps: string[] = [];
    try { resumeSteps = (JSON.parse(lastTask.next_steps || '[]') as string[]).slice(0, 3); } catch { /* ignore */ }

    const filesCount = (db.prepare(
      'SELECT COUNT(DISTINCT path) AS n FROM touched_files WHERE session_id = ?'
    ).get(this.sessionId) as { n: number }).n;

    db.prepare(`
      INSERT OR REPLACE INTO session_summaries
        (session_id, goal, key_decisions, resume_steps, files_count, task_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      this.sessionId,
      lastTask.goal,
      JSON.stringify(allDecisions),
      JSON.stringify(resumeSteps),
      filesCount,
      tasks.length
    );

    logger.info({ sessionId: this.sessionId, tasks: tasks.length, files: filesCount }, 'Session consolidated');
  }

  /** Search tasks by goal or decision text — used by smart_search. */
  searchTasks(query: string): { goal: string; decisions: string[]; saved_at: number }[] {
    const db = getDb();
    type RawRow = { goal: string; decisions: string; saved_at: number };
    const like = `%${query}%`;
    const rows = db.prepare(`
      SELECT goal, decisions, saved_at FROM tasks
      WHERE session_id = ? AND (goal LIKE ? OR decisions LIKE ?)
      ORDER BY saved_at DESC LIMIT 5
    `).all(this.sessionId, like, like) as RawRow[];
    return rows.map(r => ({
      goal: r.goal,
      decisions: JSON.parse(r.decisions || '[]') as string[],
      saved_at: r.saved_at,
    }));
  }

  /** Search touched files by path fragment — used by smart_search. */
  searchTouchedFiles(query: string): TouchedFile[] {
    const db = getDb();
    return db.prepare(`
      SELECT path, action, MAX(touched_at) AS touched_at
      FROM touched_files
      WHERE session_id = ? AND path LIKE ?
      GROUP BY path ORDER BY touched_at DESC LIMIT 10
    `).all(this.sessionId, `%${query}%`) as TouchedFile[];
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
