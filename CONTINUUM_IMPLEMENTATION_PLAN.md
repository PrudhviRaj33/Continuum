# Continuum — Full Implementation Plan

> AI Development Memory Layer for AI Coding Assistants
> Version: 0.1 — Implementation Ready
> Stack: TypeScript · SQLite · Tree-sitter · chokidar · MCP SDK
> Author stack: .NET · Angular · MSSQL

---

## Before You Start — Prerequisites

Install these once on your machine:

```bash
node --version     # must be v18+
npm --version      # must be v9+
git --version      # any recent version
```

Install Tree-sitter CLI globally:

```bash
npm install -g tree-sitter-cli
```

---

## Project Folder Structure

Create this exact structure before writing any code:

```
continuum/
├── src/
│   ├── watcher/
│   │   └── FileWatcher.ts
│   ├── parser/
│   │   └── IncrementalParser.ts
│   ├── knowledge/
│   │   └── KnowledgeEngine.ts
│   ├── database/
│   │   ├── Database.ts
│   │   └── schema.sql
│   ├── session/
│   │   └── SessionEngine.ts
│   ├── mcp/
│   │   └── McpServer.ts
│   ├── schema/
│   │   └── SchemaReader.ts
│   └── utils/
│       └── logger.ts
├── knowledge.db            ← auto-created on first run
├── .env                    ← DB connection string, watch paths
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Step 1 — Scaffold the Project

```bash
mkdir continuum
cd continuum
npm init -y
```

### Install all dependencies

```bash
npm install \
  @modelcontextprotocol/sdk \
  better-sqlite3 \
  chokidar \
  mssql \
  dotenv \
  tree-sitter \
  tree-sitter-typescript \
  tree-sitter-c-sharp

npm install --save-dev \
  typescript \
  @types/node \
  @types/better-sqlite3 \
  @types/mssql \
  tsx
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### package.json scripts section

```json
{
  "scripts": {
    "dev": "tsx src/mcp/McpServer.ts",
    "build": "tsc",
    "start": "node dist/mcp/McpServer.js",
    "setup": "tsx src/database/setup.ts"
  }
}
```

### .env.example

```
# Paths to watch (comma-separated)
WATCH_PATHS=./src,../your-dotnet-project/src,../your-angular-project/src

# MSSQL connection (for get_schema tool)
MSSQL_HOST=localhost
MSSQL_PORT=1433
MSSQL_DATABASE=your_database
MSSQL_USER=your_user
MSSQL_PASSWORD=your_password

# Continuum DB location
DB_PATH=./knowledge.db

# Log level: debug | info | error
LOG_LEVEL=info
```

### .gitignore

```
node_modules/
dist/
knowledge.db
.env
*.db-journal
```

---

## Step 2 — Database Schema

### src/database/schema.sql

```sql
-- Files tracked in the repository
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    NOT NULL UNIQUE,
  language    TEXT,
  last_parsed INTEGER,
  hash        TEXT,
  created_at  INTEGER DEFAULT (unixepoch()),
  updated_at  INTEGER DEFAULT (unixepoch())
);

-- Symbols extracted by Tree-sitter (classes, methods, interfaces, functions)
CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL, -- class | method | interface | function | enum
  start_line  INTEGER,
  end_line    INTEGER,
  signature   TEXT,
  created_at  INTEGER DEFAULT (unixepoch())
);

-- Relationships between symbols (calls, imports, implements, extends)
CREATE TABLE IF NOT EXISTS relationships (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_name     TEXT    NOT NULL,
  kind        TEXT    NOT NULL, -- calls | imports | implements | extends | uses
  created_at  INTEGER DEFAULT (unixepoch())
);

-- Active sessions
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY, -- uuid
  goal        TEXT,
  started_at  INTEGER DEFAULT (unixepoch()),
  updated_at  INTEGER DEFAULT (unixepoch()),
  compaction_count INTEGER DEFAULT 0
);

-- Files touched in current session
CREATE TABLE IF NOT EXISTS touched_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path        TEXT    NOT NULL,
  action      TEXT    NOT NULL, -- opened | modified | created | deleted
  touched_at  INTEGER DEFAULT (unixepoch())
);

-- Task state snapshots (goal, decisions, next steps)
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  goal        TEXT,
  decisions   TEXT,   -- JSON array of strings
  next_steps  TEXT,   -- JSON array of strings
  open_questions TEXT, -- JSON array of strings
  saved_at    INTEGER DEFAULT (unixepoch())
);

-- Feature-to-file mapping
CREATE TABLE IF NOT EXISTS features (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  layer       TEXT    NOT NULL, -- controller | service | repository | ui | test | db
  file_path   TEXT    NOT NULL,
  description TEXT,
  created_at  INTEGER DEFAULT (unixepoch())
);

-- Live MSSQL schema cache
CREATE TABLE IF NOT EXISTS schema_cache (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name  TEXT    NOT NULL UNIQUE,
  schema_json TEXT    NOT NULL, -- full columns/types/FK as JSON
  cached_at   INTEGER DEFAULT (unixepoch())
);

-- Every MCP tool call logged for observability
CREATE TABLE IF NOT EXISTS tool_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  tool_name   TEXT    NOT NULL,
  input_json  TEXT,
  tokens_returned INTEGER,
  duration_ms INTEGER,
  called_at   INTEGER DEFAULT (unixepoch())
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_symbols_file    ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name    ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_touched_session ON touched_files(session_id);
CREATE INDEX IF NOT EXISTS idx_features_name   ON features(name);
CREATE INDEX IF NOT EXISTS idx_tool_session    ON tool_usage(session_id);
```

