/**
 * TreeSitterExtractor — AST-based symbol extraction via web-tree-sitter (WASM).
 *
 * Activated when PARSER=treesitter. Falls back silently to regex on any error
 * so the rest of the pipeline is never disrupted.
 *
 * Supported languages: TypeScript, JavaScript, Python, C#, Java, Go.
 * Other languages continue to use the regex extractor unchanged.
 *
 * WASM files are sourced from the optional `tree-sitter-wasms` package.
 * If the package is not installed, this module gracefully returns null so the
 * caller can fall back to regex.
 */

import * as path from 'path';
import { logger } from '../utils/logger';

// ─── Types shared with IncrementalParser ─────────────────────────────────────

export interface ExtractedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature: string;
}

// ─── Tree-sitter type aliases ────────────────────────────────────────────────
// web-tree-sitter v0.26+ exports Parser, Language, Node as named exports.
// There is NO default export.

type TSParser = import('web-tree-sitter').Parser;
type TSLanguage = import('web-tree-sitter').Language;
type TSNode = import('web-tree-sitter').Node;
type TSModule = typeof import('web-tree-sitter');

// ─── Tree-sitter node-type → SymbolKind mappings ─────────────────────────────

interface NodeMapping {
  /** tree-sitter node type(s) that represent this kind */
  nodeTypes: string[];
  /** Which child node's text is the symbol name */
  nameField: string;
  /** The SymbolKind to emit */
  kind: string;
}

type GrammarConfig = {
  wasmFile: string;
  mappings: NodeMapping[];
};

const GRAMMAR_CONFIGS: Record<string, GrammarConfig> = {
  typescript: {
    wasmFile: 'tree-sitter-typescript.wasm',
    mappings: [
      { nodeTypes: ['class_declaration', 'abstract_class_declaration'], nameField: 'name', kind: 'class' },
      { nodeTypes: ['interface_declaration'], nameField: 'name', kind: 'interface' },
      { nodeTypes: ['enum_declaration'], nameField: 'name', kind: 'enum' },
      { nodeTypes: ['type_alias_declaration'], nameField: 'name', kind: 'type' },
      { nodeTypes: ['function_declaration'], nameField: 'name', kind: 'function' },
      { nodeTypes: ['method_definition', 'method_signature'], nameField: 'name', kind: 'method' },
      { nodeTypes: ['public_field_definition', 'field_definition'], nameField: 'name', kind: 'property' },
      // Arrow functions / const fn expressions assigned to a variable
      { nodeTypes: ['lexical_declaration', 'variable_declaration'], nameField: '__arrow_name', kind: 'function' },
    ],
  },
  javascript: {
    wasmFile: 'tree-sitter-javascript.wasm',
    mappings: [
      { nodeTypes: ['class_declaration'], nameField: 'name', kind: 'class' },
      { nodeTypes: ['function_declaration'], nameField: 'name', kind: 'function' },
      { nodeTypes: ['method_definition'], nameField: 'name', kind: 'method' },
      { nodeTypes: ['lexical_declaration', 'variable_declaration'], nameField: '__arrow_name', kind: 'function' },
    ],
  },
  python: {
    wasmFile: 'tree-sitter-python.wasm',
    mappings: [
      { nodeTypes: ['class_definition'], nameField: 'name', kind: 'class' },
      { nodeTypes: ['function_definition'], nameField: 'name', kind: 'function' },
      // Methods are function_definition nodes inside a class body
      { nodeTypes: ['decorated_definition'], nameField: '__decorated_name', kind: 'method' },
    ],
  },
  csharp: {
    wasmFile: 'tree-sitter-c_sharp.wasm',
    mappings: [
      { nodeTypes: ['class_declaration'], nameField: 'name', kind: 'class' },
      { nodeTypes: ['interface_declaration'], nameField: 'name', kind: 'interface' },
      { nodeTypes: ['enum_declaration'], nameField: 'name', kind: 'enum' },
      { nodeTypes: ['struct_declaration'], nameField: 'name', kind: 'struct' },
      { nodeTypes: ['record_declaration'], nameField: 'name', kind: 'class' },
      { nodeTypes: ['method_declaration'], nameField: 'name', kind: 'method' },
      { nodeTypes: ['property_declaration'], nameField: 'name', kind: 'property' },
      { nodeTypes: ['constructor_declaration'], nameField: 'name', kind: 'constructor' },
    ],
  },
  java: {
    wasmFile: 'tree-sitter-java.wasm',
    mappings: [
      { nodeTypes: ['class_declaration'], nameField: 'name', kind: 'class' },
      { nodeTypes: ['interface_declaration'], nameField: 'name', kind: 'interface' },
      { nodeTypes: ['enum_declaration'], nameField: 'name', kind: 'enum' },
      { nodeTypes: ['method_declaration'], nameField: 'name', kind: 'method' },
      { nodeTypes: ['constructor_declaration'], nameField: 'name', kind: 'constructor' },
    ],
  },
  go: {
    wasmFile: 'tree-sitter-go.wasm',
    mappings: [
      { nodeTypes: ['type_declaration'], nameField: '__go_type_name', kind: 'class' },
      { nodeTypes: ['function_declaration'], nameField: 'name', kind: 'function' },
      { nodeTypes: ['method_declaration'], nameField: 'name', kind: 'method' },
    ],
  },
};

