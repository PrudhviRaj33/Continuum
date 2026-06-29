import { registerLanguage } from '../LanguageRegistry';

registerLanguage({
  name: 'swift',
  displayName: 'Swift',
  extensions: ['.swift'],
  commentPrefixes: ['//', '/*', '*', '///'],
  rules: [
    {
      kind: 'class',
      pattern: /^(?:(?:public|private|internal|open|fileprivate)\s+)?(?:final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'struct',
      pattern: /^(?:(?:public|private|internal|open|fileprivate)\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'enum',
      pattern: /^(?:(?:public|private|internal|open|fileprivate)\s+)?(?:indirect\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'trait', // protocol in Swift
      pattern: /^(?:(?:public|private|internal|open|fileprivate)\s+)?protocol\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'class', // extension
      pattern: /^extension\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'function',
      pattern: /^(?:(?:public|private|internal|open|fileprivate|static|class)\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'method',
      pattern: /^\s+(?:(?:public|private|internal|open|fileprivate|static|class|override|mutating|nonmutating)\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
  ],
});
