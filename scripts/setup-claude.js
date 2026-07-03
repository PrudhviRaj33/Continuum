#!/usr/bin/env node

/**
 * Continuum — Claude Setup Script
 *
 * NEW ARCHITECTURE (per-project, zero WATCH_PATHS config):
 *
 *   For each project:
 *     - Writes <project>/.mcp.json  → Claude Code CLI picks up Continuum with cwd=project
 *     - Writes <project>/.gitignore entry for .continuum/ (per-project DB)
 *
 *   Global (one-time):
 *     - Patches ~/.claude.json → VS Code Claude Code extension (global MCP registration)
 *     - Patches claude_desktop_config.json → Claude desktop app
 *     - Writes ~/.claude/CLAUDE.md → tool preference instructions
 *
 * KEY CHANGE: No WATCH_PATHS in the MCP config. The server auto-detects its
 * project root from process.cwd() at startup. Each project gets its own
 * knowledge.db stored in <project>/.continuum/knowledge.db (gitignored).
 *
 * Usage:
 *   node scripts/setup-claude.js /path/to/project1 /path/to/project2 ...
 *
 *   # Or for current directory only:
 *   node scripts/setup-claude.js .
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

// ─── Paths ────────────────────────────────────────────────────────────────────

const CONTINUUM_DIR  = path.resolve(__dirname, '..');
const MCP_SERVER_JS  = path.join(CONTINUUM_DIR, 'dist', 'mcp', 'McpServer.js');
const NODE_BIN       = process.execPath;

const CLAUDE_JSON    = path.join(os.homedir(), '.claude.json');
const CLAUDE_DIR     = path.join(os.homedir(), '.claude');
const DESKTOP_CONFIG = path.join(
  os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ok   = msg => console.log(`  ✅  ${msg}`);
const warn = msg => console.log(`  ⚠️   ${msg}`);
const fail = msg => console.log(`  ❌  ${msg}`);
const info = msg => console.log(`  ℹ️   ${msg}`);
const log  = msg => console.log(msg);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ─── Build MCP server entries ─────────────────────────────────────────────────

/**
 * Per-project .mcp.json entry — no WATCH_PATHS, cwd = project root.
 * Server auto-detects the project from its working directory.
 */
function buildPerProjectEntry(projectPath) {
  return {
    command: NODE_BIN,
    args: [MCP_SERVER_JS],
    cwd: projectPath,  // ← this is what makes auto-detection work
    env: {
      LOG_LEVEL: 'info',
      SESSION_RESUME_HOURS: '4',
      // DB_PATH intentionally omitted — defaults to .continuum/knowledge.db in cwd
      // WATCH_PATHS intentionally omitted — auto-detected from cwd
    }
  };
}

/**
 * Global ~/.claude.json entry — used by VS Code extension and desktop app.
 * Without cwd per-project (global config has one entry for all), we pass
 * WATCH_PATHS here only as a fallback for users who haven't set up per-project.
 * If the user has per-project .mcp.json, this global entry is redundant but harmless.
 */
function buildGlobalEntry(projectPaths) {
  return {
    command: NODE_BIN,
    args: [MCP_SERVER_JS],
    env: {
      WATCH_PATHS: projectPaths.join(','),
      LOG_LEVEL: 'info',
      SESSION_RESUME_HOURS: '4',
    }
  };
}

// ─── Step 1: Per-project .mcp.json (Claude Code CLI + VS Code workspace) ─────

function writePerProjectMcpJson(projectPath) {
  const mcpFile = path.join(projectPath, '.mcp.json');
  const existing = readJson(mcpFile) || {};

  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.continuum = buildPerProjectEntry(projectPath);

  writeJson(mcpFile, existing);
  ok(`.mcp.json written → ${mcpFile}`);
}

// ─── Step 2: .gitignore entry for .continuum/ ─────────────────────────────────

function ensureGitignore(projectPath) {
  const gitignoreFile = path.join(projectPath, '.gitignore');
  const entry = '.continuum/';

  let contents = '';
  try { contents = fs.readFileSync(gitignoreFile, 'utf8'); } catch { /* new file */ }

  if (contents.includes(entry)) {
    info(`.gitignore already has ${entry}`);
    return;
  }

  const newline = contents.length > 0 && !contents.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitignoreFile, `${contents}${newline}\n# Continuum AI memory (per-project symbol index)\n${entry}\n`, 'utf8');
  ok(`.gitignore updated → added ${entry}`);
}

// ─── Step 3: ~/.claude.json (VS Code extension — global fallback) ─────────────

function patchClaudeJson(projectPaths) {
  const data = readJson(CLAUDE_JSON) || {};
  if (!data.mcpServers) data.mcpServers = {};
  data.mcpServers.continuum = buildGlobalEntry(projectPaths);
  writeJson(CLAUDE_JSON, data);
  ok(`~/.claude.json patched (VS Code extension global fallback)`);
  info(`  Note: per-project .mcp.json files take precedence over this global entry`);
}

