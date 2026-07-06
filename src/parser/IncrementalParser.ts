import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDb, splitCamelCase } from '../database/Database';
import { getLanguageByExtension, LanguageDefinition } from '../languages/LanguageRegistry';
import { logger } from '../utils/logger';
import { minimatch } from 'minimatch';
import {
  extractWithTreeSitter,
  isTreeSitterEnabled,
  treeSitterExtensions,
  type ExtractedSymbol,
} from './TreeSitterExtractor';

// Detect UTF-16 BOM and decode accordingly; fall back to UTF-8.
function decodeFileBuffer(buf: Buffer): string {
  // UTF-16 LE BOM: FF FE
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf);
  }
  // UTF-16 BE BOM: FE FF
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf);
  }
  // UTF-8 BOM: EF BB BF — strip it
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf-8');
  }
  return buf.toString('utf-8');
}

interface ImportDep {
  name: string;
  from: string;
}

/**
 * Regex-based incremental file parser.
 *
 * Works with any language defined in the LanguageRegistry.
 * Uses MD5 hashing to skip files that haven't changed.
 * Populates: files, symbols, symbols_fts tables.
 */
export class IncrementalParser {
  /**
   * Remove a file and all its derived data from the index — symbols (via CASCADE),
   * relationships (via CASCADE), and symbols_fts (no FK, must be cleaned manually).
   * Call this whenever a file is known to no longer exist, whether from a watcher
   * 'unlink' event, an ENOENT during parse, or a startup orphan sweep.
   */
  removeFile(filePath: string): void {
    const db = getDb();

    const file = db
      .prepare('SELECT id FROM files WHERE path = ?')
      .get(filePath) as { id: number } | undefined;

    if (!file) return;

    const orphanedSymbols = db
      .prepare('SELECT name, kind FROM symbols WHERE file_id = ?')
      .all(file.id) as { name: string; kind: string }[];

    db.transaction(() => {
      // files CASCADE-deletes symbols and relationships automatically.
      db.prepare('DELETE FROM files WHERE id = ?').run(file.id);

      // symbols_fts has no FK — must be cleaned explicitly or it accumulates
      // dead rows forever (invisible to search due to the INNER JOIN, but a
      // permanent, unbounded index-size leak on long-lived repos).
      const deleteFts = db.prepare(
        'DELETE FROM symbols_fts WHERE name = ? AND kind = ? AND file_path = ?'
      );
      for (const s of orphanedSymbols) {
        deleteFts.run(s.name, s.kind, filePath);
      }
    })();

    logger.debug({ filePath, symbolsRemoved: orphanedSymbols.length }, 'Removed file from index');
  }

