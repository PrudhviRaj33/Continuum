import type { LanguageDefinition } from '../LanguageRegistry';

const definition: LanguageDefinition = {
  name: 'go',
  displayName: 'Go',
  extensions: ['.go'],
  commentPrefixes: ['//', '/*', '*/'],
  rules: [
    { kind: 'struct', pattern: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct/ },
    { kind: 'interface', pattern: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface/ },
    { kind: 'type', pattern: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+/ },
    { kind: 'function', pattern: /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: 'method', pattern: /^func\s+\([^)]+\)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
  ],
};

export default definition;
