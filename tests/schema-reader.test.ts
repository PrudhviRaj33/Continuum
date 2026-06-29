import { describe, it, expect } from 'vitest';
import { SchemaReader } from '../src/schema/SchemaReader';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

process.env.DB_PATH = path.join(os.tmpdir(), `continuum-schema-test-${crypto.randomUUID()}.db`);
process.env.LOG_LEVEL = 'error';

describe('SchemaReader', () => {
  it('is disabled when DB_TYPE is not set', () => {
    delete process.env.DB_TYPE;
    const reader = new SchemaReader();
    expect(reader.isEnabled()).toBe(false);
  });

  it('returns null for getSchema when disabled', async () => {
    delete process.env.DB_TYPE;
    const reader = new SchemaReader();
    const result = await reader.getSchema('users');
    expect(result).toBeNull();
  });

  it('returns empty array for listTables when disabled', async () => {
    delete process.env.DB_TYPE;
    const reader = new SchemaReader();
    const result = await reader.listTables();
    expect(result).toEqual([]);
  });

  it('handles unknown DB_TYPE gracefully', () => {
    process.env.DB_TYPE = 'oracle'; // not supported
    expect(() => new SchemaReader()).not.toThrow();
    delete process.env.DB_TYPE;
  });
});