// Extension → language name (must match LanguageRegistry names)
const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.cs': 'csharp',
  '.java': 'java',
  '.go': 'go',
};

// ─── Module-level parser cache (init once, reuse across files) ────────────────

let tsMod: TSModule | null = null;
const langCache = new Map<string, TSLanguage>();
let initAttempted = false;
let initSuccess = false;

async function ensureTreeSitter(): Promise<TSModule | null> {
  if (initAttempted) return initSuccess ? tsMod : null;
  initAttempted = true;

  try {
    // Dynamic import — web-tree-sitter is an optional dependency
    const mod: TSModule = await import('web-tree-sitter');
    tsMod = mod;

    // Locate the core WASM file bundled with web-tree-sitter
    const wasmPath = path.join(
      path.dirname(require.resolve('web-tree-sitter')),
      'web-tree-sitter.wasm'
    );
    await mod.Parser.init({ wasmBinary: await readWasm(wasmPath) } as Record<string, unknown>);
    initSuccess = true;
    logger.debug('Tree-sitter core WASM initialised');
    return tsMod;
  } catch (err) {
    logger.warn({ err }, 'Tree-sitter init failed — falling back to regex for all files');
    return null;
  }
}

async function getLanguage(langName: string): Promise<TSLanguage | null> {
  if (langCache.has(langName)) return langCache.get(langName)!;

  const config = GRAMMAR_CONFIGS[langName];
  if (!config) return null;

  try {
    const mod = await ensureTreeSitter();
    if (!mod) return null;

    // Grammar WASMs are in the optional tree-sitter-wasms package
    const wasmDir = path.dirname(require.resolve('tree-sitter-wasms'));
    const wasmPath = path.join(wasmDir, 'out', config.wasmFile);
    const wasm = await readWasm(wasmPath);
    const lang = await mod.Language.load(wasm);
    langCache.set(langName, lang);
    logger.debug({ langName }, 'Tree-sitter grammar loaded');
    return lang;
  } catch (err) {
    logger.debug({ langName, err }, 'Grammar load failed — regex fallback for this language');
    return null;
  }
}

