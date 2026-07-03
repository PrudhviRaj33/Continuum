import type { LanguageDefinition } from '../LanguageRegistry';

const definition: LanguageDefinition = {
  name: 'ruby',
  displayName: 'Ruby',
  extensions: ['.rb', '.rake', '.gemspec'],
  commentPrefixes: ['#'],
  rules: [
    { kind: 'class', pattern: /^class\s+([A-Za-z_][A-Za-z0-9_:]*)\s*/ },
    { kind: 'module', pattern: /^module\s+([A-Za-z_][A-Za-z0-9_:]*)/ },
    { kind: 'method', pattern: /^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_?!]*)/ },
    { kind: 'function', pattern: /^def\s+([A-Za-z_][A-Za-z0-9_?!]*)/ },
  ],
};

export default definition;
