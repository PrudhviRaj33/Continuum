import { registerLanguage } from '../LanguageRegistry';

registerLanguage({
  name: 'python',
  displayName: 'Python',
  extensions: ['.py', '.pyw'],
  commentPrefixes: ['#'],
  rules: [
    { kind: 'class', pattern: /^class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'function', pattern: /^def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'method', pattern: /^\s{4}def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'function', pattern: /^async\s+def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'method', pattern: /^\s{4}async\s+def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ],
});
