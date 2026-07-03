import type { LanguageDefinition } from '../LanguageRegistry';

const definition: LanguageDefinition = {
  name: 'html',
  displayName: 'HTML / Angular Template',
  extensions: ['.html', '.htm'],
  commentPrefixes: ['<!--'],
  rules: [
    // Named ng-template blocks: <ng-template #myTemplate> — must come before generic custom-element
    // rule so the ref name is captured rather than the tag name
    {
      kind: 'interface',
      pattern: /^[ \t]*<ng-template\b[^>]*#([A-Za-z][A-Za-z0-9_]*)/,
    },
    // Custom elements and Angular component selectors (must contain a hyphen)
    // Matches: <app-header, <mat-button, <my-dialog, <router-outlet
    {
      kind: 'class',
      pattern: /^[ \t]*<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s\/>]/,
    },
    // Template reference variables: <input #emailInput> or attribute on its own line
    {
      kind: 'property',
      pattern: /[\s\(]#([A-Za-z][A-Za-z0-9_]*)[\s>=]/,
    },
  ],
};

export default definition;
