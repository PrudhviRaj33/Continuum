import { registerLanguage } from '../LanguageRegistry';

registerLanguage({
  name: 'markdown',
  displayName: 'Markdown',
  extensions: ['.md', '.mdx', '.markdown'],
  commentPrefixes: [],
  rules: [
    // H1 heading → class (primary document)
    { kind: 'class', pattern: /^#\s+(.+)$/ },
    // H2 heading → module (major section)
    { kind: 'module', pattern: /^##\s+(.+)$/ },
    // H3 heading → function (subsection)
    { kind: 'function', pattern: /^###\s+(.+)$/ },
  ],
});
