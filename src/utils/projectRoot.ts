import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Ordered by specificity — first match wins
const ROOT_MARKERS = [
  '.git',
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'pyproject.toml',
  'setup.py',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  '*.sln',
  '*.csproj',
  'composer.json',
  'Gemfile',
  'mix.exs',
];

/**
 * Walk up from `startDir` looking for a project root marker file.
 * Stops at the filesystem root or the user's home directory.
 * Returns the directory containing the first marker found, or `startDir` itself.
 */
export function detectProjectRoot(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);
  const home = os.homedir();
  const fsRoot = path.parse(dir).root;

  while (dir !== fsRoot) {
    for (const marker of ROOT_MARKERS) {
      if (marker.includes('*')) {
        // Glob-style: scan directory for matching files
        const ext = marker.replace('*', '');
        try {
          const entries = fs.readdirSync(dir);
          if (entries.some(e => e.endsWith(ext))) return dir;
        } catch { /* permission error — skip */ }
      } else {
        if (fs.existsSync(path.join(dir, marker))) return dir;
      }
    }

    // Don't walk above the home directory
    if (dir === home) break;

    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return startDir; // no marker found — use startDir as-is
}

/**
 * Determine the watch paths for Continuum:
 * 1. If WATCH_PATHS env var is set → use it (explicit override, backwards compat)
 * 2. If PROJECT_ROOT env var is set → use it
 * 3. Auto-detect: walk up from cwd to find project root
 */
export function resolveWatchPaths(): string[] {
  if (process.env.WATCH_PATHS) {
    return process.env.WATCH_PATHS.split(',').map(p => p.trim()).filter(Boolean);
  }

  const root = process.env.PROJECT_ROOT
    ? path.resolve(process.env.PROJECT_ROOT)
    : detectProjectRoot(process.cwd());

  return [root];
}

/**
 * Determine the DB path for this project:
 * 1. DB_PATH env var → use it (explicit override)
 * 2. Place knowledge.db inside .continuum/ in the project root (per-project isolation)
 */
export function resolveDbPath(projectRoot: string): string {
  if (process.env.DB_PATH) {
    return process.env.DB_PATH;
  }

  const dotContinuum = path.join(projectRoot, '.continuum');
  try {
    if (!fs.existsSync(dotContinuum)) {
      fs.mkdirSync(dotContinuum, { recursive: true });
    }
  } catch {
    // Fall back to cwd if we can't create .continuum/
    return path.join(process.cwd(), 'knowledge.db');
  }

  return path.join(dotContinuum, 'knowledge.db');
}
