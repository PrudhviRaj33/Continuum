#!/usr/bin/env node
/**
 * Continuum SessionStart Hook
 *
 * Claude Code fires this when a new session begins. Whatever this script
 * writes to stdout is injected into the session's starting context — so every
 * fresh session begins with the project's distilled memory (context.md)
 * already loaded, with zero AI cooperation required.
 *
 * Installation: wired automatically by `continuum init`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), '.continuum', 'knowledge.db');
    const contextPath = path.join(path.dirname(DB_PATH), 'context.md');

    if (!fs.existsSync(contextPath)) return; // nothing distilled yet — stay silent

    const content = fs.readFileSync(contextPath, 'utf8');
    if (!content.trim()) return;

    // Cap the injection so a huge hand-edited file can't flood the context window
    const MAX_CHARS = 6000; // ~1500 tokens
    const body = content.length > MAX_CHARS
      ? content.slice(0, MAX_CHARS) + '\n\n…(truncated — full file: .continuum/context.md)'
      : content;

    process.stdout.write(
      `## [Continuum] Project Memory\n${body}\n---\n`
    );
  } catch (err) {
    process.stderr.write(`[Continuum] session-start hook error: ${err.message}\n`);
  }
}

main();
