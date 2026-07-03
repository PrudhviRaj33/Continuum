import type { LanguageDefinition } from '../LanguageRegistry';

const definition: LanguageDefinition = {
  name: 'typescript',
  displayName: 'TypeScript',
  extensions: ['.ts', '.tsx'],
  commentPrefixes: ['//', '/*', '*', '*/'],
  rules: [
    { kind: 'class', pattern: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
    { kind: 'interface', pattern: /^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
    { kind: 'enum', pattern: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
    { kind: 'type', pattern: /^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=<]/ },
    { kind: 'function', pattern: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/ },
    // Arrow functions and function expressions: export const foo = () => or const foo = async () =>
    { kind: 'function', pattern: /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/ },
    { kind: 'function', pattern: /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?function/ },
    { kind: 'method', pattern: /^[ \t]+(?:public|private|protected|static|async|override|\s)*(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/ },
    { kind: 'property', pattern: /^[ \t]+(?:public|private|protected|static|readonly|\s)+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:!?]/ },
    // Angular: @Component({ selector: 'app-foo' }) — indexes the selector as a class symbol
    { kind: 'class', pattern: /^\s*selector\s*:\s*['"]([a-z][a-z0-9-]*)['"]/ },
    // Angular: @Input() / @Output() property decorators
    { kind: 'property', pattern: /^[ \t]+@(?:Input|Output)\([^)]*\)\s+(?:\w+\s+)*([A-Za-z_$][A-Za-z0-9_$]*)/ },
  ],
};

export default definition;
