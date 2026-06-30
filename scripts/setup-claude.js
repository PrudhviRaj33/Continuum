#!/usr/bin/env node

/**
 * Continuum — Claude Setup Script
 *
 * Registers Continuum as an MCP server for ALL Claude surfaces in one command.
 * No files are written to your project folders — everything goes into global config.
 *
 * What it does:
 *   1. Patches ~/.claude.json        → VS Code Claude Code extension picks up Continuum
 *   2. Patches claude_desktop_config.json → Claude desktop app picks up Continuum
 *   3. Writes ~/.claude/CLAUDE.md    → Claude always prefers Continuum tools over file reads
 *
 * Usage:
 *   node scripts/setup-claude.js /path/to/project1 /path/to/project2 ...
 *
 * Example:
 *   node scripts/setup-claude.js \
 *     /Users/me/projects/MyWebAPI \
 *     /Users/me/projects/MyWebApp \
 *     /Users/me/projects/MyDatabase
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

// ─── Paths ───────────────────────────────────────────────────────────────────

const CONTINUUM_DIR      = path.resolve(__dirname, '..');
const MCP_SERVER_JS      = path.join(CONTINUUM_DIR, 'dist', 'mcp', 'McpServer.js');
const NODE_BIN           = process.execPath;

const CLAUDE_JSON        = path.join(os.homedir(), '.claude.json');
const CLAUDE_DIR         = path.join(os.homedir(), '.claude');
const CLAUDE_MD          = path.join(CLAUDE_DIR, '.claude/CLAUDE.md');
const DESKTOP_CONFIG     = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ok   = msg => console.log(`  ✅  ${msg}`);
const warn = msg => console.log(`  ⚠️   ${msg}`);
const fail = msg => console.log(`  ❌  ${msg}`);
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

// ─── Build the MCP server entry ───────────────────────────────────────────────

function buildServerEntry(watchPaths) {
  return {
    command: NODE_BIN,
    args: [MCP_SERVER_JS],
    env: {
      WATCH_PATHS: watchPaths,
      DB_PATH: path.join(CONTINUUM_DIR, 'knowledge.db'),
      LOG_LEVEL: 'info',
      BULK_TOUCH_THRESHOLD: '30'
    }
  };
}

// ─── Step 1: ~/.claude.json  (VS Code Claude Code extension) ─────────────────

function patchClaudeJson(watchPaths) {
  const data = readJson(CLAUDE_JSON) || {};
  if (!data.mcpServers) data.mcpServers = {};
  data.mcpServers.continuum = buildServerEntry(watchPaths);
  writeJson(CLAUDE_JSON, data);
  ok(`~/.claude.json patched  (VS Code extension source)`);
}

// ─── Step 2: claude_desktop_config.json  (Claude desktop app) ────────────────

function patchDesktopConfig(watchPaths) {
  if (!fs.existsSync(DESKTOP_CONFIG)) {
    warn(`Claude desktop config not found — skipping desktop app patch`);
    return;
  }
  const data = readJson(DESKTOP_CONFIG) || {};
  if (!data.mcpServers) data.mcpServers = {};
  data.mcpServers.continuum = buildServerEntry(watchPaths);
  writeJson(DESKTOP_CONFIG, data);
  ok(`claude_desktop_config.json patched  (desktop app source)`);
}

// ─── Step 3: ~/.claude/CLAUDE.md  (global Claude instructions) ───────────────

function writeClaudeMd() {
  ensureDir(CLAUDE_DIR);
  fs.writeFileSync(path.join(CLAUDE_DIR, 'CLAUDE.md'), `# Global Claude Instructions

## Code Search & Navigation
Always use Continuum MCP tools for code search, symbol lookup, and finding related files.
Prefer these over reading files directly to save tokens:

- \`mcp__continuum__search_symbols\`    — find functions, classes, types by name
- \`mcp__continuum__find_related_files\` — find files related to a given file
- \`mcp__continuum__get_dependencies\`  — get imports/dependencies for a file or symbol
- \`mcp__continuum__get_touched_files\` — see what files were changed this session
- \`mcp__continuum__get_session\`       — recover full session state after context compaction

Only open a file directly with Read if Continuum results are insufficient or you need the full content for editing.

## Session Recovery
After any context compaction, call \`mcp__continuum__get_session\` before doing anything else.
`, 'utf8');
  ok(`~/.claude/CLAUDE.md written  (global tool preference instructions)`);
}

// ─── Step 4: Validate ────────────────────────────────────────────────────────

function validate() {
  if (!fs.existsSync(MCP_SERVER_JS)) {
    fail(`dist/mcp/McpServer.js not found — run "npm run build" first`);
    return;
  }
  ok(`McpServer.js found at ${MCP_SERVER_JS}`);

  try {
    const pids = execSync('pgrep -f McpServer.js', { encoding: 'utf8' }).trim();
    if (pids) ok(`Continuum already running (PID ${pids.split('\n').join(', ')})`);
  } catch {
    warn(`Continuum not currently running — the desktop app or VS Code will start it automatically`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  log('');
  log('╔══════════════════════════════════════════╗');
  log('║   Continuum — Claude Setup               ║');
  log('╚══════════════════════════════════════════╝');
  log('');

  const projectPaths = process.argv.slice(2).map(p => path.resolve(p));

  if (projectPaths.length === 0) {
    log('Usage:');
    log('  node scripts/setup-claude.js /path/to/project1 /path/to/project2 ...');
    log('');
    log('Example:');
    log('  node scripts/setup-claude.js ~/projects/MyWebAPI ~/projects/MyWebApp');
    process.exit(1);
  }

  // Validate all paths exist
  for (const p of projectPaths) {
    if (!fs.existsSync(p)) {
      fail(`Path does not exist: ${p}`);
      process.exit(1);
    }
  }

  const watchPaths = projectPaths.join(',');

  log(`Projects to watch:`);
  projectPaths.forEach(p => log(`  • ${p}`));
  log('');

  log('[ Step 1 ] Patching ~/.claude.json for VS Code extension...');
  patchClaudeJson(watchPaths);
  log('');

  log('[ Step 2 ] Patching Claude desktop app config...');
  patchDesktopConfig(watchPaths);
  log('');

  log('[ Step 3 ] Writing ~/.claude/CLAUDE.md...');
  writeClaudeMd();
  log('');

  log('[ Step 4 ] Validating...');
  validate();
  log('');

  log('╔══════════════════════════════════════════╗');
  log('║   Setup complete!                        ║');
  log('╚══════════════════════════════════════════╝');
  log('');
  log('Next steps:');
  log('  • VS Code  : Fully quit (Cmd+Q) and reopen VS Code');
  log('  • Desktop  : Restart the Claude desktop app');
  log('  • Verify   : Ask Claude "what tools do you have?" — you should see 10 Continuum tools');
  log('');
}

main();
