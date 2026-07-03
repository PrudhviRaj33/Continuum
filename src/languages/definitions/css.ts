import type { LanguageDefinition } from '../LanguageRegistry';

const definition: LanguageDefinition = {
  name: 'css',
  displayName: 'CSS',
  extensions: ['.css'],
  commentPrefixes: ['/*', ' *', '*/'],
  rules: [
    { kind: 'function', pattern: /^@keyframes\s+([A-Za-z][A-Za-z0-9_-]*)/ },
    { kind: 'module', pattern: /^@layer\s+([A-Za-z][A-Za-z0-9_.-]*)/ },
    { kind: 'property', pattern: /^[ \t]*--([A-Za-z][A-Za-z0-9_-]*)\s*:/ },
    { kind: 'class', pattern: /^[ \t]*\.([A-Za-z][A-Za-z0-9_-]*)[\s{,:>#\[]/ },
    { kind: 'property', pattern: /^#([A-Za-z][A-Za-z0-9_-]*)[\s{,]/ },
  ],
};

export default definition;