// ─── Step 4: claude_desktop_config.json (Claude desktop app) ─────────────────

function patchDesktopConfig(projectPaths) {
  if (!fs.existsSync(DESKTOP_CONFIG)) {
    warn(`Claude desktop config not found — skipping`);
    return;
  }
  const data = readJson(DESKTOP_CONFIG) || {};
  if (!data.mcpServers) data.mcpServers = {};
  data.mcpServers.continuum = buildGlobalEntry(projectPaths);
  writeJson(DESKTOP_CONFIG, data);
  ok(`claude_desktop_config.json patched (desktop app)`);
}

// ─── Step 5: ~/.claude/CLAUDE.md (global tool preference instructions) ────────

function writeClaudeMd() {
  ensureDir(CLAUDE_DIR);
  fs.writeFileSync(path.join(CLAUDE_DIR, 'CLAUDE.md'), `# Global Claude Instructions

## Code Search & Navigation
Always use Continuum MCP tools for code search, symbol lookup, and finding related files.
Prefer these over reading files directly to save tokens:

- \`mcp__continuum__search_symbols\`    — find functions, classes, types by name
- \`mcp__continuum__smart_search\`      — unified search across symbols + session tasks + files
- \`mcp__continuum__find_related_files\` — find files related to a given file
- \`mcp__continuum__get_dependencies\`  — get imports/dependencies for a file or symbol
- \`mcp__continuum__get_touched_files\` — see what files were changed this session
- \`mcp__continuum__get_session\`       — recover full session state after context compaction

Only open a file directly with Read if Continuum results are insufficient or you need the full content for editing.

## Session Recovery
After any context compaction, call \`mcp__continuum__get_session\` before doing anything else.
`, 'utf8');
  ok(`~/.claude/CLAUDE.md written`);
}

// ─── Step 6: Validate ─────────────────────────────────────────────────────────

function validate() {
  if (!fs.existsSync(MCP_SERVER_JS)) {
    fail(`dist/mcp/McpServer.js not found — run "npm run build" first, then re-run this script`);
    return;
  }
  ok(`McpServer.js found at ${MCP_SERVER_JS}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  log('');
  log('╔══════════════════════════════════════════════╗');
  log('║   Continuum — Claude Setup (Auto-detect)     ║');
  log('╚══════════════════════════════════════════════╝');
  log('');

  const args = process.argv.slice(2);

  if (args.length === 0) {
    log('Usage:');
    log('  node scripts/setup-claude.js /path/to/project1 /path/to/project2 ...');
    log('');
    log('  # Setup for just the current directory:');
    log('  node scripts/setup-claude.js .');
    log('');
    log('Example:');
    log('  node scripts/setup-claude.js ~/projects/MyWebAPI ~/projects/MyWebApp');
    log('');
    log('What this does:');
    log('  • Writes .mcp.json to each project root (no WATCH_PATHS needed)');
    log('  • Continuum auto-detects the project root when opened in VS Code / Claude Code');
    log('  • Each project gets its own knowledge.db in .continuum/ (auto-gitignored)');
    process.exit(1);
  }

  const projectPaths = args.map(p => path.resolve(p));

  // Validate all paths exist
  for (const p of projectPaths) {
    if (!fs.existsSync(p)) {
      fail(`Path does not exist: ${p}`);
      process.exit(1);
    }
    if (!fs.statSync(p).isDirectory()) {
      fail(`Not a directory: ${p}`);
      process.exit(1);
    }
  }

  log(`Setting up Continuum for ${projectPaths.length} project(s):`);
  projectPaths.forEach(p => log(`  • ${p}`));
  log('');

  log('[ Step 1 ] Writing per-project .mcp.json files...');
  for (const p of projectPaths) {
    writePerProjectMcpJson(p);
    ensureGitignore(p);
  }
  log('');

  log('[ Step 2 ] Patching ~/.claude.json for VS Code extension (global fallback)...');
  patchClaudeJson(projectPaths);
  log('');

  log('[ Step 3 ] Patching Claude desktop app config...');
  patchDesktopConfig(projectPaths);
  log('');

  log('[ Step 4 ] Writing ~/.claude/CLAUDE.md...');
  writeClaudeMd();
  log('');

  log('[ Step 5 ] Validating...');
  validate();
  log('');

  log('╔══════════════════════════════════════════════╗');
  log('║   Setup complete!                            ║');
  log('╚══════════════════════════════════════════════╝');
  log('');
  log('How it works now:');
  log('  • Open any project in VS Code → Continuum auto-starts with cwd=project');
  log('  • No WATCH_PATHS needed — project root is detected automatically');
  log('  • Symbol index lives in <project>/.continuum/ (gitignored)');
  log('  • Add a new project: run this script again with the new path');
  log('');
  log('Next steps:');
  log('  • VS Code  : Fully quit (Cmd+Q) and reopen VS Code');
  log('  • Desktop  : Restart the Claude desktop app');
  log('  • Verify   : Ask Claude "call health_check" — should show auto_detected: true');
  log('');
}

main();
