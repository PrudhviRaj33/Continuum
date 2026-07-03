import type { LanguageDefinition } from '../LanguageRegistry';

// SQL Server uses [Schema].[ObjectName] bracket notation.
// These patterns handle both bare names and bracket-quoted names,
// and accept CREATE, CREATE OR ALTER, and ALTER statements.
const SCHEMA_PREFIX = /(?:\[?\w+\]?\.)?/;
const OBJECT_NAME = /\[?([A-Za-z_]\w*)\]?/;

const definition: LanguageDefinition = {
  name: 'sql',
  displayName: 'SQL',
  extensions: ['.sql'],
  commentPrefixes: ['--', '/*', '*/'],
  rules: [
    // TABLE: CREATE TABLE [Schema].[Name] or CREATE TABLE Name
    {
      kind: 'class',
      pattern: new RegExp(
        `^CREATE\\s+(?:OR\\s+ALTER\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${SCHEMA_PREFIX.source}${OBJECT_NAME.source}`,
        'i'
      ),
    },
    // VIEW: CREATE [OR ALTER] VIEW / ALTER VIEW
    {
      kind: 'interface',
      pattern: new RegExp(
        `^(?:CREATE(?:\\s+OR\\s+ALTER)?|ALTER)\\s+(?:MATERIALIZED\\s+)?VIEW\\s+${SCHEMA_PREFIX.source}${OBJECT_NAME.source}`,
        'i'
      ),
    },
    // PROCEDURE: CREATE [OR ALTER] PROCEDURE / ALTER PROCEDURE
    {
      kind: 'function',
      pattern: new RegExp(
        `^(?:CREATE(?:\\s+OR\\s+ALTER)?|ALTER)\\s+PROCEDURE\\s+${SCHEMA_PREFIX.source}${OBJECT_NAME.source}`,
        'i'
      ),
    },
    // FUNCTION: CREATE [OR ALTER] FUNCTION / ALTER FUNCTION
    {
      kind: 'function',
      pattern: new RegExp(
        `^(?:CREATE(?:\\s+OR\\s+ALTER)?|ALTER)\\s+FUNCTION\\s+${SCHEMA_PREFIX.source}${OBJECT_NAME.source}`,
        'i'
      ),
    },
    // TYPE
    {
      kind: 'type',
      pattern: new RegExp(
        `^CREATE\\s+(?:OR\\s+ALTER\\s+)?TYPE\\s+${SCHEMA_PREFIX.source}${OBJECT_NAME.source}`,
        'i'
      ),
    },
    // SCHEMA
    { kind: 'module', pattern: /^CREATE\s+(?:OR\s+ALTER\s+)?SCHEMA\s+\[?([A-Za-z_]\w*)\]?/i },
    // INDEX
    { kind: 'enum', pattern: /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\[?([A-Za-z_]\w*)\]?/i },
    // TRIGGER
    {
      kind: 'method',
      pattern: new RegExp(
        `^(?:CREATE(?:\\s+OR\\s+ALTER)?|ALTER)\\s+TRIGGER\\s+${SCHEMA_PREFIX.source}${OBJECT_NAME.source}`,
        'i'
      ),
    },
  ],
};

export default definition;
