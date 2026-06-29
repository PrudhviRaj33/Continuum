import { Pool } from 'pg';
import { ISchemaAdapter, TableSchema } from './ISchemaAdapter';
import { logger } from '../utils/logger';

const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || '',
  user:     process.env.PG_USER     || '',
  password: process.env.PG_PASSWORD || '',
  max:      5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
});

export class PostgresAdapter implements ISchemaAdapter {
  async getSchema(tableName: string): Promise<TableSchema | null> {
    const client = await pool.connect();
    try {
      const colsRes = await client.query(
        `
        SELECT
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.character_maximum_length            AS max_length,
          (tc.constraint_type = 'PRIMARY KEY')  AS is_primary_key,
          ccu.table_name                        AS foreign_key_table,
          ccu.column_name                       AS foreign_key_column
        FROM information_schema.columns c
        LEFT JOIN information_schema.key_column_usage kcu
          ON c.table_name = kcu.table_name AND c.column_name = kcu.column_name
        LEFT JOIN information_schema.table_constraints tc
          ON kcu.constraint_name = tc.constraint_name
        LEFT JOIN information_schema.referential_constraints rc
          ON kcu.constraint_name = rc.constraint_name
        LEFT JOIN information_schema.constraint_column_usage ccu
          ON rc.unique_constraint_name = ccu.constraint_name
        WHERE c.table_name = $1
        ORDER BY c.ordinal_position
        `,
        [tableName]
      );

      if (colsRes.rows.length === 0) return null;

      const idxRes = await client.query(
        `SELECT indexname AS index_name FROM pg_indexes WHERE tablename = $1`,
        [tableName]
      );

      return {
        table_name: tableName,
        columns: colsRes.rows,
        indexes: idxRes.rows.map((r: { index_name: string }) => r.index_name),
      };
    } catch (err) {
      logger.error({ err, tableName }, 'Postgres getSchema failed');
      return null;
    } finally {
      client.release();
    }
  }

  async listTables(): Promise<string[]> {
    const client = await pool.connect();
    try {
      const res = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      return res.rows.map((r: { table_name: string }) => r.table_name);
    } catch (err) {
      logger.error({ err }, 'Postgres listTables failed');
      return [];
    } finally {
      client.release();
    }
  }
}
