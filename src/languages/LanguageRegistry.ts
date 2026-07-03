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

const registry = new Map<string, LanguageDefinition>();

/** Register a language definition. */
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
// Definition files export plain data objects (no runtime imports from this
// module), so there is no circular dependency and no hoisting issue.
// To add a language: create src/languages/definitions/<name>.ts exporting a
// default LanguageDefinition, then import it and call registerLanguage() below.

import typescriptDef from './definitions/typescript';
import javascriptDef from './definitions/javascript';
import pythonDef from './definitions/python';
import rustDef from './definitions/rust';
import goDef from './definitions/go';
import javaDef from './definitions/java';
import csharpDef from './definitions/csharp';
import cppDef from './definitions/cpp';
import rubyDef from './definitions/ruby';
import phpDef from './definitions/php';
import swiftDef from './definitions/swift';
import kotlinDef from './definitions/kotlin';
import sqlDef from './definitions/sql';
import markdownDef from './definitions/markdown';
import htmlDef from './definitions/html';
import cssDef from './definitions/css';
import scssDef from './definitions/scss';

registerLanguage(typescriptDef);
registerLanguage(javascriptDef);
registerLanguage(pythonDef);
registerLanguage(rustDef);
registerLanguage(goDef);
registerLanguage(javaDef);
registerLanguage(csharpDef);
registerLanguage(cppDef);
registerLanguage(rubyDef);
registerLanguage(phpDef);
registerLanguage(swiftDef);
registerLanguage(kotlinDef);
registerLanguage(sqlDef);
registerLanguage(markdownDef);
registerLanguage(htmlDef);
registerLanguage(cssDef);
registerLanguage(scssDef);
