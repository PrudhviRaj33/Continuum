import mysql from 'mysql2/promise';
import { ISchemaAdapter, TableSchema } from './ISchemaAdapter';
import { logger } from '../utils/logger';

const pool = mysql.createPool({
  host:               process.env.MYSQL_HOST     || 'localhost',
  port:               parseInt(process.env.MYSQL_PORT || '3306'),
  database:           process.env.MYSQL_DATABASE || '',
  user:               process.env.MYSQL_USER     || '',
  password:           process.env.MYSQL_PASSWORD || '',
  waitForConnections: true,
  connectionLimit:    5,
  queueLimit:         0,
  connectTimeout:     8000,
});

export class MySqlAdapter implements ISchemaAdapter {
  async getSchema(tableName: string): Promise<TableSchema | null> {
    const conn = await pool.getConnection();
    try {
      const [cols] = await conn.query<mysql.RowDataPacket[]>(
        `
        SELECT
          c.COLUMN_NAME          AS column_name,
          c.DATA_TYPE            AS data_type,
          c.IS_NULLABLE          AS is_nullable,
          c.CHARACTER_MAXIMUM_LENGTH AS max_length,
          IF(c.COLUMN_KEY = 'PRI', 1, 0) AS is_primary_key,
          kcu.REFERENCED_TABLE_NAME   AS foreign_key_table,
          kcu.REFERENCED_COLUMN_NAME  AS foreign_key_column
        FROM information_schema.COLUMNS c
        LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
          ON c.TABLE_NAME   = kcu.TABLE_NAME
         AND c.COLUMN_NAME  = kcu.COLUMN_NAME
         AND c.TABLE_SCHEMA = kcu.TABLE_SCHEMA
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
        WHERE c.TABLE_NAME   = ?
          AND c.TABLE_SCHEMA = DATABASE()
        ORDER BY c.ORDINAL_POSITION
        `,
        [tableName]
      );

      if ((cols as unknown[]).length === 0) return null;

      const [idxs] = await conn.query<mysql.RowDataPacket[]>(
        `SHOW INDEX FROM \`${tableName}\``,
        []
      );

      const uniqueIndexNames = [...new Set((idxs as mysql.RowDataPacket[]).map((r) => r['Key_name'] as string))];

      return {
        table_name: tableName,
        columns: cols as TableSchema['columns'],
        indexes: uniqueIndexNames,
      };
    } catch (err) {
      logger.error({ err, tableName }, 'MySQL getSchema failed');
      return null;
    } finally {
      conn.release();
    }
  }

  async listTables(): Promise<string[]> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'`
      );
      return (rows as mysql.RowDataPacket[]).map((r) => Object.values(r)[0] as string);
    } catch (err) {
      logger.error({ err }, 'MySQL listTables failed');
      return [];
    } finally {
      conn.release();
    }
  }
}