### src/database/Database.ts

```typescript
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DB_PATH || './knowledge.db';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    db.exec(schema);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
```

---

## Step 3 — Logger

### src/utils/logger.ts

```typescript
const LEVEL = process.env.LOG_LEVEL || 'info';

const levels = { debug: 0, info: 1, error: 2 };

function log(level: 'debug' | 'info' | 'error', msg: string, data?: unknown) {
  if (levels[level] >= levels[LEVEL as keyof typeof levels]) {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
    if (data) console.error(line, JSON.stringify(data));
    else console.error(line);
  }
}

export const logger = {
  debug: (msg: string, data?: unknown) => log('debug', msg, data),
  info:  (msg: string, data?: unknown) => log('info',  msg, data),
  error: (msg: string, data?: unknown) => log('error', msg, data),
};
```

> Note: Use `console.error` not `console.log` — stdout is reserved for MCP
> protocol messages. Logging to stdout breaks the MCP connection.

---

## Step 4 — Session Engine

### src/session/SessionEngine.ts

```typescript
import { getDb } from '../database/Database';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

export interface TaskState {
  goal: string;
  decisions: string[];
  next_steps: string[];
  open_questions: string[];
}

export interface SessionState {
  session_id: string;
  goal: string | null;
  started_at: number;
  compaction_count: number;
  touched_files: TouchedFile[];
  latest_task: TaskState | null;
}

export interface TouchedFile {
  path: string;
  action: string;
  touched_at: number;
}

export class SessionEngine {
  private currentSessionId: string;

  constructor() {
    this.currentSessionId = this.initSession();
  }

  private initSession(): string {
    const db = getDb();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO sessions (id, started_at, updated_at)
      VALUES (?, unixepoch(), unixepoch())
    `).run(id);
    logger.info(`Session started: ${id}`);
    return id;
  }

  getSessionId(): string {
    return this.currentSessionId;
  }

  // Called automatically by FileWatcher on every file change
  recordFileTouch(filePath: string, action: 'modified' | 'created' | 'deleted'): void {
    const db = getDb();
    db.prepare(`
      INSERT INTO touched_files (session_id, path, action, touched_at)
      VALUES (?, ?, ?, unixepoch())
    `).run(this.currentSessionId, filePath, action);

    db.prepare(`
      UPDATE sessions SET updated_at = unixepoch() WHERE id = ?
    `).run(this.currentSessionId);
  }

  // Called by save_task MCP tool
  saveTask(task: TaskState): number {
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO tasks (session_id, goal, decisions, next_steps, open_questions, saved_at)
      VALUES (?, ?, ?, ?, ?, unixepoch())
    `).run(
      this.currentSessionId,
      task.goal,
      JSON.stringify(task.decisions),
      JSON.stringify(task.next_steps),
      JSON.stringify(task.open_questions)
    );

    db.prepare(`
      UPDATE sessions SET goal = ?, updated_at = unixepoch() WHERE id = ?
    `).run(task.goal, this.currentSessionId);

    logger.info(`Task saved for session ${this.currentSessionId}`);
    return result.lastInsertRowid as number;
  }

  // Called by get_session MCP tool — the core recovery tool
  getSession(): SessionState {
    const db = getDb();

    const session = db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `).get(this.currentSessionId) as any;

    const touched = db.prepare(`
      SELECT path, action, touched_at
      FROM touched_files
      WHERE session_id = ?
      ORDER BY touched_at DESC
    `).all(this.currentSessionId) as TouchedFile[];

    const latestTask = db.prepare(`
      SELECT * FROM tasks
      WHERE session_id = ?
      ORDER BY saved_at DESC
      LIMIT 1
    `).get(this.currentSessionId) as any;

    return {
      session_id: session.id,
      goal: session.goal,
      started_at: session.started_at,
      compaction_count: session.compaction_count,
      touched_files: touched,
      latest_task: latestTask ? {
        goal: latestTask.goal,
        decisions: JSON.parse(latestTask.decisions || '[]'),
        next_steps: JSON.parse(latestTask.next_steps || '[]'),
        open_questions: JSON.parse(latestTask.open_questions || '[]'),
      } : null,
    };
  }

  // Called by get_touched_files MCP tool
  getTouchedFiles(): TouchedFile[] {
    const db = getDb();
    return db.prepare(`
      SELECT DISTINCT path, action, MAX(touched_at) as touched_at
      FROM touched_files
      WHERE session_id = ?
      GROUP BY path
      ORDER BY touched_at DESC
    `).all(this.currentSessionId) as TouchedFile[];
  }

  recordCompaction(): void {
    const db = getDb();
    db.prepare(`
      UPDATE sessions
      SET compaction_count = compaction_count + 1, updated_at = unixepoch()
      WHERE id = ?
    `).run(this.currentSessionId);
    logger.info(`Compaction recorded for session ${this.currentSessionId}`);
  }
}
```

---

## Step 5 — File Watcher

### src/watcher/FileWatcher.ts

```typescript
import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'path';
import { SessionEngine } from '../session/SessionEngine';
import { IncrementalParser } from '../parser/IncrementalParser';
import { logger } from '../utils/logger';
import * as dotenv from 'dotenv';

