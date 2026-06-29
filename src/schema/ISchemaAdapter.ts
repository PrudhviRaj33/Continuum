export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  max_length: number | null;
  is_primary_key: boolean;
  foreign_key_table?: string;
  foreign_key_column?: string;
}

export interface TableSchema {
  table_name: string;
  columns: ColumnInfo[];
  indexes: string[];
}

/** Strategy interface — each database adapter implements this. */
export interface ISchemaAdapter {
  getSchema(tableName: string): Promise<TableSchema | null>;
  listTables(): Promise<string[]>;
}
