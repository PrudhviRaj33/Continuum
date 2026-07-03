import type { LanguageDefinition } from '../LanguageRegistry';

const definition: LanguageDefinition = {
  name: 'rust',
  displayName: 'Rust',
  extensions: ['.rs'],
  commentPrefixes: ['//', '/*', '*', '///'],
  rules: [
    { kind: 'struct', pattern: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'enum', pattern: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'trait', pattern: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'module', pattern: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'function', pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'method', pattern: /^\s+(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'type', pattern: /^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ],
};

export default definition;
