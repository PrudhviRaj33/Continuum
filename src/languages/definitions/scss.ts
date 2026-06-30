import { registerLanguage } from '../LanguageRegistry';

registerLanguage({
  name: 'scss',
  displayName: 'SCSS / Sass',
  extensions: ['.scss', '.sass'],
  commentPrefixes: ['/*', ' *', '*/', '//'],
  rules: [
    // @mixin: @mixin flex-center($direction: row) {
    { kind: 'function', pattern: /^@mixin\s+([A-Za-z][A-Za-z0-9_-]*)/ },
    // @function: @function rem($px) {
    { kind: 'function', pattern: /^@function\s+([A-Za-z][A-Za-z0-9_-]*)/ },
    // @keyframes: @keyframes slideIn {
    { kind: 'function', pattern: /^@keyframes\s+([A-Za-z][A-Za-z0-9_-]*)/ },
    // @layer: @layer utilities {
    { kind: 'module', pattern: /^@layer\s+([A-Za-z][A-Za-z0-9_.-]*)/ },
    // SCSS variables: $brand-primary: #007bff;
    { kind: 'property', pattern: /^\$([A-Za-z][A-Za-z0-9_-]*)\s*:/ },
    // CSS custom properties: --color-primary: #007bff;
    { kind: 'property', pattern: /^[ \t]*--([A-Za-z][A-Za-z0-9_-]*)\s*:/ },
    // Placeholder selectors: %clearfix {
    { kind: 'type', pattern: /^%([A-Za-z][A-Za-z0-9_-]*)\s*\{/ },
    // Class selectors: .primary-button { or .card:hover { or indented .nested {
    { kind: 'class', pattern: /^[ \t]*\.([A-Za-z][A-Za-z0-9_-]*)[\s{,:>#\[]/ },
    // ID selectors: #hero-section {
    { kind: 'property', pattern: /^#([A-Za-z][A-Za-z0-9_-]*)[\s{,]/ },
  ],
});
