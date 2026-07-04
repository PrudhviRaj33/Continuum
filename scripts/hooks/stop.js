#!/usr/bin/env node
/**
 * Continuum Stop Hook
 *
 * Claude Code fires this hook when the session ends (user closes Claude Code,
 * or the conversation stops). Consolidates all tasks from this session into a
 * structured summary row so get_recent_sessions can show useful context.
 *
 * Deterministic — no LLM required.
 * Installation: add to your project's .claude/settings.json under hooks.Stop
 */

'use strict';

const path = require('path');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'knowledge.db');
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH);

    const session = db.prepare(
      'SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1'
    ).get();

    if (!session) { db.close(); return; }

    const tasks = db.prepare(`
      SELECT goal, decisions, next_steps FROM tasks
      WHERE session_id = ? ORDER BY saved_at ASC
    `).all(session.id);

    if (tasks.length === 0) { db.close(); return; }

    // Merge all decisions (deduplicated)
    const allDecisions = [
      ...new Set(
        tasks.flatMap(t => { try { return JSON.parse(t.decisions || '[]'); } catch { return []; } })
      ),
    ].slice(0, 10);

    const lastTask = tasks[tasks.length - 1];
    let resumeSteps = [];
    try { resumeSteps = JSON.parse(lastTask.next_steps || '[]').slice(0, 3); } catch {}

    const filesCount = db.prepare(
      'SELECT COUNT(DISTINCT path) AS n FROM touched_files WHERE session_id = ?'
    ).get(session.id).n;

    db.prepare(`
      INSERT OR REPLACE INTO session_summaries
        (session_id, goal, key_decisions, resume_steps, files_count, task_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      session.id,
      lastTask.goal,
      JSON.stringify(allDecisions),
      JSON.stringify(resumeSteps),
      filesCount,
      tasks.length
    );

    // Regenerate the local context.md (human-readable memory) next to the DB.
    // Reuses the built generator — no duplicated markdown logic in this hook.
    try {
      const { generateContextMd } = require(path.join(__dirname, '..', '..', 'dist', 'session', 'ContextGenerator.js'));
      generateContextMd(db, path.dirname(DB_PATH));
    } catch { /* dist not built or dir read-only — non-fatal */ }

    db.close();
  } catch (err) {
    process.stderr.write(`[Continuum] stop hook error: ${err.message}\n`);
  }
}

main();
