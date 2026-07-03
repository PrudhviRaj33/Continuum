#!/usr/bin/env node
/**
 * Continuum PreCompact Hook
 *
 * Claude Code fires this hook BEFORE compacting the conversation context.
 * Whatever this script writes to stdout is prepended to the compacted conversation,
 * so Continuum's session state survives compaction.
 *
 * Installation: add to your project's .claude/settings.json under hooks.PreCompact
 * See CLAUDE_SETUP.md for full setup instructions.
 *
 * Reads SQLite directly (no HTTP, stdio-safe). Never throws — compaction must
 * proceed even if this hook fails.
 */

'use strict';

const path = require('path');

async function main() {
  // Consume stdin (required even if we don't use it)
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    // Resolve DB path: env var > default relative to this script's project root
    const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'knowledge.db');

    // Dynamic require so the hook works even if better-sqlite3 is a project dep
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });

    // Get the most recent session + its latest task
    const row = db.prepare(`
      SELECT
        s.id         AS session_id,
        s.goal       AS session_goal,
        s.compaction_count,
        t.goal       AS task_goal,
        t.decisions,
        t.next_steps,
        t.open_questions
      FROM sessions s
      LEFT JOIN tasks t ON t.session_id = s.id
      WHERE s.id = (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1)
      ORDER BY t.saved_at DESC
      LIMIT 1
    `).get();

    // Files touched in the last 24h for this session
    const touched = row ? db.prepare(`
      SELECT path, action, MAX(touched_at) AS touched_at
      FROM touched_files
      WHERE session_id = ?
        AND touched_at > unixepoch() - 86400
      GROUP BY path
      ORDER BY touched_at DESC
      LIMIT 20
    `).all(row.session_id) : [];

    db.close();

    // Update compaction count (write connection)
    if (row) {
      try {
        const dbWrite = new Database(DB_PATH);
        dbWrite.prepare(`
          UPDATE sessions
          SET compaction_count = compaction_count + 1, updated_at = unixepoch()
          WHERE id = ?
        `).run(row.session_id);
        dbWrite.close();
      } catch {
        // Non-critical — don't let counter failure block context output
      }
    }

    if (!row) {
      // No session found — write nothing, let compaction proceed normally
      return;
    }

    const compactionNum = (row.compaction_count || 0) + 1;

    // Parse JSON fields safely
    const parseJson = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
    const decisions      = parseJson(row.decisions).slice(0, 6);
    const nextSteps      = parseJson(row.next_steps).slice(0, 4);
    const openQuestions  = parseJson(row.open_questions).slice(0, 3);

    // Build compact context block — target < 1500 tokens
    const lines = [
      `## [Continuum] Context Recovery — Compaction #${compactionNum}`,
      '',
    ];

    if (row.session_goal || row.task_goal) {
      lines.push(`**Current goal:** ${row.session_goal || row.task_goal}`);
    }
    if (row.task_goal && row.task_goal !== row.session_goal) {
      lines.push(`**Last saved task:** ${row.task_goal}`);
    }

    if (decisions.length) {
      lines.push('', '**Key decisions made:**');
      decisions.forEach(d => lines.push(`- ${d}`));
    }

    if (nextSteps.length) {
      lines.push('', '**Next steps:**');
      nextSteps.forEach(s => lines.push(`- ${s}`));
    }

    if (openQuestions.length) {
      lines.push('', '**Open questions:**');
      openQuestions.forEach(q => lines.push(`- ${q}`));
    }

    if (touched.length) {
      lines.push('', '**Files touched this session:**');
      touched.forEach(f => {
        const ago = Math.round((Date.now() / 1000 - f.touched_at) / 60);
        lines.push(`- ${f.action}: \`${f.path}\` (${ago}m ago)`);
      });
    }

    lines.push('', '---', '');

    process.stdout.write(lines.join('\n'));

  } catch (err) {
    // Log to stderr only — stdout must stay clean for context injection
    process.stderr.write(`[Continuum] pre-compact hook error: ${err.message}\n`);
  }
}

main();
