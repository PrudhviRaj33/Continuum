import { getDb } from '../database/Database';
import { ISchemaAdapter, TableSchema } from './ISchemaAdapter';
import { logger } from '../utils/logger';

const CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * DB-agnostic Schema Reader (Strategy pattern).
 *
 * Wraps any ISchemaAdapter (MSSQL | Postgres | MySQL) with a SQLite cache
 * so repeated tool calls don't hammer the database.
 *
 * Select adapter via DB_TYPE env var: 'mssql' | 'postgres' | 'mysql'
 */
export class SchemaReader {
  private adapter: ISchemaAdapter | null = null;

  constructor() {
    const dbType = process.env.DB_TYPE?.toLowerCase();
    if (!dbType) {
      logger.info('No DB_TYPE set - get_schema tool will be disabled');
      return;
    }

    // Lazy-require adapters so unused DB drivers don't crash on import
    try {
      if (dbType === 'mssql') {
        const { MssqlAdapter } = require('./MssqlAdapter') as typeof import('./MssqlAdapter');
        this.adapter = new MssqlAdapter();
      } else if (dbType === 'postgres' || dbType === 'postgresql') {
        const { PostgresAdapter } = require('./PostgresAdapter') as typeof import('./PostgresAdapter');
        this.adapter = new PostgresAdapter();
      } else if (dbType === 'mysql') {
        const { MySqlAdapter } = require('./MySqlAdapter') as typeof import('./MySqlAdapter');
        this.adapter = new MySqlAdapter();
      } else {
        logger.warn({ dbType }, 'Unknown DB_TYPE - supported: mssql | postgres | mysql');
      }
    } catch (err) {
      logger.error({ err, dbType }, 'Failed to initialise schema adapter');
    }
  }

  isEnabled(): boolean {
    return this.adapter !== null;
  }

  async getSchema(tableName: string): Promise<TableSchema | null> {
    if (!this.adapter) return null;

    const db = getDb();

    // Serve from cache if fresh
    const cached = db
      .prepare(
        `SELECT schema_json, cached_at FROM schema_cache
         WHERE table_name = ? AND cached_at > unixepoch() - ?`
      )
      .get(tableName, CACHE_TTL_SECONDS) as
      | { schema_json: string; cached_at: number }
      | undefined;

    if (cached) {
      logger.debug({ tableName }, 'Schema cache hit');
      return JSON.parse(cached.schema_json) as TableSchema;
    }

    const tableSchema = await this.adapter.getSchema(tableName);
    if (!tableSchema) return null;

    // Cache it
    db.prepare(`
      INSERT INTO schema_cache (table_name, schema_json, cached_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(table_name) DO UPDATE SET
        schema_json = excluded.schema_json,
        cached_at   = excluded.cached_at
    `).run(tableName, JSON.stringify(tableSchema));

    logger.info({ tableName }, 'Schema fetched and cached');
    return tableSchema;
  }

  async listTables(): Promise<string[]> {
    if (!this.adapter) return [];
    return this.adapter.listTables();
  }
}
