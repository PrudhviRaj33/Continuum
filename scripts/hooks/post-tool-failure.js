#!/usr/bin/env node
/**
 * Continuum PostToolFailure Hook
 *
 * Claude Code fires this hook when a tool call fails. We store the error
 * in tool_errors so get_session can surface "recent errors" — giving the AI
 * full context on what went wrong without manual explanation.
 *
 * Installation: add to your project's .claude/settings.json under hooks.PostToolUseFailure
 */

'use strict';

const path = require('path');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);

    // Skip user-initiated interrupts (Ctrl+C cancels are not tool failures)
    if (data.is_interrupt) return;

    const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'knowledge.db');
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH);

    const session = db.prepare(
      'SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1'
    ).get();

    if (!session) { db.close(); return; }

    const toolName = String(data.tool_name || data.toolName || 'unknown').slice(0, 100);
    const inputJson = JSON.stringify(data.tool_input || data.toolInput || {}).slice(0, 4000);
    const errorMsg  = String(data.error || data.message || data.error_message || '').slice(0, 4000);

    db.prepare(`
      INSERT INTO tool_errors (session_id, tool_name, input_json, error_msg, occurred_at)
      VALUES (?, ?, ?, ?, unixepoch())
    `).run(session.id, toolName, inputJson, errorMsg);

    db.close();
  } catch (err) {
    process.stderr.write(`[Continuum] post-tool-failure hook error: ${err.message}\n`);
  }
}

main();
