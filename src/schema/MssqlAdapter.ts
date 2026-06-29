import * as sql from 'mssql';
import { ISchemaAdapter, TableSchema } from './ISchemaAdapter';
import { logger } from '../utils/logger';

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
  connectionTimeout: 8000,
  requestTimeout: 8000,
  pool: {
    max: 5,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let pool: sql.ConnectionPool | null = null;

async function getPool(): Promise<sql.ConnectionPool> {
  if (!pool || !pool.connected) {
    pool = await new sql.ConnectionPool(config).connect();
    logger.info('MSSQL connection pool established');
  }
  return pool;
}

export class MssqlAdapter implements ISchemaAdapter {
  async getSchema(tableName: string): Promise<TableSchema | null> {
    try {
      const p = await getPool();

      const columnsResult = await p
        .request()
        .input('table', sql.VarChar, tableName)
        .query(`
          SELECT
            c.COLUMN_NAME          AS column_name,
            c.DATA_TYPE            AS data_type,
            c.IS_NULLABLE          AS is_nullable,
            c.CHARACTER_MAXIMUM_LENGTH AS max_length,
            CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key,
            fk_col.TABLE_NAME      AS foreign_key_table,
            fk_col.COLUMN_NAME     AS foreign_key_column
          FROM INFORMATION_SCHEMA.COLUMNS c
          LEFT JOIN (
            SELECT ku.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
              ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_NAME = @table
          ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
          LEFT JOIN (
            SELECT kcu.COLUMN_NAME, ccu.TABLE_NAME, ccu.COLUMN_NAME AS FK_COLUMN
            FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
            JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
              ON rc.UNIQUE_CONSTRAINT_NAME = ccu.CONSTRAINT_NAME
            WHERE kcu.TABLE_NAME = @table
          ) fk_col ON c.COLUMN_NAME = fk_col.COLUMN_NAME
          WHERE c.TABLE_NAME = @table
          ORDER BY c.ORDINAL_POSITION
        `);

      if (columnsResult.recordset.length === 0) return null;

      const indexResult = await p
        .request()
        .input('table', sql.VarChar, tableName)
        .query(`
          SELECT i.name AS index_name
          FROM sys.indexes i
          JOIN sys.tables t ON i.object_id = t.object_id
          WHERE t.name = @table AND i.name IS NOT NULL
        `);

      return {
        table_name: tableName,
        columns: columnsResult.recordset,
        indexes: indexResult.recordset.map((r: { index_name: string }) => r.index_name),
      };
    } catch (err) {
      logger.error({ err, tableName }, 'MSSQL getSchema failed');
      return null;
    }
  }

  async listTables(): Promise<string[]> {
    try {
      const p = await getPool();
      const result = await p.request().query(`
        SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME
      `);
      return result.recordset.map((r: { TABLE_NAME: string }) => r.TABLE_NAME);
    } catch (err) {
      logger.error({ err }, 'MSSQL listTables failed');
      return [];
    }
  }
}
