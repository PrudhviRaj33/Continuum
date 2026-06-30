import { registerLanguage } from '../LanguageRegistry';

registerLanguage({
  name: 'css',
  displayName: 'CSS',
  extensions: ['.css'],
  commentPrefixes: ['/*', ' *', '*/'],
  rules: [
    // @keyframes: @keyframes fadeIn {
    { kind: 'function', pattern: /^@keyframes\s+([A-Za-z][A-Za-z0-9_-]*)/ },
    // @layer: @layer utilities {
    { kind: 'module', pattern: /^@layer\s+([A-Za-z][A-Za-z0-9_.-]*)/ },
    // CSS custom properties (design tokens): --color-primary: #007bff;
    { kind: 'property', pattern: /^[ \t]*--([A-Za-z][A-Za-z0-9_-]*)\s*:/ },
    // Class selectors: .primary-button { or .card:hover { or indented .nested {
    { kind: 'class', pattern: /^[ \t]*\.([A-Za-z][A-Za-z0-9_-]*)[\s{,:>#\[]/ },
    // ID selectors: #hero-section {
    { kind: 'property', pattern: /^#([A-Za-z][A-Za-z0-9_-]*)[\s{,]/ },
  ],
});