dotenv.config();

const IGNORED_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist/,
  /bin/,
  /obj/,            // .NET build output
  /\.angular/,      // Angular cache
  /coverage/,
  /\.db$/,
  /\.db-journal$/,
];

const WATCHED_EXTENSIONS = [
  '.ts', '.tsx',    // Angular / TypeScript
  '.cs',            // .NET C#
  '.sql',           // SQL scripts
  '.json',          // config files
];

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private session: SessionEngine;
  private parser: IncrementalParser;

  constructor(session: SessionEngine, parser: IncrementalParser) {
    this.session = session;
    this.parser = parser;
  }

  start(watchPaths: string[]): void {
    const resolved = watchPaths.map(p => path.resolve(p));
    logger.info(`Watching paths: ${resolved.join(', ')}`);

    this.watcher = chokidar.watch(resolved, {
      ignored: IGNORED_PATTERNS,
      persistent: true,
      ignoreInitial: false,    // index existing files on startup
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    this.watcher
      .on('add',    (filePath) => this.handleChange(filePath, 'created'))
      .on('change', (filePath) => this.handleChange(filePath, 'modified'))
      .on('unlink', (filePath) => this.handleChange(filePath, 'deleted'))
      .on('error',  (error)    => logger.error('Watcher error', error))
      .on('ready',  ()         => logger.info('Initial scan complete'));
  }

  private handleChange(filePath: string, action: 'modified' | 'created' | 'deleted'): void {
    const ext = path.extname(filePath);
    if (!WATCHED_EXTENSIONS.includes(ext)) return;

    logger.debug(`File ${action}: ${filePath}`);

    // Track in session
    this.session.recordFileTouch(filePath, action);

    // Trigger incremental parse (skip deleted files)
    if (action !== 'deleted') {
      this.parser.parseFile(filePath).catch(err =>
        logger.error(`Parse failed: ${filePath}`, err)
      );
    }
  }

  stop(): void {
    this.watcher?.close();
    logger.info('Watcher stopped');
  }
}
```

---

## Step 6 — Incremental Parser

### src/parser/IncrementalParser.ts

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDb } from '../database/Database';
import { logger } from '../utils/logger';

// Tree-sitter is loaded dynamically to handle optional grammars gracefully
let Parser: any;
let TypeScript: any;
let CSharp: any;

async function loadParsers() {
  try {
    Parser = require('tree-sitter');
    TypeScript = require('tree-sitter-typescript').typescript;
    CSharp = require('tree-sitter-c-sharp');
  } catch (e) {
    logger.error('Tree-sitter grammars not found. Run: npm install tree-sitter tree-sitter-typescript tree-sitter-c-sharp');
  }
}

loadParsers();

const LANGUAGE_MAP: Record<string, string> = {
  '.ts':  'typescript',
  '.tsx': 'typescript',
  '.cs':  'csharp',
};

export class IncrementalParser {

  async parseFile(filePath: string): Promise<void> {
    const ext = path.extname(filePath);
    const language = LANGUAGE_MAP[ext];
    if (!language || !Parser) return;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const hash = crypto.createHash('md5').update(content).digest('hex');

      const db = getDb();

      // Skip if file hasn't changed
      const existing = db.prepare(
        'SELECT hash FROM files WHERE path = ?'
      ).get(filePath) as any;

      if (existing?.hash === hash) {
        logger.debug(`Skipped (unchanged): ${filePath}`);
        return;
      }

      // Upsert file record
      const fileResult = db.prepare(`
        INSERT INTO files (path, language, last_parsed, hash, updated_at)
        VALUES (?, ?, unixepoch(), ?, unixepoch())
        ON CONFLICT(path) DO UPDATE SET
          language = excluded.language,
          last_parsed = excluded.last_parsed,
          hash = excluded.hash,
          updated_at = excluded.updated_at
      `).run(filePath, language, hash);

      const fileId = fileResult.lastInsertRowid as number ||
        (db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as any).id;

      // Clear old symbols for this file
      db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);

      // Parse with Tree-sitter
      const parser = new Parser();
      if (language === 'typescript') parser.setLanguage(TypeScript);
      if (language === 'csharp') parser.setLanguage(CSharp);

      const tree = parser.parse(content);
      const symbols = this.extractSymbols(tree.rootNode, content, language);

      // Insert new symbols
      const insertSymbol = db.prepare(`
        INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const insertMany = db.transaction((syms: any[]) => {
        for (const s of syms) {
          insertSymbol.run(fileId, s.name, s.kind, s.startLine, s.endLine, s.signature);
        }
      });

      insertMany(symbols);
      logger.debug(`Parsed ${symbols.length} symbols from ${filePath}`);

    } catch (err) {
      logger.error(`Failed to parse ${filePath}`, err);
    }
  }

  private extractSymbols(node: any, source: string, language: string): any[] {
    const symbols: any[] = [];
    this.walkNode(node, source, language, symbols);
    return symbols;
  }

  private walkNode(node: any, source: string, language: string, symbols: any[]): void {
    const typeMap: Record<string, string> = {
      // TypeScript
      'class_declaration':           'class',
      'method_definition':           'method',
      'function_declaration':        'function',
      'interface_declaration':       'interface',
      'enum_declaration':            'enum',
      'export_statement':            'export',
      // C#
      'class_declaration':           'class',
      'method_declaration':          'method',
      'interface_declaration':       'interface',
      'enum_declaration':            'enum',
      'constructor_declaration':     'constructor',
      'property_declaration':        'property',
    };

    const kind = typeMap[node.type];
    if (kind) {
      const nameNode = node.childForFieldName?.('name') || 
                       node.children?.find((c: any) => c.type === 'identifier');
      if (nameNode) {
        const startLine = node.startPosition.row + 1;
        const endLine   = node.endPosition.row + 1;
        const signature = source
          .slice(node.startIndex, Math.min(node.startIndex + 120, node.endIndex))
          .split('\n')[0]
          .trim();

        symbols.push({ name: nameNode.text, kind, startLine, endLine, signature });
      }
    }

    for (const child of node.children || []) {
      this.walkNode(child, source, language, symbols);
    }
  }
}
```

---

## Step 7 — Schema Reader (MSSQL)

### src/schema/SchemaReader.ts

```typescript
import * as sql from 'mssql';
import { getDb } from '../database/Database';
import { logger } from '../utils/logger';
import * as dotenv from 'dotenv';

