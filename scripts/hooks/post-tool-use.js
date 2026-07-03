#!/usr/bin/env node
/**
 * Continuum PostToolUse Hook
 *
 * Claude Code fires this hook after every tool call. We capture Edit/Write/Bash
 * calls and record the affected file paths into touched_files — so get_session
 * and get_touched_files work without the AI needing to call save_task.
 *
 * Silently exits on non-matching tools to keep overhead minimal.
 * Installation: add to your project's .claude/settings.json under hooks.PostToolUse
 */

'use strict';

const path = require('path');

// Only capture tools that meaningfully mutate the workspace
const CAPTURE_TOOLS = new Set(['Edit', 'Write', 'Bash', 'MultiEdit', 'NotebookEdit']);

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const toolName = String(data.tool_name || data.toolName || '');

    if (!CAPTURE_TOOLS.has(toolName)) return;

    const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'knowledge.db');
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH);

    // Get current session
    const session = db.prepare(
      'SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1'
    ).get();

    if (!session) { db.close(); return; }

    // Extract file path from tool input
    const toolInput = data.tool_input || data.toolInput || {};
    const filePath = toolInput.file_path || toolInput.filePath || null;

    if (filePath) {
      // Debounce: skip if same file touched in last 5 seconds
      const recent = db.prepare(`
        SELECT id FROM touched_files
        WHERE session_id = ? AND path = ? AND touched_at > unixepoch() - 5
        LIMIT 1
      `).get(session.id, filePath);

      if (!recent) {
        db.prepare(`
          INSERT INTO touched_files (session_id, path, action, touched_at)
          VALUES (?, ?, 'modified', unixepoch())
        `).run(session.id, filePath);

        db.prepare(`UPDATE sessions SET updated_at = unixepoch() WHERE id = ?`).run(session.id);
      }
    }

    // Log the tool call to tool_usage (truncate inputs to stay under 4000 chars)
    const inputJson = JSON.stringify(toolInput).slice(0, 4000);
    const outputJson = JSON.stringify(data.tool_output || data.toolOutput || {});
    db.prepare(`
      INSERT INTO tool_usage (session_id, tool_name, input_json, tokens_returned, duration_ms, called_at)
      VALUES (?, ?, ?, ?, 0, unixepoch())
    `).run(session.id, toolName, inputJson, outputJson.length);

    db.close();
  } catch (err) {
    process.stderr.write(`[Continuum] post-tool-use hook error: ${err.message}\n`);
  }
}

main();
