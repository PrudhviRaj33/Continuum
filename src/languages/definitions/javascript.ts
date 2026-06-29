import { registerLanguage } from '../LanguageRegistry';

registerLanguage({
  name: 'javascript',
  displayName: 'JavaScript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  commentPrefixes: ['//', '/*', '*', '*/'],
  rules: [
    { kind: 'class', pattern: /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
    {
      kind: 'function',
      pattern: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    },
    {
      kind: 'function',
      pattern:
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?\(/,
    },
    {
      kind: 'function',
      pattern:
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:[A-Za-z_$][A-Za-z0-9_$]*\s*)?\s*=>/,
    },
    { kind: 'method', pattern: /^\s+(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/ },
  ],
});
