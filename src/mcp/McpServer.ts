import { McpServer as MCP } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SessionEngine } from '../session/SessionEngine';
import { FileWatcher } from '../watcher/FileWatcher';
import { IncrementalParser } from '../parser/IncrementalParser';
import { KnowledgeEngine } from '../knowledge/KnowledgeEngine';
import { SchemaReader } from '../schema/SchemaReader';
import { getDb, closeDb } from '../database/Database';
import { resolveWatchPaths, detectProjectRoot } from '../utils/projectRoot';
import { logger } from '../utils/logger';

// Environment variables are injected by the MCP client (IDE) or Docker.
// We explicitly do NOT use dotenv here to prevent `dotenvx` from polluting stdout.

// ── Bootstrap ──────────────────────────────────────────────────────────────

const session  = new SessionEngine();
const parser   = new IncrementalParser();
const watcher  = new FileWatcher(session, parser);
const knowledge = new KnowledgeEngine();
const schema   = new SchemaReader();

// Resolve watch paths — auto-detects project root from cwd if WATCH_PATHS not set.
// Each project gets its own Continuum instance via per-project .mcp.json (no manual config).
const watchPaths = resolveWatchPaths();
const projectRoot = detectProjectRoot(watchPaths[0]);
logger.info({ watchPaths, projectRoot }, 'Continuum starting');
watcher.start(watchPaths);

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new MCP({
  name: 'continuum',
  version: '1.0.0',
});

// ── Observability: log every tool call ─────────────────────────────────────

