import type { LanguageDefinition } from '../LanguageRegistry';

const definition: LanguageDefinition = {
  name: 'java',
  displayName: 'Java',
  extensions: ['.java'],
  commentPrefixes: ['//', '/*', '*', '*/'],
  rules: [
    { kind: 'class', pattern: /^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'interface', pattern: /^(?:public\s+|private\s+|protected\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'enum', pattern: /^(?:public\s+|private\s+|protected\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'method', pattern: /^\s+(?:public|private|protected|static|final|synchronized|abstract|\s)+\s+[A-Za-z<>\[\]?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: 'constructor', pattern: /^\s+(?:public|private|protected)\s+([A-Z][A-Za-z0-9_]*)\s*\(/ },
  ],
};

export default definition;
