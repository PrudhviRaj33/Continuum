// ─────────────────────────────────────────────────────────────────────────────
// Language Registry — plug-in architecture for multi-language symbol extraction
// ─────────────────────────────────────────────────────────────────────────────

export type SymbolKind =
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'module'
  | 'property'
  | 'constructor'
  | 'type';

/**
 * A regex-based extraction rule.
 * Each rule defines a pattern and the capture group index for the symbol name.
 */
export interface ExtractionRule {
  /** Regex that matches a symbol definition line */
  pattern: RegExp;
  /** Capture group index for the symbol name (default: 1) */
  nameGroup?: number;
  /** The kind of symbol this rule extracts */
  kind: SymbolKind;
}

/**
 * Complete definition for one programming language.
 * Drop a new definition file in src/languages/definitions/ to add a language.
 */
export interface LanguageDefinition {
  /** Internal identifier, lowercase (e.g. 'typescript') */
  name: string;
  /** Human-readable display name (e.g. 'TypeScript') */
  displayName: string;
  /** File extensions this language owns (e.g. ['.ts', '.tsx']) */
  extensions: string[];
  /** Extraction rules, applied line-by-line in order */
  rules: ExtractionRule[];
  /** Lines starting with these strings are comments — skip them */
  commentPrefixes?: string[];
}

// ─── Registry ────────────────────────────────────────────────────────────────
// The Map MUST be declared before any registerLanguage calls.
// All definitions are inlined here (not imported) to avoid hoisting issues
// with ES module imports running before the Map is initialized.

const registry = new Map<string, LanguageDefinition>();

/** Register a language definition. Called at module load time. */
export function registerLanguage(def: LanguageDefinition): void {
  for (const ext of def.extensions) {
    registry.set(ext.toLowerCase(), def);
  }
}

/** Look up a language by file extension (e.g. '.ts'). */
export function getLanguageByExtension(ext: string): LanguageDefinition | undefined {
  return registry.get(ext.toLowerCase());
}

/** All unique file extensions watched by Continuum. */
export function getAllWatchedExtensions(): string[] {
  return [...new Set(registry.keys())];
}

/** All registered language definitions (deduplicated by name). */
export function getAllLanguages(): LanguageDefinition[] {
  const seen = new Set<string>();
  const result: LanguageDefinition[] = [];
  for (const def of registry.values()) {
    if (!seen.has(def.name)) {
      seen.add(def.name);
      result.push(def);
    }
  }
  return result;
}

// ─── Language Definitions ───────────────────────────────────────────────────
// All definitions registered inline. Adding a new language: append a
// registerLanguage() call below. No other changes needed.

registerLanguage({
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
    { kind: 'method', pattern: /^\s+(?:public|private|protected|static|async|override|\s)*(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/ },
    { kind: 'property', pattern: /^\s+(?:public|private|protected|static|readonly|\s)+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:!?]/ },
  ],
});