function logToolCall(
  toolName: string,
  input: unknown,
  result: string,
  durationMs: number
): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO tool_usage (session_id, tool_name, input_json, tokens_returned, duration_ms, called_at)
      VALUES (?, ?, ?, ?, ?, unixepoch())
    `).run(session.getSessionId(), toolName, JSON.stringify(input), result.length, durationMs);
  } catch {
    // Don't let observability crash the server
  }
}

function withTiming<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  return fn().then((result) => [result, Date.now() - start]);
}

// ── Tool 1: get_session ────────────────────────────────────────────────────
server.tool(
  'get_session',
  'Get current session state — goal, touched files, task decisions, and next steps. ' +
  'Call this immediately after any context compaction to resume work seamlessly.',
  {},
  async () => {
    const [state, ms] = await withTiming(async () => session.getSession());
    const result = JSON.stringify(state, null, 2);
    logToolCall('get_session', {}, result, ms);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 2: save_task ──────────────────────────────────────────────────────
// @ts-ignore
server.tool(
  'save_task',
  'Save structured task state — goal, decisions, next steps, open questions. ' +
  'Call this proactively when context is ~60% full to enable seamless recovery.',
  {
    goal:           z.string().describe('What you are currently trying to accomplish'),
    decisions:      z.array(z.string()).describe('Architectural/implementation decisions made'),
    next_steps:     z.array(z.string()).describe('Concrete next steps remaining'),
    open_questions: z.array(z.string()).optional().describe('Unresolved questions'),
  },
  async (input) => {
    const [taskId, ms] = await withTiming(async () =>
      session.saveTask({
        goal:           input.goal,
        decisions:      input.decisions,
        next_steps:     input.next_steps,
        open_questions: input.open_questions ?? [],
      })
    );
    const result = JSON.stringify({ saved: true, task_id: taskId });
    logToolCall('save_task', input, result, ms);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 3: get_touched_files ──────────────────────────────────────────────
server.tool(
  'get_touched_files',
  'Get all files modified, created, or deleted in this session. ' +
  'Check before reading a file to see if you already processed it.',
  {},
  async () => {
    const [files, ms] = await withTiming(async () => session.getTouchedFiles());
    const result = JSON.stringify(files, null, 2);
    logToolCall('get_touched_files', {}, result, ms);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 4: find_related_files ─────────────────────────────────────────────
server.tool(
  'find_related_files',
  'Find all files and symbols related to a feature, class, or concept. ' +
  'Returns matches across all layers (controller / service / repository / UI / test).',
  {
    query: z.string().describe('Feature name, class name, or symbol to search for'),
  },
  async (input) => {
    const [related, ms] = await withTiming(async () => knowledge.findRelated(input.query));
    const result = JSON.stringify(related, null, 2);
    logToolCall('find_related_files', input, result, ms);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 5: get_schema ─────────────────────────────────────────────────────
server.tool(
  'get_schema',
  'Get the live database schema for a table — columns, types, nullability, PKs, FKs, indexes. ' +
  'Supports MSSQL, PostgreSQL, and MySQL. Results cached for 1 hour.',
  {
    table: z.string().describe('Table name, e.g. "Orders", "users"'),
  },
  async (input) => {
    if (!schema.isEnabled()) {
      const err = JSON.stringify({
        error: 'Schema reader not configured. Set DB_TYPE and connection env vars in .env',
      });
      logToolCall('get_schema', input, err, 0);
      return { content: [{ type: 'text', text: err }] };
    }

    const [tableSchema, ms] = await withTiming(() => schema.getSchema(input.table));

    if (!tableSchema) {
      const err = JSON.stringify({ error: `Table "${input.table}" not found or DB unreachable` });
      logToolCall('get_schema', input, err, ms);
      return { content: [{ type: 'text', text: err }] };
    }

    const result = JSON.stringify(tableSchema, null, 2);
    logToolCall('get_schema', input, result, ms);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 6: get_dependencies ───────────────────────────────────────────────
server.tool(
  'get_dependencies',
  'Get all symbols defined in a file and their outgoing relationships. ' +
  'Useful for understanding impact before making changes.',
  {
    file_path: z.string().describe('Partial or full path to the file'),
  },
  async (input) => {
    const db = getDb();
    const start = Date.now();

    const file = db
      .prepare('SELECT id FROM files WHERE path LIKE ?')
      .get(`%${input.file_path}%`) as { id: number } | undefined;

    if (!file) {
      const result = JSON.stringify({ error: 'File not found in index. Is it within WATCH_PATHS?' });
      logToolCall('get_dependencies', input, result, Date.now() - start);
      return { content: [{ type: 'text', text: result }] };
    }

    const symbols = db
      .prepare('SELECT id, name, kind, start_line, end_line FROM symbols WHERE file_id = ?')
      .all(file.id) as { id: number; name: string; kind: string; start_line: number; end_line: number }[];

    const outgoing = db
      .prepare(`
        SELECT r.to_name, r.kind, r.to_file
        FROM relationships r
        JOIN symbols s ON r.from_id = s.id
        WHERE s.file_id = ?
        ORDER BY r.kind, r.to_name
      `)
      .all(file.id) as { to_name: string; kind: string; to_file: string | null }[];

    const result = JSON.stringify({ symbols, outgoing_relationships: outgoing }, null, 2);
    logToolCall('get_dependencies', input, result, Date.now() - start);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 7: get_session_report ─────────────────────────────────────────────
server.tool(
  'get_session_report',
  'Get a report for the current session — tool calls, files touched, compactions, estimated token savings.',
  {},
  async () => {
    const db = getDb();
    const start = Date.now();

    const sess = db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(session.getSessionId()) as {
        id: string;
        compaction_count: number;
        started_at: number;
      };

    const toolCalls = db
      .prepare(`
        SELECT tool_name, COUNT(*) AS count,
               SUM(tokens_returned) AS total_tokens,
               AVG(duration_ms) AS avg_duration_ms
        FROM tool_usage
        WHERE session_id = ?
        GROUP BY tool_name
        ORDER BY count DESC
      `)
      .all(session.getSessionId()) as {
        tool_name: string;
        count: number;
        total_tokens: number;
        avg_duration_ms: number;
      }[];

    const touchedCount = db
      .prepare('SELECT COUNT(DISTINCT path) AS count FROM touched_files WHERE session_id = ?')
      .get(session.getSessionId()) as { count: number };

    const totalTokensReturned = toolCalls.reduce(
      (sum, t) => sum + (t.total_tokens ?? 0), 0
    );

    const report = {
      session_id:           sess.id,
      uptime_minutes:       Math.round(session.getUptimeSeconds() / 60),
      compactions_survived: sess.compaction_count,
      files_touched:        touchedCount.count,
      tool_calls:           toolCalls,
      total_tokens_returned: totalTokensReturned,
    };

    const result = JSON.stringify(report, null, 2);
    logToolCall('get_session_report', {}, result, Date.now() - start);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 8: search_symbols ─────────────────────────────────────────────────
// @ts-ignore
server.tool(
  'search_symbols',
  'Full-text search across all indexed symbols (classes, functions, methods, etc.) ' +
  'in the entire codebase. Returns matching symbols with file locations.',
  {
    query:  z.string().describe('Symbol name or partial name to search for'),
    kind:   z.enum(['class', 'function', 'method', 'interface', 'enum', 'struct', 'trait', 'module', 'property', 'constructor', 'type', 'any'])
              .optional()
              .default('any')
              .describe('Filter by symbol kind (default: any)'),
    limit:  z.number().int().min(1).max(100).optional().default(30).describe('Max results'),
  },
  async (input) => {
    const start = Date.now();
    let results = knowledge.searchSymbols(input.query, input.limit);

    if (input.kind && input.kind !== 'any') {
      results = results.filter((r) => r.kind === input.kind);
    }

    const result = JSON.stringify({ count: results.length, results }, null, 2);
    logToolCall('search_symbols', input, result, Date.now() - start);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 9: get_file_symbols ───────────────────────────────────────────────
server.tool(
  'get_file_symbols',
  'Get all symbols defined in a specific file, grouped by kind (class, function, method, etc.). ' +
  'Accepts a partial path — e.g. "AuthService" matches "src/auth/AuthService.ts".',
  {
    file_path: z.string().describe('Partial or full path to the file'),
  },
  async (input) => {
    const start = Date.now();
    const summary = knowledge.getFileSummary(input.file_path);

    if (!summary) {
      const result = JSON.stringify({ error: `File not found in index: "${input.file_path}". Check WATCH_PATHS or run reindex.` });
      logToolCall('get_file_symbols', input, result, Date.now() - start);
      return { content: [{ type: 'text', text: result }] };
    }

    const result = JSON.stringify(summary, null, 2);
    logToolCall('get_file_symbols', input, result, Date.now() - start);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 10: reindex ───────────────────────────────────────────────────────
server.tool(
  'reindex',
  'Force re-parse one file or all watched files, ignoring cached hashes. ' +
  'Use when symbols are missing or stale after a large refactor. ' +
  'Omit file_path to reindex everything (may take a few seconds for large codebases).',
  {
    file_path: z.string().optional().describe('Specific file to reindex. Omit to reindex all files.'),
  },
  async (input) => {
    const start = Date.now();
    const count = await watcher.reindex(input.file_path);
    const result = JSON.stringify({
      queued: count,
      message: input.file_path
        ? `Reindexed: ${input.file_path}`
        : `${count} files queued for reindexing`,
    });
    logToolCall('reindex', input, result, Date.now() - start);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 11: list_languages ─────────────────────────────────────────────────
server.tool(
  'list_languages',
  'List all programming languages that Continuum supports, with file and symbol counts ' +
  'for indexed files in the current project.',
  {},
  async () => {
    const start = Date.now();
    const breakdown = knowledge.getLanguageBreakdown();
    const stats = knowledge.getProjectStats();

    const result = JSON.stringify(
      {
        total_files:   stats.total_files,
        total_symbols: stats.total_symbols,
        last_indexed:  stats.last_indexed,
        languages:     breakdown,
      },
      null,
      2
    );
    logToolCall('list_languages', {}, result, Date.now() - start);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 12: get_recent_sessions ──────────────────────────────────────────
server.tool(
  'get_recent_sessions',
  'List recent sessions (excluding current) with goals, compaction counts, and file activity. ' +
  'Useful for resuming work from a previous day or recovering context across server restarts.',
  {
    limit: z.number().int().min(1).max(20).optional().default(5).describe('Number of past sessions to return'),
  },
  async (input) => {
    const start = Date.now();
    const sessions = session.getRecentSessions(input.limit);
    const result = JSON.stringify({ count: sessions.length, sessions }, null, 2);
    logToolCall('get_recent_sessions', input, result, Date.now() - start);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 13: health_check ──────────────────────────────────────────────────
server.tool(
  'health_check',
  'Check Continuum server health — uptime, database status, indexed file count, active session.',
  {},
  async () => {
    const start = Date.now();
    const db = getDb();

    const fileCount = (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
    const symbolCount = (db.prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number }).n;

    const meta = db
      .prepare("SELECT key, value FROM metadata WHERE key IN ('version', 'boot_count', 'first_started')")
      .all() as { key: string; value: string }[];
    const metaMap = Object.fromEntries(meta.map((m) => [m.key, m.value]));

    const health = {
      status:          'ok',
      version:         metaMap['version'] ?? '1.0.0',
      uptime_s:        session.getUptimeSeconds(),
      session_id:      session.getSessionId(),
      resumed:         session.isResumed(),
      boot_count:      Number(metaMap['boot_count'] ?? 1),
      db_status:       'connected',
      project_root:    projectRoot,
      watch_paths:     watchPaths,
      auto_detected:   !process.env.WATCH_PATHS,
      indexed_files:   fileCount,
      indexed_symbols: symbolCount,
      schema_reader:   schema.isEnabled() ? process.env.DB_TYPE : 'disabled',
    };

    const result = JSON.stringify(health, null, 2);
    logToolCall('health_check', {}, result, Date.now() - start);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 14: smart_search ─────────────────────────────────────────────────
// @ts-ignore
server.tool(
  'smart_search',
  'Search everything at once — symbols, session tasks, and touched files — with one query. ' +
  'Use this as your first lookup before calling more targeted tools like search_symbols.',
  {
    query: z.string().describe('What to search for — function name, feature, concept, or file path fragment'),
    limit: z.number().int().min(1).max(50).optional().default(20).describe('Max symbol results'),
  },
  async (input) => {
    const start = Date.now();

    const [symbols, taskMatches, fileMatches] = await Promise.all([
      Promise.resolve(knowledge.searchSymbols(input.query, input.limit)),
      Promise.resolve(session.searchTasks(input.query)),
      Promise.resolve(session.searchTouchedFiles(input.query)),
    ]);

    const result = JSON.stringify({
      query: input.query,
      symbols:        { count: symbols.length,    results: symbols },
      relevant_tasks: { count: taskMatches.length, results: taskMatches },
      touched_files:  { count: fileMatches.length, results: fileMatches },
    }, null, 2);

    logToolCall('smart_search', input, result, Date.now() - start);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 15: enrich_context ───────────────────────────────────────────────
server.tool(
  'enrich_context',
  'Get the full picture for a file before editing it — symbols defined inside it, ' +
  'other files that import it, and recent session activity. ' +
  'Reduces the need to read the file from scratch.',
  {
    file_path: z.string().describe('Partial or full path of the file to enrich'),
  },
  async (input) => {
    const start = Date.now();
    const db = getDb();

    const symbols = knowledge.getFileSummary(input.file_path);

    const importedBy = db.prepare(`
      SELECT DISTINCT f.path, f.language
      FROM relationships r
      JOIN symbols s ON r.from_id = s.id
      JOIN files f ON s.file_id = f.id
      WHERE r.to_file LIKE ? AND r.kind = 'imports'
      LIMIT 20
    `).all(`%${input.file_path.replace(/\.[^.]+$/, '')}%`) as { path: string; language: string }[];

    const recentActivity = db.prepare(`
      SELECT action, MAX(touched_at) AS touched_at FROM touched_files
      WHERE session_id = ? AND path LIKE ?
      ORDER BY touched_at DESC LIMIT 5
    `).all(session.getSessionId(), `%${input.file_path}%`) as { action: string; touched_at: number }[];

    const result = JSON.stringify({
      file:            input.file_path,
      symbols:         symbols ?? null,
      imported_by:     importedBy,
      recent_activity: recentActivity,
    }, null, 2);

    logToolCall('enrich_context', input, result, Date.now() - start);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 16: list_tables ──────────────────────────────────────────────────
server.tool(
  'list_tables',
  'List all tables available in the connected external database. ' +
  'Use before get_schema to discover table names without guessing.',
  {},
  async () => {
    const start = Date.now();

    if (!schema.isEnabled()) {
      const result = JSON.stringify({ error: 'Schema reader not configured. Set DB_TYPE and connection env vars.' });
      logToolCall('list_tables', {}, result, 0);
      return { content: [{ type: 'text', text: result }] };
    }

    const tables = await schema.listTables();
    const result = JSON.stringify({ count: tables.length, tables }, null, 2);
    logToolCall('list_tables', {}, result, Date.now() - start);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Start ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ sessionId: session.getSessionId() }, 'Continuum MCP server v1.0.0 running');
}

main().catch((err) => {
  logger.error({ err }, 'Server failed to start');
  process.exit(1);
});

// ── Graceful Shutdown ──────────────────────────────────────────────────────

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down gracefully');
  try { session.consolidateSession(); } catch { /* non-critical */ }
  watcher.stop();
  closeDb();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  watcher.stop();
  closeDb();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
  watcher.stop();
  closeDb();
  process.exit(1);
});