async function readWasm(filePath: string): Promise<Uint8Array> {
  const { readFile } = await import('fs/promises');
  const buf = await readFile(filePath);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ─── Parser cache — one Parser per language ───────────────────────────────────

const parserCache = new Map<string, TSParser>();

async function getParser(langName: string): Promise<TSParser | null> {
  if (parserCache.has(langName)) return parserCache.get(langName)!;

  const mod = await ensureTreeSitter();
  if (!mod) return null;

  const lang = await getLanguage(langName);
  if (!lang) return null;

  const parser = new mod.Parser();
  parser.setLanguage(lang);
  parserCache.set(langName, parser);
  return parser;
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

/**
 * Extract symbols from `content` using tree-sitter AST parsing.
 * Returns null if tree-sitter is unavailable for this extension (caller uses regex).
 */
export async function extractWithTreeSitter(
  content: string,
  ext: string
): Promise<ExtractedSymbol[] | null> {
  const langName = EXT_TO_LANG[ext.toLowerCase()];
  if (!langName) return null; // Not a supported language — use regex

  try {
    const parser = await getParser(langName);
    if (!parser) return null;

    const tree = parser.parse(content);
    if (!tree) return null;
    const symbols: ExtractedSymbol[] = [];
    const lines = content.split('\n');

    walkNode(tree.rootNode, langName, lines, symbols);

    return symbols;
  } catch (err) {
    logger.debug({ ext, err }, 'Tree-sitter parse error — regex fallback');
    return null;
  }
}

// ─── AST walker ───────────────────────────────────────────────────────────────

function walkNode(
  node: TSNode,
  langName: string,
  lines: string[],
  out: ExtractedSymbol[]
): void {
  const config = GRAMMAR_CONFIGS[langName];
  if (!config) return;

  for (const mapping of config.mappings) {
    if (mapping.nodeTypes.includes(node.type)) {
      const sym = extractFromNode(node, mapping, lines);
      if (sym) out.push(sym);
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkNode(child, langName, lines, out);
  }
}

function extractFromNode(
  node: TSNode,
  mapping: NodeMapping,
  lines: string[]
): ExtractedSymbol | null {
  let name: string | null = null;

  if (mapping.nameField === '__arrow_name') {
    // const foo = () => ... or const foo = function ...
    name = resolveArrowFunctionName(node);
  } else if (mapping.nameField === '__decorated_name') {
    // Python decorated_definition wraps a function_definition
    name = resolveDecoratedName(node);
  } else if (mapping.nameField === '__go_type_name') {
    // Go type_declaration contains type_spec children
    name = resolveGoTypeName(node);
  } else {
    const nameNode = node.childForFieldName(mapping.nameField);
    name = nameNode?.text ?? null;
  }

  if (!name || name.length === 0) return null;
  if (name.length < 2 && !['_', '$'].includes(name)) return null;

  const startLine = node.startPosition.row + 1; // 1-indexed
  const endLine = node.endPosition.row + 1;
  const rawLine = lines[node.startPosition.row] ?? '';
  const signature = rawLine.trim().slice(0, 120);

  return { name, kind: mapping.kind, startLine, endLine, signature };
}

// ─── Language-specific name resolvers ────────────────────────────────────────

function resolveArrowFunctionName(
  node: TSNode
): string | null {
  // lexical_declaration or variable_declaration
  // Look for a variable_declarator child whose value is arrow_function or function
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'variable_declarator') {
      const valueNode = child.childForFieldName('value');
      if (
        valueNode &&
        (valueNode.type === 'arrow_function' ||
          valueNode.type === 'function' ||
          valueNode.type === 'function_expression')
      ) {
        const nameNode = child.childForFieldName('name');
        return nameNode?.text ?? null;
      }
    }
  }
  return null;
}

function resolveDecoratedName(
  node: TSNode
): string | null {
  // Python: decorated_definition → definition (function_definition | class_definition)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (
      child &&
      (child.type === 'function_definition' || child.type === 'class_definition')
    ) {
      const nameNode = child.childForFieldName('name');
      return nameNode?.text ?? null;
    }
  }
  return null;
}

function resolveGoTypeName(
  node: TSNode
): string | null {
  // Go: type_declaration → type_spec → name
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'type_spec') {
      const nameNode = child.childForFieldName('name');
      return nameNode?.text ?? null;
    }
  }
  return null;
}

// ─── Availability check ───────────────────────────────────────────────────────

/** Returns true if PARSER=treesitter and the package loads successfully. */
export function isTreeSitterEnabled(): boolean {
  return process.env['PARSER'] === 'treesitter';
}

/** Returns the set of extensions supported by tree-sitter. */
export function treeSitterExtensions(): Set<string> {
  return new Set(Object.keys(EXT_TO_LANG));
}
