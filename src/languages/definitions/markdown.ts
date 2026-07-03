import type { LanguageDefinition } from '../LanguageRegistry';

const definition: LanguageDefinition = {
  name: 'markdown',
  displayName: 'Markdown',
  extensions: ['.md', '.mdx', '.markdown'],
  commentPrefixes: [],
  rules: [
    { kind: 'class', pattern: /^#\s+(.+)$/ },
    { kind: 'module', pattern: /^##\s+(.+)$/ },
    { kind: 'function', pattern: /^###\s+(.+)$/ },
  ],
};

export default definition;
