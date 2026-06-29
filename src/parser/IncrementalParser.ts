import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDb } from '../database/Database';
import { getLanguageByExtension, LanguageDefinition } from '../languages/LanguageRegistry';
import { logger } from '../utils/logger';

interface ExtractedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature: string;
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
      const content = await fs.readFile(filePath, 'utf-8');
      const hash = crypto.createHash('md5').update(content).digest('hex');
      const sizeBytes = Buffer.byteLength(content, 'utf-8');

      const db = getDb();

      // Skip if file content hasn't changed
      const existing = db
        .prepare('SELECT hash FROM files WHERE path = ?')
        .get(filePath) as { hash: string } | undefined;

      if (existing?.hash === hash) {
        logger.debug({ filePath }, 'Skipped (unchanged)');
        return;
      }

      // Extract symbols using language-specific rules
      const symbols = this.extractSymbols(content, langDef);

      // Upsert file record
      db.prepare(`
        INSERT INTO files (path, language, last_parsed, hash, size_bytes, symbol_count, updated_at)
        VALUES (?, ?, unixepoch(), ?, ?, ?, unixepoch())
        ON CONFLICT(path) DO UPDATE SET
          language     = excluded.language,
          last_parsed  = excluded.last_parsed,
          hash         = excluded.hash,
          size_bytes   = excluded.size_bytes,
          symbol_count = excluded.symbol_count,
          updated_at   = excluded.updated_at
      `).run(filePath, langDef.name, hash, sizeBytes, symbols.length);

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

      // Delete from FTS (by file path)
      for (const s of oldSymbols) {
        db.prepare(
          "DELETE FROM symbols_fts WHERE name = ? AND kind = ? AND file_path = ?"
        ).run(s.name, s.kind, filePath);
      }

      // Insert new symbols in a transaction for atomicity
      const insertSymbol = db.prepare(`
        INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertFts = db.prepare(
        'INSERT INTO symbols_fts (name, kind, file_path) VALUES (?, ?, ?)'
      );

      db.transaction(() => {
        for (const s of symbols) {
          insertSymbol.run(fileId, s.name, s.kind, s.startLine, s.endLine, s.signature);
          insertFts.run(s.name, s.kind, filePath);
        }
      })();

      logger.debug(
        { filePath, language: langDef.name, symbolCount: symbols.length },
        'Parsed file'
      );
    } catch (err) {
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
