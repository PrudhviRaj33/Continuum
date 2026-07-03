/**
 * continuum status — read-only view of what Continuum knows and whether it's healthy.
 *
 * Design constraints:
 * - Read-only DB open: must never lock or disturb a running server.
 * - Must work when the server is DOWN — that's exactly when a user reaches for it.
 * - Every "silent wrongness" failure mode found in the wild gets a line here:
 *   wrong project root, stale index, hooks not wired, DB corruption.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { detectProjectRoot } from '../utils/projectRoot';

interface StatusReport {
  version: string;
  project_root: string;
  root_detected_via: string;
  db: {
    path: string;
    exists: boolean;
    size_bytes: number;
    integrity: string;
  };
  server: { running: boolean; pids: number[] };
  session: {
    id: string;
    goal: string | null;
    started_at: number;
    updated_at: number;
    compaction_count: number;
    last_task_goal: string | null;
    last_task_saved_at: number | null;
  } | null;
  index: {
    files: number;
    symbols: number;
    fts_entries: number;
    last_parsed: number | null;
    languages: { language: string; files: number; symbols: number }[];
  } | null;
  hooks: { event: string; wired: boolean; script_exists: boolean }[];
  recent_touches: { path: string; action: string; touched_at: number }[];
}

function detectionMarker(root: string): string {
  for (const m of ['.git', 'package.json', 'tsconfig.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']) {
    if (fs.existsSync(path.join(root, m))) return m;
  }
  try {
    if (fs.readdirSync(root).some(f => f.endsWith('.sln') || f.endsWith('.csproj'))) return '*.sln/*.csproj';
  } catch { /* ignore */ }
  return 'cwd (no marker found)';
}

/**
 * Find Continuum server processes for THIS project — pgrep matches every
 * Continuum instance on the machine (one per project), so filter each pid
 * by its working directory.
 */
