import { registerLanguage } from '../LanguageRegistry';

registerLanguage({
  name: 'csharp',
  displayName: 'C#',
  extensions: ['.cs'],
  commentPrefixes: ['//', '/*', '*', '///', '///'],
  rules: [
    {
      kind: 'class',
      pattern:
        /^(?:\s*)(?:public|private|protected|internal|file|\s)*(?:abstract|sealed|static|\s)*class\s+([A-Za-z_][A-Za-z0-9_<>,\s]*?)(?:\s*[:{<]|$)/,
    },
    {
      kind: 'interface',
      pattern:
        /^(?:\s*)(?:public|private|protected|internal|\s)*interface\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'enum',
      pattern:
        /^(?:\s*)(?:public|private|protected|internal|\s)*enum\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'struct',
      pattern:
        /^(?:\s*)(?:public|private|protected|internal|readonly|\s)*(?:record\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'class', // record class
      pattern:
        /^(?:\s*)(?:public|private|protected|internal|\s)*record\s+([A-Za-z_][A-Za-z0-9_]*)/,
    },
    {
      kind: 'method',
      pattern:
        /^\s+(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|\s)+[A-Za-z<>\[\]?,\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*[\(<]/,
    },
    {
      kind: 'property',
      pattern:
        /^\s+(?:public|private|protected|internal|static|virtual|override|\s)+[A-Za-z<>\[\]?,\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/,
    },
  ],
});
