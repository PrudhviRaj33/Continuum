import { registerLanguage } from '../LanguageRegistry';

registerLanguage({
  name: 'kotlin',
  displayName: 'Kotlin',
  extensions: ['.kt', '.kts'],
  commentPrefixes: ['//', '/*', '*', '*/'],
  rules: [
    {
      kind: 'class',
      pattern: /^(?:(?:public|private|internal|protected|open|abstract|sealed|data|inner|value)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'interface',
      pattern: /^(?:(?:public|private|internal|protected|sealed)\s+)*(?:fun\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'enum',
      pattern: /^(?:(?:public|private|internal|protected)\s+)*enum\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'class', // object
      pattern: /^(?:(?:public|private|internal|protected|companion)\s+)*object\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'function',
      pattern: /^(?:(?:public|private|internal|protected|inline|suspend|tailrec|operator|infix|external)\s+)*fun\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'method',
      pattern: /^\s+(?:(?:public|private|internal|protected|override|inline|suspend|open|final|abstract)\s+)*fun\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
  ],
});
