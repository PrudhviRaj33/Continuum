import type { LanguageDefinition } from '../LanguageRegistry';

const definition: LanguageDefinition = {
  name: 'php',
  displayName: 'PHP',
  extensions: ['.php', '.phtml', '.php3', '.php4', '.php5'],
  commentPrefixes: ['//', '#', '/*', '*', '*/'],
  rules: [
    { kind: 'class', pattern: /^(?:abstract\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'interface', pattern: /^interface\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'trait', pattern: /^trait\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'enum', pattern: /^enum\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'function', pattern: /^(?:function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: 'method', pattern: /^\s+(?:public|private|protected|static|abstract|final|\s)*\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
  ],
};

export default definition;
