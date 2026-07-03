import type { LanguageDefinition } from '../LanguageRegistry';

const definition: LanguageDefinition = {
  name: 'cpp',
  displayName: 'C/C++',
  extensions: ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx'],
  commentPrefixes: ['//', '/*', '*', '*/'],
  rules: [
    { kind: 'class', pattern: /^(?:class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'struct', pattern: /^typedef\s+struct\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'enum', pattern: /^(?:enum(?:\s+class)?)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'function', pattern: /^[A-Za-z_][A-Za-z0-9_:*&\s<>]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: 'method', pattern: /^[A-Za-z_][A-Za-z0-9_<>:*&\s]+::([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
  ],
};

export default definition;
