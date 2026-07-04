#!/usr/bin/env node

/**
 * Continuum CLI
 *
 *   continuum init    — one-command setup for the current project:
 *                       .mcp.json + hooks + .gitignore. Idempotent.
 *   continuum status  — (coming in v1.1) read-only health/index/session view
 *   continuum start   — run the MCP server (used by MCP clients via .mcp.json)
 */

import * as fs from 'fs';
import * as path from 'path';
import { detectProjectRoot } from '../utils/projectRoot';

const command = process.argv[2];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ok   = (msg: string) => console.log(`  ✅  ${msg}`);
const info = (msg: string) => console.log(`  ℹ️   ${msg}`);
const fail = (msg: string) => console.log(`  ❌  ${msg}`);

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Locate the directory this Continuum installation lives in, whether running
 * from a global npx cache, a local node_modules, or a git clone. Everything
 * (server entry, hook scripts) is resolved relative to this — no hand-edited
 * absolute paths for the user, ever.
 */
function continuumHome(): string {
  // dist/cli/index.js → up two levels = package root (same for src/ under tsx)
  return path.resolve(__dirname, '..', '..');
}

// ─── init ────────────────────────────────────────────────────────────────────

interface HookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

function initCommand(): void {
  console.log('');
  console.log('  Continuum — project setup');
  console.log('  ─────────────────────────────────────────────');

  const home = continuumHome();
  const serverJs = path.join(home, 'dist', 'mcp', 'McpServer.js');
  const hooksDir = path.join(home, 'scripts', 'hooks');

  // 0. Preflight: the built server must exist
  if (!fs.existsSync(serverJs)) {
    fail(`dist/mcp/McpServer.js not found in ${home}`);
    console.log('      Run "npm run build" in the Continuum directory first, then re-run init.');
    process.exit(1);
  }

  // 1. Detect project root from cwd
  const projectRoot = detectProjectRoot(process.cwd());
  const marker = fs.existsSync(path.join(projectRoot, '.git')) ? '.git'
    : fs.existsSync(path.join(projectRoot, 'package.json')) ? 'package.json'
    : 'directory';
  ok(`Project root: ${projectRoot}  (detected via ${marker})`);

  // 2. Write .mcp.json — per-project entry, no WATCH_PATHS / DB_PATH.
  //    The server auto-detects both from cwd.
  const mcpFile = path.join(projectRoot, '.mcp.json');
  const mcp = (readJson(mcpFile) ?? {}) as { mcpServers?: Record<string, unknown> };
  if (!mcp.mcpServers) mcp.mcpServers = {};
  mcp.mcpServers['continuum'] = {
    command: process.execPath,
    args: [serverJs],
    cwd: projectRoot,
    env: {
      LOG_LEVEL: 'info',
      SESSION_RESUME_HOURS: '4',
    },
  };
  writeJson(mcpFile, mcp);
  ok(`.mcp.json written  (server auto-detects root and DB from cwd)`);

  // 3. Wire hooks into .claude/settings.json — non-destructive merge.
  //    We only append our own entries; existing hooks from other tools are kept.
  const claudeDir = path.join(projectRoot, '.claude');
  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

  type HookGroup = { matcher?: string; hooks: HookEntry[] };
  type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;
  const settings = (readJson(settingsFile) ?? {}) as Settings;
  if (!settings.hooks) settings.hooks = {};

  const HOOK_WIRING: { event: string; script: string; timeout: number; matcher?: string }[] = [
    { event: 'PreCompact',         script: 'pre-compact.js',       timeout: 5000 },
    { event: 'Stop',               script: 'stop.js',              timeout: 10000 },
    { event: 'PostToolUse',        script: 'post-tool-use.js',     timeout: 3000, matcher: '' },
    { event: 'PostToolUseFailure', script: 'post-tool-failure.js', timeout: 3000, matcher: '' },
    { event: 'SessionStart',       script: 'session-start.js',     timeout: 3000 },
  ];

  let wired = 0;
  let already = 0;
  for (const { event, script, timeout, matcher } of HOOK_WIRING) {
    const scriptPath = path.join(hooksDir, script);
    if (!fs.existsSync(scriptPath)) {
      fail(`hook script missing: ${scriptPath} — skipping ${event}`);
      continue;
    }
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;

    if (!settings.hooks[event]) settings.hooks[event] = [];
    const groups = settings.hooks[event];

    // Idempotency: skip if any existing entry already points at this script
    const exists = groups.some(g => g.hooks?.some(h => h.command?.includes(script)));
    if (exists) { already++; continue; }

    const group: HookGroup = { hooks: [{ type: 'command', command: cmd, timeout }] };
    if (matcher !== undefined) group.matcher = matcher;
    groups.push(group);
    wired++;
  }
  writeJson(settingsFile, settings);
  if (wired > 0) ok(`.claude/settings.json — ${wired} hook(s) wired (PreCompact, Stop, PostToolUse, PostToolUseFailure, SessionStart)`);
  if (already > 0) info(`${already} hook(s) were already wired — left untouched`);

  // 4. .gitignore — keep .continuum/ (per-project DB) out of the repo
  const gitignoreFile = path.join(projectRoot, '.gitignore');
  let gitignore = '';
  try { gitignore = fs.readFileSync(gitignoreFile, 'utf8'); } catch { /* new file */ }
  if (gitignore.includes('.continuum/')) {
    info('.gitignore already excludes .continuum/');
  } else {
    const sep = gitignore.length > 0 && !gitignore.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(
      gitignoreFile,
      `${gitignore}${sep}\n# Continuum — local AI memory (never commit)\n.continuum/\n`,
      'utf8'
    );
    ok('.gitignore updated — .continuum/ excluded');
  }

  // 5. Pre-create .continuum/ so the first server boot doesn't race
  const contDir = path.join(projectRoot, '.continuum');
  if (!fs.existsSync(contDir)) {
    fs.mkdirSync(contDir, { recursive: true });
    ok('.continuum/ created  (knowledge.db will live here)');
  }

  console.log('  ─────────────────────────────────────────────');
  console.log('  Done. Open this project in your editor — Continuum starts');
  console.log('  automatically and remembers everything from here on.');
  console.log('');
  console.log('  Verify anytime:  ask your AI to "call health_check"');
  console.log('');
}

// ─── dispatch ────────────────────────────────────────────────────────────────

if (command === 'init') {
  initCommand();
} else if (command === 'status') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { runStatus } = require('./status') as typeof import('./status');
  runStatus(process.argv.includes('--json'));
} else if (command === 'start') {
  require('../mcp/McpServer.js');
} else {
  console.log('Continuum — AI development memory layer');
  console.log('');
  console.log('Usage:');
  console.log('  npx continuum-ai-mcp init            Set up this project (MCP config + hooks + gitignore)');
  console.log('  npx continuum-ai-mcp status [--json]  Show project, index, session, and hook health');
  console.log('  npx continuum-ai-mcp start           Run the MCP server (normally started by your editor)');
}