dotenv.config();

const config: sql.config = {
  server:   process.env.MSSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MSSQL_PORT || '1433'),
  database: process.env.MSSQL_DATABASE || '',
  user:     process.env.MSSQL_USER     || '',
  password: process.env.MSSQL_PASSWORD || '',
  options: {
    trustServerCertificate: true,
    encrypt: false,
  },
  connectionTimeout: 5000,
  requestTimeout: 5000,
};

export interface ColumnInfo {
  column_name:  string;
  data_type:    string;
  is_nullable:  string;
  max_length:   number | null;
  is_primary_key: boolean;
  foreign_key_table?: string;
  foreign_key_column?: string;
}

export interface TableSchema {
  table_name: string;
  columns:    ColumnInfo[];
  indexes:    string[];
}

export class SchemaReader {

  async getSchema(tableName: string): Promise<TableSchema | null> {
    const db = getDb();

    // Return from cache if fresh (< 1 hour old)
    const cached = db.prepare(`
      SELECT schema_json, cached_at FROM schema_cache
      WHERE table_name = ? AND cached_at > unixepoch() - 3600
    `).get(tableName) as any;

    if (cached) {
      logger.debug(`Schema cache hit for ${tableName}`);
      return JSON.parse(cached.schema_json);
    }

    // Fetch live from MSSQL
    try {
      const pool = await sql.connect(config);

      const columnsResult = await pool.request()
        .input('table', sql.VarChar, tableName)
        .query(`
          SELECT
            c.COLUMN_NAME        as column_name,
            c.DATA_TYPE          as data_type,
            c.IS_NULLABLE        as is_nullable,
            c.CHARACTER_MAXIMUM_LENGTH as max_length,
            CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END as is_primary_key,
            fk_col.TABLE_NAME    as foreign_key_table,
            fk_col.COLUMN_NAME   as foreign_key_column
          FROM INFORMATION_SCHEMA.COLUMNS c
          LEFT JOIN (
            SELECT ku.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
              ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
              AND tc.TABLE_NAME = @table
          ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
          LEFT JOIN (
            SELECT
              kcu.COLUMN_NAME,
              ccu.TABLE_NAME,
              ccu.COLUMN_NAME as FK_COLUMN
            FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
              ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
            JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
              ON rc.UNIQUE_CONSTRAINT_NAME = ccu.CONSTRAINT_NAME
            WHERE kcu.TABLE_NAME = @table
          ) fk_col ON c.COLUMN_NAME = fk_col.COLUMN_NAME
          WHERE c.TABLE_NAME = @table
          ORDER BY c.ORDINAL_POSITION
        `);

      const indexResult = await pool.request()
        .input('table', sql.VarChar, tableName)
        .query(`
          SELECT i.name as index_name
          FROM sys.indexes i
          JOIN sys.tables t ON i.object_id = t.object_id
          WHERE t.name = @table AND i.name IS NOT NULL
        `);

      await pool.close();

      const schema: TableSchema = {
        table_name: tableName,
        columns:    columnsResult.recordset,
        indexes:    indexResult.recordset.map((r: any) => r.index_name),
      };

      // Cache it
      db.prepare(`
        INSERT INTO schema_cache (table_name, schema_json, cached_at)
        VALUES (?, ?, unixepoch())
        ON CONFLICT(table_name) DO UPDATE SET
          schema_json = excluded.schema_json,
          cached_at   = excluded.cached_at
      `).run(tableName, JSON.stringify(schema));

      logger.info(`Schema fetched and cached for ${tableName}`);
      return schema;

    } catch (err) {
      logger.error(`Failed to fetch schema for ${tableName}`, err);
      return null;
    }
  }

