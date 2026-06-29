import { registerLanguage } from '../LanguageRegistry';

registerLanguage({
  name: 'sql',
  displayName: 'SQL',
  extensions: ['.sql'],
  commentPrefixes: ['--', '/*', '*/'],
  rules: [
    {
      kind: 'class', // TABLE
      pattern: /^CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?([A-Za-z_][A-Za-z0-9_]*)/i,
    },
    {
      kind: 'interface', // VIEW
      pattern: /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:\w+\.)?([A-Za-z_][A-Za-z0-9_]*)/i,
    },
    {
      kind: 'function', // PROCEDURE / FUNCTION
      pattern:
        /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION)\s+(?:\w+\.)?([A-Za-z_][A-Za-z0-9_]*)/i,
    },
    {
      kind: 'type', // TYPE
      pattern: /^CREATE\s+(?:OR\s+REPLACE\s+)?TYPE\s+(?:\w+\.)?([A-Za-z_][A-Za-z0-9_]*)/i,
    },
    {
      kind: 'module', // SCHEMA
      pattern: /^CREATE\s+(?:OR\s+REPLACE\s+)?SCHEMA\s+([A-Za-z_][A-Za-z0-9_]*)/i,
    },
    {
      kind: 'enum', // INDEX
      pattern: /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i,
    },
  ],
});
