import type { LanguageDefinition } from '../LanguageRegistry';

const definition: LanguageDefinition = {
  name: 'javascript',
  displayName: 'JavaScript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  commentPrefixes: ['//', '/*', '*', '*/'],
  rules: [
    // Class declarations and expressions
    { kind: 'class', pattern: /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
    // Named function declarations
    { kind: 'function', pattern: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
    // Arrow functions and function expressions: export const foo = () =>  or  const foo = async () =>
    { kind: 'function', pattern: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/ },
    // Function expressions assigned to variable: const foo = function() or const foo = async function()
    { kind: 'function', pattern: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?function/ },
    // module.exports.foo = function / module.exports = { foo: function
    { kind: 'function', pattern: /^(?:module\.exports|exports)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?function/ },
    { kind: 'function', pattern: /^(?:module\.exports|exports)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/ },
    // Object/class methods (indented): async foo() {  or  foo() {
    { kind: 'method', pattern: /^[ \t]+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/ },
    // CommonJS exports object shorthand: module.exports = { foo, bar }  — captures each name
    { kind: 'function', pattern: /^[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|\})/ },
  ],
};

export default definition;