registerLanguage({
  name: 'javascript',
  displayName: 'JavaScript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  commentPrefixes: ['//', '/*', '*', '*/'],
  rules: [
    { kind: 'class', pattern: /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
    { kind: 'function', pattern: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
    { kind: 'function', pattern: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?\(/ },
    { kind: 'method', pattern: /^\s+(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/ },
  ],
});

registerLanguage({
  name: 'python',
  displayName: 'Python',
  extensions: ['.py', '.pyw'],
  commentPrefixes: ['#'],
  rules: [
    { kind: 'class', pattern: /^class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'function', pattern: /^def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'method', pattern: /^\s{4}def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'function', pattern: /^async\s+def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'method', pattern: /^\s{4}async\s+def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ],
});

registerLanguage({
  name: 'rust',
  displayName: 'Rust',
  extensions: ['.rs'],
  commentPrefixes: ['//', '/*', '*', '///'],
  rules: [
    { kind: 'struct', pattern: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'enum', pattern: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'trait', pattern: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'module', pattern: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'function', pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'method', pattern: /^\s+(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'type', pattern: /^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ],
});

registerLanguage({
  name: 'go',
  displayName: 'Go',
  extensions: ['.go'],
  commentPrefixes: ['//', '/*', '*/'],
  rules: [
    { kind: 'struct', pattern: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct/ },
    { kind: 'interface', pattern: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface/ },
    { kind: 'type', pattern: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+/ },
    { kind: 'function', pattern: /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: 'method', pattern: /^func\s+\([^)]+\)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
  ],
});

registerLanguage({
  name: 'java',
  displayName: 'Java',
  extensions: ['.java'],
  commentPrefixes: ['//', '/*', '*', '*/'],
  rules: [
    { kind: 'class', pattern: /^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'interface', pattern: /^(?:public\s+|private\s+|protected\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'enum', pattern: /^(?:public\s+|private\s+|protected\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'method', pattern: /^\s+(?:public|private|protected|static|final|synchronized|abstract|\s)+\s+[A-Za-z<>\[\]?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: 'constructor', pattern: /^\s+(?:public|private|protected)\s+([A-Z][A-Za-z0-9_]*)\s*\(/ },
  ],
});

registerLanguage({
  name: 'csharp',
  displayName: 'C#',
  extensions: ['.cs'],
  commentPrefixes: ['//', '/*', '*', '///'],
  rules: [
    { kind: 'class', pattern: /^(?:\s*)(?:public|private|protected|internal|file|\s)*(?:abstract|sealed|static|\s)*class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'interface', pattern: /^(?:\s*)(?:public|private|protected|internal|\s)*interface\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'enum', pattern: /^(?:\s*)(?:public|private|protected|internal|\s)*enum\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'struct', pattern: /^(?:\s*)(?:public|private|protected|internal|readonly|\s)*(?:record\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'class', pattern: /^(?:\s*)(?:public|private|protected|internal|\s)*record\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'method', pattern: /^\s+(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|\s)+[A-Za-z<>\[\]?,\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*[\(<]/ },
    { kind: 'property', pattern: /^\s+(?:public|private|protected|internal|static|virtual|override|\s)+[A-Za-z<>\[\]?,\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/ },
  ],
});

registerLanguage({
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
});

registerLanguage({
  name: 'ruby',
  displayName: 'Ruby',
  extensions: ['.rb', '.rake', '.gemspec'],
  commentPrefixes: ['#'],
  rules: [
    { kind: 'class', pattern: /^class\s+([A-Za-z_][A-Za-z0-9_:]*)/ },
    { kind: 'module', pattern: /^module\s+([A-Za-z_][A-Za-z0-9_:]*)/ },
    { kind: 'method', pattern: /^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_?!]*)/ },
    { kind: 'function', pattern: /^def\s+([A-Za-z_][A-Za-z0-9_?!]*)/ },
  ],
});

registerLanguage({
  name: 'php',
  displayName: 'PHP',
  extensions: ['.php', '.phtml', '.php3', '.php4', '.php5'],
  commentPrefixes: ['//', '#', '/*', '*', '*/'],
  rules: [
    { kind: 'class', pattern: /^(?:abstract\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'interface', pattern: /^interface\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'trait', pattern: /^trait\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'enum', pattern: /^enum\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'function', pattern: /^(?:function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
    { kind: 'method', pattern: /^\s+(?:public|private|protected|static|abstract|final|\s)*\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
  ],
});

registerLanguage({
  name: 'swift',
  displayName: 'Swift',
  extensions: ['.swift'],
  commentPrefixes: ['//', '/*', '*', '///'],
  rules: [
    { kind: 'class', pattern: /^(?:(?:public|private|internal|open|fileprivate)\s+)?(?:final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'struct', pattern: /^(?:(?:public|private|internal|open|fileprivate)\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'enum', pattern: /^(?:(?:public|private|internal|open|fileprivate)\s+)?(?:indirect\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'trait', pattern: /^(?:(?:public|private|internal|open|fileprivate)\s+)?protocol\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'class', pattern: /^extension\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'function', pattern: /^(?:(?:public|private|internal|open|fileprivate|static|class)\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'method', pattern: /^\s+(?:(?:public|private|internal|open|fileprivate|static|class|override|mutating|nonmutating)\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ],
});

registerLanguage({
  name: 'kotlin',
  displayName: 'Kotlin',
  extensions: ['.kt', '.kts'],
  commentPrefixes: ['//', '/*', '*', '*/'],
  rules: [
    { kind: 'class', pattern: /^(?:(?:public|private|internal|protected|open|abstract|sealed|data|inner|value)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'interface', pattern: /^(?:(?:public|private|internal|protected|sealed)\s+)*(?:fun\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'enum', pattern: /^(?:(?:public|private|internal|protected)\s+)*enum\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'class', pattern: /^(?:(?:public|private|internal|protected|companion)\s+)*object\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'function', pattern: /^(?:(?:public|private|internal|protected|inline|suspend|tailrec|operator|infix|external)\s+)*fun\s+([A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'method', pattern: /^\s+(?:(?:public|private|internal|protected|override|inline|suspend|open|final|abstract)\s+)*fun\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  ],
});

registerLanguage({
  name: 'sql',
  displayName: 'SQL',
  extensions: ['.sql'],
  commentPrefixes: ['--', '/*', '*/'],
  rules: [
    { kind: 'class', pattern: /^CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?([A-Za-z_][A-Za-z0-9_]*)/i },
    { kind: 'interface', pattern: /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:\w+\.)?([A-Za-z_][A-Za-z0-9_]*)/i },
    { kind: 'function', pattern: /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION)\s+(?:\w+\.)?([A-Za-z_][A-Za-z0-9_]*)/i },
    { kind: 'type', pattern: /^CREATE\s+(?:OR\s+REPLACE\s+)?TYPE\s+(?:\w+\.)?([A-Za-z_][A-Za-z0-9_]*)/i },
    { kind: 'module', pattern: /^CREATE\s+(?:OR\s+REPLACE\s+)?SCHEMA\s+([A-Za-z_][A-Za-z0-9_]*)/i },
    { kind: 'enum', pattern: /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i },
  ],
});

registerLanguage({
  name: 'markdown',
  displayName: 'Markdown',
  extensions: ['.md', '.mdx', '.markdown'],
  commentPrefixes: [],
  rules: [
    { kind: 'class', pattern: /^#\s+(.+)$/ },
    { kind: 'module', pattern: /^##\s+(.+)$/ },
    { kind: 'function', pattern: /^###\s+(.+)$/ },
  ],
});