  async listTables(): Promise<string[]> {
    try {
      const pool = await sql.connect(config);
      const result = await pool.request().query(`
        SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME
      `);
      await pool.close();
      return result.recordset.map((r: any) => r.TABLE_NAME);
    } catch (err) {
      logger.error('Failed to list tables', err);
      return [];
    }
  }
}
```

---

## Step 8 — MCP Server (all tools wired)

### src/mcp/McpServer.ts

```typescript
import { McpServer as MCP } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dotenv from 'dotenv';

import { SessionEngine } from '../session/SessionEngine';
import { FileWatcher }   from '../watcher/FileWatcher';
import { IncrementalParser } from '../parser/IncrementalParser';
import { SchemaReader }  from '../schema/SchemaReader';
import { getDb }         from '../database/Database';
import { logger }        from '../utils/logger';

dotenv.config();

// ── Bootstrap ──────────────────────────────────────────────────────────────

const session = new SessionEngine();
const parser  = new IncrementalParser();
const watcher = new FileWatcher(session, parser);
const schema  = new SchemaReader();

const watchPaths = (process.env.WATCH_PATHS || './src').split(',').map(p => p.trim());
watcher.start(watchPaths);

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new MCP({
  name: 'continuum',
  version: '0.1.0',
});

// Helper: log every tool call
function logToolCall(toolName: string, input: unknown, result: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO tool_usage (session_id, tool_name, input_json, tokens_returned, called_at)
    VALUES (?, ?, ?, ?, unixepoch())
  `).run(session.getSessionId(), toolName, JSON.stringify(input), result.length);
}

// ── Tool 1: get_session ────────────────────────────────────────────────────
// Core recovery tool. Claude calls this after every compaction.

server.tool(
  'get_session',
  'Get current session state — goal, touched files, task decisions, next steps. Call this after context compaction to resume work.',
  {},
  async () => {
    const state = session.getSession();
    const result = JSON.stringify(state, null, 2);
    logToolCall('get_session', {}, result);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 2: save_task ──────────────────────────────────────────────────────
// Claude saves structured task state before context fills.

server.tool(
  'save_task',
  'Save current task state — goal, decisions made, next steps, open questions. Call this proactively when context is ~60% full.',
  {
    goal:           z.string().describe('What you are currently trying to accomplish'),
    decisions:      z.array(z.string()).describe('Decisions already made in this session'),
    next_steps:     z.array(z.string()).describe('Concrete next steps remaining'),
    open_questions: z.array(z.string()).optional().describe('Unresolved questions'),
  },
  async (input) => {
    const id = session.saveTask({
      goal:           input.goal,
      decisions:      input.decisions,
      next_steps:     input.next_steps,
      open_questions: input.open_questions || [],
    });
    const result = JSON.stringify({ saved: true, task_id: id });
    logToolCall('save_task', input, result);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 3: get_touched_files ──────────────────────────────────────────────
// Quick check before reading any file — has Claude already seen this?

server.tool(
  'get_touched_files',
  'Get all files modified or opened in this session. Check this before reading a file to avoid re-reading something already processed.',
  {},
  async () => {
    const files = session.getTouchedFiles();
    const result = JSON.stringify(files, null, 2);
    logToolCall('get_touched_files', {}, result);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 4: find_related_files ─────────────────────────────────────────────
// Given a symbol or feature name, return related files across all layers.

server.tool(
  'find_related_files',
  'Find all files related to a feature, symbol, or class name. Returns files across controller/service/repository/UI/test layers.',
  {
    query: z.string().describe('Feature name, class name, or symbol to search for'),
  },
  async (input) => {
    const db = getDb();

    const symbols = db.prepare(`
      SELECT s.name, s.kind, s.start_line, s.end_line, f.path, f.language
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.name LIKE ? OR f.path LIKE ?
      LIMIT 30
    `).all(`%${input.query}%`, `%${input.query}%`);

    const features = db.prepare(`
      SELECT name, layer, file_path, description
      FROM features
      WHERE name LIKE ? OR file_path LIKE ?
      LIMIT 10
    `).all(`%${input.query}%`, `%${input.query}%`);

    const result = JSON.stringify({ symbols, features }, null, 2);
    logToolCall('find_related_files', input, result);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 5: get_schema ─────────────────────────────────────────────────────
// Returns live MSSQL schema for any table. Cached for 1 hour.

server.tool(
  'get_schema',
  'Get the live MSSQL schema for a table — columns, types, nullability, primary keys, foreign keys, indexes.',
  {
    table: z.string().describe('Table name, e.g. "Orders", "Users"'),
  },
  async (input) => {
    const tableSchema = await schema.getSchema(input.table);
    if (!tableSchema) {
      const err = JSON.stringify({ error: `Table "${input.table}" not found or DB unreachable` });
      logToolCall('get_schema', input, err);
      return { content: [{ type: 'text', text: err }] };
    }
    const result = JSON.stringify(tableSchema, null, 2);
    logToolCall('get_schema', input, result);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 6: get_dependencies ───────────────────────────────────────────────
// Returns what a file/symbol imports and what imports it.

server.tool(
  'get_dependencies',
  'Get what a file imports and what other files import it. Useful for understanding impact before making changes.',
  {
    file_path: z.string().describe('Relative or absolute path to the file'),
  },
  async (input) => {
    const db = getDb();

    const file = db.prepare(
      'SELECT id FROM files WHERE path LIKE ?'
    ).get(`%${input.file_path}%`) as any;

    if (!file) {
      const result = JSON.stringify({ error: 'File not found in index' });
      logToolCall('get_dependencies', input, result);
      return { content: [{ type: 'text', text: result }] };
    }

    const symbols = db.prepare(
      'SELECT id, name, kind FROM symbols WHERE file_id = ?'
    ).all(file.id) as any[];

    const outgoing = db.prepare(`
      SELECT r.to_name, r.kind
      FROM relationships r
      JOIN symbols s ON r.from_id = s.id
      WHERE s.file_id = ?
    `).all(file.id);

    const result = JSON.stringify({ symbols, outgoing_relationships: outgoing }, null, 2);
    logToolCall('get_dependencies', input, result);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Tool 7: get_session_report ─────────────────────────────────────────────
// Call at end of session to see efficiency metrics.

server.tool(
  'get_session_report',
  'Get a report for the current session — tool calls, files touched, compactions, estimated token savings.',
  {},
  async () => {
    const db = getDb();

    const sess = db.prepare(
      'SELECT * FROM sessions WHERE id = ?'
    ).get(session.getSessionId()) as any;

    const toolCalls = db.prepare(`
      SELECT tool_name, COUNT(*) as count, SUM(tokens_returned) as total_tokens
      FROM tool_usage
      WHERE session_id = ?
      GROUP BY tool_name
    `).all(session.getSessionId());

    const touchedCount = db.prepare(
      'SELECT COUNT(DISTINCT path) as count FROM touched_files WHERE session_id = ?'
    ).get(session.getSessionId()) as any;

    // Rough estimate: each file re-read avoided = ~800 tokens saved
    const getSessionCalls = (toolCalls.find((t: any) => t.tool_name === 'get_session') as any)?.count || 0;
    const estimatedSaved  = getSessionCalls * 5000 + touchedCount.count * 800;

    const report = {
      session_id:          sess.id,
      duration_minutes:    Math.round((Date.now() / 1000 - sess.started_at) / 60),
      compactions_survived: sess.compaction_count,
      files_touched:       touchedCount.count,
      tool_calls:          toolCalls,
      estimated_tokens_saved: estimatedSaved,
    };

    const result = JSON.stringify(report, null, 2);
    logToolCall('get_session_report', {}, result);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ── Start ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Continuum MCP server running');
}

main().catch((err) => {
  logger.error('Server failed to start', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT',  () => { watcher.stop(); process.exit(0); });
process.on('SIGTERM', () => { watcher.stop(); process.exit(0); });
```

---

## Step 9 — Wire to Claude Code

### .vscode/mcp.json

Create this file in your **project's** `.vscode/` folder (not inside continuum/):

```json
{
  "mcpServers": {
    "continuum": {
      "command": "node",
      "args": ["${workspaceFolder}/continuum/dist/mcp/McpServer.js"],
      "cwd": "${workspaceFolder}/continuum",
      "env": {
        "WATCH_PATHS": "${workspaceFolder}/src",
        "DB_PATH": "${workspaceFolder}/continuum/knowledge.db"
      }
    }
  }
}
```

For development (no build step needed):

```json
{
  "mcpServers": {
    "continuum": {
      "command": "npx",
      "args": ["tsx", "src/mcp/McpServer.ts"],
      "cwd": "${workspaceFolder}/continuum"
    }
  }
}
```

---

## Step 10 — Claude Code Slash Commands

Create these in your project's `.claude/commands/` folder:

### .claude/commands/resume.md

```
I just resumed after a context compaction or session restart.

Call get_session to recover current task state.
Call get_touched_files to see what files were already changed.

Then continue the task from where it was left off — do not ask me to re-explain.
```

### .claude/commands/checkpoint.md

```
Save current task state before context fills.

Call save_task with:
- goal: what we are currently building
- decisions: every architectural or implementation decision made so far
- next_steps: the next 2-3 concrete implementation steps remaining
- open_questions: anything unresolved that needs a decision

Confirm when saved.
```

### .claude/commands/task.md

```
Starting a new task: $ARGUMENTS

Call find_related_files to find existing code related to this task.
Call get_touched_files to see what was already changed this session.
If the task involves database tables, call get_schema for the relevant tables.

Then plan the implementation.
```

### .claude/commands/report.md

```
Call get_session_report and summarise the session metrics for me.
```

---

## Step 11 — First Run

```bash
# 1. Copy and fill in your environment
cp .env.example .env
# Edit .env with your MSSQL credentials and watch paths

# 2. Build
npm run build

# 3. Test the server starts correctly
npm run dev
# You should see: [INFO] Session started: <uuid>
# You should see: [INFO] Watching paths: ...
# You should see: [INFO] Continuum MCP server running

# 4. Restart VS Code (or reload the window) so Claude Code picks up mcp.json
# Ctrl+Shift+P → "Developer: Reload Window"

# 5. Verify Claude sees the tools
# In Claude Code, type: what tools do you have?
# You should see: get_session, save_task, get_touched_files, find_related_files,
#                 get_schema, get_dependencies, get_session_report
```

---

## Phase 1 Completion Checklist

```
Infrastructure
[ ] npm project created with all dependencies
[ ] tsconfig.json configured
[ ] .env filled with correct values
[ ] SQLite database initialises on first run

Session Engine
[ ] save_task tool saves structured state to SQLite
[ ] get_session tool returns full state after compaction
[ ] get_touched_files returns distinct files from this session

File Watcher
[ ] chokidar watches configured paths
[ ] .NET .cs files tracked on change
[ ] Angular .ts files tracked on change
[ ] Deleted files recorded correctly
[ ] Build output folders ignored

Parser
[ ] Tree-sitter parses .ts files without crashing
[ ] Tree-sitter parses .cs files without crashing
[ ] Unchanged files skipped via hash check
[ ] Symbols written to SQLite

Schema Reader
[ ] get_schema connects to MSSQL
[ ] Returns columns, types, nullability, PKs, FKs
[ ] Caches result for 1 hour
[ ] Returns clean error if table not found

MCP Server
[ ] All 7 tools registered
[ ] Server starts via stdio transport
[ ] Claude Code sees tools in .vscode/mcp.json
[ ] Every tool call logged to tool_usage table

Slash Commands
[ ] /resume — recovers session after compaction
[ ] /checkpoint — saves task state
[ ] /task — starts a task with context loaded
[ ] /report — shows session metrics

Validation
[ ] Start a task, make changes to 3+ files
[ ] Call /checkpoint to save state
[ ] Manually compact (clear chat) or wait for auto-compact
[ ] Call /resume — Claude resumes without re-explaining
[ ] Call /report — metrics show correctly
```

---

## Phase 2 Preview — Repository Knowledge

After Phase 1 is stable, the next additions are:

- Relationship extraction from Tree-sitter (what calls what)
- `get_feature_context` tool — given a feature name, returns all files across
  controller / service / repository / DTO / test layers automatically
- `find_similar_changes` — finds historical commits that touched similar files

These build on top of the same SQLite database and MCP server — no new infrastructure.

---

## Troubleshooting

**Claude Code doesn't see the tools**
Reload VS Code window after editing mcp.json. Check the server starts without errors (`npm run dev`).

**MSSQL connection fails**
Set `LOG_LEVEL=debug` in .env and check the error. Ensure `trustServerCertificate=true` for local SQL Server.

**Tree-sitter parse errors**
Some C# syntax (records, primary constructors) may not parse with older grammars. Update: `npm install tree-sitter-c-sharp@latest`.

**File watcher misses changes on Windows**
Add `usePolling: true` to the chokidar options in FileWatcher.ts if events are missed.

**MCP server crashes on startup**
Check that `console.log` is not used anywhere — it breaks the stdio MCP transport. Use `console.error` or the logger utility.

---

*Continuum v0.1 — Phase 1 Implementation*
*Model-agnostic · Offline · No cloud dependencies*