function findServerPids(projectRoot: string): number[] {
  let pids: number[] = [];
  try {
    const out = execSync('pgrep -f "dist/mcp/McpServer.js"', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    pids = out.trim().split('\n').filter(Boolean).map(Number).filter(n => n !== process.pid);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }

  return pids.filter(pid => {
    try {
      // macOS/Linux: lsof reports the process cwd; match it against the project root
      const cwdLine = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | grep '^n' | head -1`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const cwd = cwdLine.startsWith('n') ? cwdLine.slice(1) : '';
      return cwd === projectRoot || cwd.startsWith(projectRoot + path.sep);
    } catch {
      return false; // can't inspect (permissions/gone) — don't claim it's ours
    }
  });
}

function checkHooks(projectRoot: string): StatusReport['hooks'] {
  const HOOK_EVENTS: { event: string; script: string }[] = [
    { event: 'PreCompact',         script: 'pre-compact.js' },
    { event: 'Stop',               script: 'stop.js' },
    { event: 'PostToolUse',        script: 'post-tool-use.js' },
    { event: 'PostToolUseFailure', script: 'post-tool-failure.js' },
  ];

  let settings: { hooks?: Record<string, { hooks?: { command?: string }[] }[]> } = {};
  try {
    settings = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'settings.json'), 'utf8'));
  } catch { /* no settings file — all unwired */ }

  return HOOK_EVENTS.map(({ event, script }) => {
    const groups = settings.hooks?.[event] ?? [];
    const entry = groups.flatMap(g => g.hooks ?? []).find(h => h.command?.includes(script));
    let scriptExists = false;
    if (entry?.command) {
      // command is `"node" "/path/to/script.js"` — extract the script path
      const m = entry.command.match(/"([^"]+\.js)"/g);
      const scriptPath = m ? m[m.length - 1].replace(/"/g, '') : null;
      scriptExists = scriptPath ? fs.existsSync(scriptPath) : false;
    }
    return { event, wired: !!entry, script_exists: scriptExists };
  });
}

function collectStatus(): StatusReport {
  const projectRoot = detectProjectRoot(process.cwd());
  const dbPath = process.env.DB_PATH || path.join(projectRoot, '.continuum', 'knowledge.db');

  let pkgVersion = 'unknown';
  try {
    pkgVersion = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch { /* ignore */ }

  const report: StatusReport = {
    version: pkgVersion,
    project_root: projectRoot,
    root_detected_via: detectionMarker(projectRoot),
    db: { path: dbPath, exists: fs.existsSync(dbPath), size_bytes: 0, integrity: 'n/a' },
    server: { running: false, pids: [] },
    session: null,
    index: null,
    hooks: checkHooks(projectRoot),
    recent_touches: [],
  };

  const pids = findServerPids(projectRoot);
  report.server = { running: pids.length > 0, pids };

  if (!report.db.exists) return report;

  report.db.size_bytes = fs.statSync(dbPath).size;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  let db: import('better-sqlite3').Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    report.db.integrity = `unreadable: ${err instanceof Error ? err.message : String(err)}`;
    return report;
  }

  try {
    const integ = db.pragma('integrity_check') as { integrity_check: string }[];
    report.db.integrity = integ[0]?.integrity_check ?? 'unknown';

    const sess = db.prepare(`
      SELECT s.id, s.goal, s.started_at, s.updated_at, s.compaction_count,
             (SELECT t.goal FROM tasks t WHERE t.session_id = s.id ORDER BY t.saved_at DESC LIMIT 1) AS last_task_goal,
             (SELECT t.saved_at FROM tasks t WHERE t.session_id = s.id ORDER BY t.saved_at DESC LIMIT 1) AS last_task_saved_at
      FROM sessions s ORDER BY s.updated_at DESC LIMIT 1
    `).get() as StatusReport['session'] & { id: string } | undefined;
    report.session = sess ?? null;

    const totals = db.prepare(`
      SELECT COUNT(DISTINCT f.id) AS files, COUNT(s.id) AS symbols, MAX(f.last_parsed) AS last_parsed
      FROM files f LEFT JOIN symbols s ON s.file_id = f.id
    `).get() as { files: number; symbols: number; last_parsed: number | null };

    const fts = (db.prepare('SELECT COUNT(*) AS n FROM symbols_fts').get() as { n: number }).n;

    const languages = db.prepare(`
      SELECT language, COUNT(*) AS files, SUM(symbol_count) AS symbols
      FROM files WHERE language IS NOT NULL
      GROUP BY language ORDER BY symbols DESC LIMIT 8
    `).all() as { language: string; files: number; symbols: number }[];

    report.index = { files: totals.files, symbols: totals.symbols, fts_entries: fts, last_parsed: totals.last_parsed, languages };

    if (sess) {
      report.recent_touches = db.prepare(`
        SELECT path, action, MAX(touched_at) AS touched_at FROM touched_files
        WHERE session_id = ? GROUP BY path ORDER BY touched_at DESC LIMIT 5
      `).all(sess.id) as StatusReport['recent_touches'];
    }
  } finally {
    db.close();
  }

  return report;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function ago(epoch: number | null): string {
  if (!epoch) return 'never';
  const s = Math.floor(Date.now() / 1000) - epoch;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function mb(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

export function runStatus(jsonMode: boolean): void {
  const r = collectStatus();

  if (jsonMode) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const line = '  ─────────────────────────────────────────────────────';
  console.log('');
  console.log(`  Continuum v${r.version}`);
  console.log(line);
  console.log(`  PROJECT   ${r.project_root}`);
  console.log(`            detected via ${r.root_detected_via}`);

  if (!r.db.exists) {
    console.log(`  DATABASE  not found at ${r.db.path}`);
    console.log(`            run "continuum init" here, then open the project in your editor`);
  } else {
    const integrityNote = r.db.integrity === 'ok' ? 'integrity: ok' : `⚠️ integrity: ${r.db.integrity}`;
    console.log(`  DATABASE  ${r.db.path}`);
    console.log(`            ${mb(r.db.size_bytes)} · ${integrityNote}`);
  }

  console.log(`  SERVER    ${r.server.running ? `running (pid ${r.server.pids.join(', ')})` : 'not running — starts when your editor opens the project'}`);

  if (r.session) {
    console.log(line);
    console.log(`  SESSION   ${r.session.id.slice(0, 8)} · started ${ago(r.session.started_at)} · active ${ago(r.session.updated_at)} · ${r.session.compaction_count} compaction(s) survived`);
    if (r.session.last_task_goal) {
      console.log(`  LAST TASK "${r.session.last_task_goal}"  (saved ${ago(r.session.last_task_saved_at)})`);
    }
  }

  if (r.index) {
    console.log(line);
    console.log(`  INDEX     ${r.index.files.toLocaleString()} files · ${r.index.symbols.toLocaleString()} symbols · FTS ${r.index.fts_entries.toLocaleString()} · last parse ${ago(r.index.last_parsed)}`);
    const ftsDrift = Math.abs(r.index.fts_entries - r.index.symbols);
    if (ftsDrift > Math.max(10, r.index.symbols * 0.01)) {
      console.log(`            ⚠️ FTS drift: ${ftsDrift} entries out of sync — run reindex`);
    }
    for (const l of r.index.languages.slice(0, 5)) {
      console.log(`            ${l.language.padEnd(12)} ${String(l.symbols ?? 0).padStart(8)} symbols in ${l.files} files`);
    }
  }

  console.log(line);
  const wiredCount = r.hooks.filter(h => h.wired && h.script_exists).length;
  console.log(`  HOOKS     ${wiredCount}/${r.hooks.length} wired`);
  for (const h of r.hooks) {
    const state = h.wired && h.script_exists ? '✅' : h.wired ? '⚠️ wired but script missing' : '❌ not wired';
    console.log(`            ${h.event.padEnd(20)} ${state}`);
  }
  if (wiredCount < r.hooks.length) {
    console.log(`            run "continuum init" to wire missing hooks`);
  }

  if (r.recent_touches.length) {
    console.log(line);
    console.log(`  RECENT`);
    for (const t of r.recent_touches) {
      console.log(`            ${t.action.padEnd(9)} ${t.path}  (${ago(t.touched_at)})`);
    }
  }
  console.log(line);
  console.log('');
}
