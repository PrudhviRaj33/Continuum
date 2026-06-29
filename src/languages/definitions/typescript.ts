import { registerLanguage } from '../LanguageRegistry';

registerLanguage({
  name: 'typescript',
  displayName: 'TypeScript',
  extensions: ['.ts', '.tsx'],
  commentPrefixes: ['//', '/*', '*', '*/'],
  rules: [
    {
      kind: 'class',
      pattern: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    },
    {
      kind: 'interface',
      pattern: /^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    },
    {
      kind: 'enum',
      pattern: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    },
    {
      kind: 'type',
      pattern: /^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=<]/,
    },
    {
      kind: 'function',
      pattern:
        /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/,
    },
    {
      kind: 'method',
      pattern:
        /^\s+(?:public|private|protected|static|async|override|\s)*(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
    },
    {
      kind: 'property',
      pattern:
        /^\s+(?:public|private|protected|static|readonly|\s)+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:!?]/,
    },
  ],
});