  /**
   * Permanently remove a specific file from the index and record it in the
   * forget_log audit trail. The file can be re-indexed with `reindex` if it
   * still exists on disk.
   */
  forgetFile(
    filePath: string,
    reason?: string,
    sessionId?: string
  ): { files: number; symbols: number } {
    const db = getDb();

    // Count symbols before removal for the audit log
    const file = db
      .prepare('SELECT id FROM files WHERE path = ?')
      .get(filePath) as { id: number } | undefined;

    const symbolCount = file
      ? (db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE file_id = ?').get(file.id) as { n: number }).n
      : 0;
    const fileCount = file ? 1 : 0;

    this.removeFile(filePath);

    db.prepare(`
      INSERT INTO forget_log (target_type, target_value, reason, session_id, symbols_removed, files_removed)
      VALUES ('file', ?, ?, ?, ?, ?)
    `).run(filePath, reason ?? null, sessionId ?? null, symbolCount, fileCount);

    logger.info({ filePath, symbolCount, fileCount }, 'Forgot file (audit logged)');
    return { files: fileCount, symbols: symbolCount };
  }

  /**
   * Remove all indexed files matching a glob pattern and record the operation
   * in forget_log. Uses minimatch for glob matching against stored file paths.
   *
   * Example: forgetPattern('**\/*.generated.ts') removes all generated files.
   * The caller can re-index surviving files via `reindex` at any time.
   */
  forgetPattern(
    glob: string,
    reason?: string,
    sessionId?: string
  ): { files: number; symbols: number; matched: string[] } {
    const db = getDb();

    const allPaths = (db.prepare('SELECT path FROM files').all() as { path: string }[])
      .map(r => r.path)
      .filter(p => minimatch(p, glob, { matchBase: true, dot: true }));

    let totalFiles = 0;
    let totalSymbols = 0;

    for (const p of allPaths) {
      const r = this.forgetFile(p, reason, sessionId);
      totalFiles  += r.files;
      totalSymbols += r.symbols;
    }

    // One summary entry for the pattern itself
    db.prepare(`
      INSERT INTO forget_log (target_type, target_value, reason, session_id, symbols_removed, files_removed)
      VALUES ('pattern', ?, ?, ?, ?, ?)
    `).run(glob, reason ?? null, sessionId ?? null, totalSymbols, totalFiles);

    logger.info({ glob, totalFiles, totalSymbols }, 'Forgot pattern (audit logged)');
    return { files: totalFiles, symbols: totalSymbols, matched: allPaths };
  }

  /**
   * Reconcile the files table against the actual filesystem. Removes any indexed
   * file that no longer exists on disk — covers files deleted while the watcher
   * wasn't running, or files that fell outside a since-narrowed watch scope.
   * Safe to call on every startup; it's a pure existence check, not a re-parse.
   */
  async sweepOrphans(): Promise<number> {
    const db = getDb();
    const allFiles = db.prepare('SELECT path FROM files').all() as { path: string }[];

    let removed = 0;
    for (const { path: filePath } of allFiles) {
      try {
        await fs.access(filePath);
      } catch {
        this.removeFile(filePath);
        removed++;
      }
    }

    if (removed > 0) {
      logger.info({ removed }, 'Startup orphan sweep: purged files no longer on disk');
    }
    return removed;
  }

  /**
   * Parse a single file and upsert its symbols into the database.
   * Silently skips files whose hash hasn't changed.
   */
  async parseFile(filePath: string): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    const langDef = getLanguageByExtension(ext);

    if (!langDef) {
      logger.debug({ filePath, ext }, 'Skipping: no language definition for extension');
      return;
    }

    try {
      const stats = await fs.stat(filePath);
      if (stats.size > 1024 * 1024) {
        logger.debug({ filePath, size: stats.size }, 'Skipping: file exceeds 1MB limit');
        return;
      }
      
      const raw = await fs.readFile(filePath);
      const content = decodeFileBuffer(raw);
      const hash = crypto.createHash('md5').update(raw).digest('hex');
      const sizeBytes = raw.byteLength;

      const db = getDb();

      // Determine which parser we will use for this file.
      // Tree-sitter is used when: PARSER=treesitter AND extension is supported.
      const useTSParser =
        isTreeSitterEnabled() && treeSitterExtensions().has(ext);

      // Skip if file content hasn't changed AND the parser hasn't switched.
      // When upgrading regex→treesitter, the hash is identical but we must
      // re-parse to get accurate AST symbols — so check both.
      const existing = db
        .prepare('SELECT hash, parser FROM files WHERE path = ?')
        .get(filePath) as { hash: string; parser: string } | undefined;

      const parserName = useTSParser ? 'treesitter' : 'regex';
      if (existing?.hash === hash && existing?.parser === parserName) {
        logger.debug({ filePath }, 'Skipped (unchanged)');
        return;
      }

      // ── Symbol extraction ──────────────────────────────────────────────────
      // Try tree-sitter first when enabled; fall back to regex on any failure.
      let symbols: ExtractedSymbol[];
      let actualParser = 'regex';

      if (useTSParser) {
        const tsSymbols = await extractWithTreeSitter(content, ext);
        if (tsSymbols !== null) {
          symbols = tsSymbols;
          actualParser = 'treesitter';
          logger.debug(
            { filePath, language: langDef.name, symbolCount: symbols.length },
            'Parsed file (tree-sitter)'
          );
        } else {
          // WASM unavailable or parse error — fall back to regex silently
          symbols = this.extractSymbols(content, langDef);
          logger.debug(
            { filePath, language: langDef.name, symbolCount: symbols.length },
            'Parsed file (regex fallback — tree-sitter unavailable)'
          );
        }
      } else {
        symbols = this.extractSymbols(content, langDef);
      }

      // Upsert file record — now includes parser column
      db.prepare(`
        INSERT INTO files (path, language, last_parsed, hash, size_bytes, symbol_count, parser, updated_at)
        VALUES (?, ?, unixepoch(), ?, ?, ?, ?, unixepoch())
        ON CONFLICT(path) DO UPDATE SET
          language     = excluded.language,
          last_parsed  = excluded.last_parsed,
          hash         = excluded.hash,
          size_bytes   = excluded.size_bytes,
          symbol_count = excluded.symbol_count,
          parser       = excluded.parser,
          updated_at   = excluded.updated_at
      `).run(filePath, langDef.name, hash, sizeBytes, symbols.length, actualParser);

      // Get the file ID (works for both INSERT and UPDATE)
      const fileRow = db
        .prepare('SELECT id FROM files WHERE path = ?')
        .get(filePath) as { id: number };
      const fileId = fileRow.id;

      // Clear old symbols and FTS entries for this file
      const oldSymbols = db
        .prepare('SELECT name, kind FROM symbols WHERE file_id = ?')
        .all(fileId) as { name: string; kind: string }[];

      db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);

      // Insert new symbols in a transaction for atomicity
      const deleteFts = db.prepare(
        "DELETE FROM symbols_fts WHERE name = ? AND kind = ? AND file_path = ?"
      );
      const insertSymbol = db.prepare(`
        INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertFts = db.prepare(
        'INSERT INTO symbols_fts (name, name_tokens, kind, file_path) VALUES (?, ?, ?, ?)'
      );

      db.transaction(() => {
        // Delete from FTS inside transaction
        for (const s of oldSymbols) {
          deleteFts.run(s.name, s.kind, filePath);
        }

        for (const s of symbols) {
          insertSymbol.run(fileId, s.name, s.kind, s.startLine, s.endLine, s.signature);
          insertFts.run(s.name, splitCamelCase(s.name), s.kind, filePath);
        }
      })();

      // Extract import relationships for TS/JS files
      if (langDef.name === 'typescript' || langDef.name === 'javascript') {
        this.storeImportRelationships(filePath, content, fileId, db);
      }

      logger.debug(
        { filePath, language: langDef.name, symbolCount: symbols.length, parser: actualParser },
        'Parsed file'
      );
    } catch (err) {
      // File vanished between being queued and being read (deleted, moved, or
      // a race with a bulk git operation). Treat as a delete instead of leaving
      // a stale files/symbols/symbols_fts entry that no 'unlink' event will ever clean up.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.removeFile(filePath);
        logger.debug({ filePath }, 'File vanished before parse — removed from index');
        return;
      }
      logger.error({ filePath, err }, 'Failed to parse file');
    }
  }

  /**
   * Extract symbols line-by-line using language extraction rules.
   * Skip lines that are pure comments.
   */
  private extractSymbols(content: string, langDef: LanguageDefinition): ExtractedSymbol[] {
    const lines = content.split('\n');
    const symbols: ExtractedSymbol[] = [];
    const commentPrefixes = langDef.commentPrefixes || [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();

      // Skip blank lines
      if (!trimmed) continue;

      // Skip comment-only lines
      if (commentPrefixes.some((p) => trimmed.startsWith(p))) continue;

      // Test each rule in definition order
      for (const rule of langDef.rules) {
        const match = rule.pattern.exec(line);
        if (match) {
          const nameGroup = rule.nameGroup ?? 1;
          const name = match[nameGroup]?.trim();
          if (!name || name.length === 0) continue;

          // Skip common false-positive matches (short names that are keywords)
          if (name.length < 2 && !['_', '$'].includes(name)) continue;

          const endLine = this.findEndLine(lines, i);
          const signature = line.trim().slice(0, 120);

          symbols.push({
            name,
            kind: rule.kind,
            startLine: i + 1,  // 1-indexed
            endLine,
            signature,
          });

          break; // first matching rule wins
        }
      }
    }

    return symbols;
  }

  /**
   * Parse import statements from TS/JS content and store them as relationships.
   * Uses the file's first symbol as the anchor (from_id) so get_dependencies can retrieve them.
   */
  private storeImportRelationships(
    filePath: string,
    content: string,
    fileId: number,
    db: ReturnType<typeof import('../database/Database').getDb>
  ): void {
    try {
      const deps = this.extractImportDeps(content);
      if (deps.length === 0) return;

      // Anchor imports to the first symbol in the file — required by schema (from_id NOT NULL)
      const anchor = db
        .prepare('SELECT id FROM symbols WHERE file_id = ? LIMIT 1')
        .get(fileId) as { id: number } | undefined;
      if (!anchor) return;

      // Clear old import relationships for this file's symbols
      db.prepare(`
        DELETE FROM relationships
        WHERE from_id IN (SELECT id FROM symbols WHERE file_id = ?)
        AND kind = 'imports'
      `).run(fileId);

      const insert = db.prepare(
        'INSERT INTO relationships (from_id, to_name, kind, to_file) VALUES (?, ?, ?, ?)'
      );
      db.transaction(() => {
        for (const dep of deps) {
          insert.run(anchor.id, dep.name, 'imports', dep.from);
        }
      })();
    } catch (err) {
      logger.debug({ filePath, err }, 'Import extraction failed (non-fatal)');
    }
  }

  /** Extract named, default, and namespace imports from TS/JS source. */
  private extractImportDeps(content: string): ImportDep[] {
    const deps: ImportDep[] = [];
    const lines = content.split('\n');
    let i = 0;

    while (i < lines.length) {
      const trimmed = lines[i].trim();

      // Only process lines that start an import statement
      if (!/^import[\s{*]/.test(trimmed)) {
        i++;
        continue;
      }

      // Collect multi-line import: keep appending until we see 'from ...'
      let stmt = trimmed;
      while (!(/from\s+['"]/.test(stmt)) && i + 1 < lines.length) {
        i++;
        stmt += ' ' + lines[i].trim();
      }
      i++;

      const fromMatch = /from\s+['"]([^'"]+)['"]/.exec(stmt);
      if (!fromMatch) continue;
      const fromPath = fromMatch[1];

      // Named imports: { A, B as C, type D }
      const namedBlock = /\{([^}]+)\}/.exec(stmt);
      if (namedBlock) {
        const names = namedBlock[1]
          .split(',')
          .map((n) =>
            n.trim()
              .replace(/^type\s+/, '')   // strip leading 'type'
              .replace(/\s+as\s+\S+/, '') // strip alias ' as X'
              .trim()
          )
          .filter((n) => n.length > 1 && /^[A-Za-z_$]/.test(n));
        for (const name of names) deps.push({ name, from: fromPath });
      }

      // Namespace import: import * as X
      const nsMatch = /\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]+)/.exec(stmt);
      if (nsMatch) {
        deps.push({ name: nsMatch[1], from: fromPath });
        continue;
      }

      // Default import: import X from '...' (no braces, no *)
      if (!namedBlock) {
        const defMatch = /^import\s+(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]+)\s/.exec(stmt);
        if (defMatch && defMatch[1] !== 'type') {
          deps.push({ name: defMatch[1], from: fromPath });
        }
      }
    }

    // Deduplicate by name+from
    const seen = new Set<string>();
    return deps.filter((d) => {
      const key = `${d.name}|${d.from}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Heuristic end-line finder: look for the closing brace / dedent.
   * Falls back to the same line if nothing is found.
   */
  private findEndLine(lines: string[], startIdx: number): number {
    const startLine = lines[startIdx];
    const indent = startLine.length - startLine.trimStart().length;
    let depth = 0;
    let hasOpened = false;

    for (let i = startIdx; i < Math.min(startIdx + 500, lines.length); i++) {
      for (const ch of lines[i]) {
        if (ch === '{' || ch === '(') { depth++; hasOpened = true; }
        if (ch === '}' || ch === ')') { depth--; }
      }
      if (hasOpened && depth <= 0) return i + 1;
      // Python/Ruby style: end when indentation returns to base level
      if (i > startIdx && lines[i].trim() && lines[i].length - lines[i].trimStart().length <= indent) {
        if (!hasOpened) return i; // never found a brace — use dedent
      }
    }

    return startIdx + 1;
  }
}
