import { getDb } from '../database/Database';
import { getAllLanguages } from '../languages/LanguageRegistry';

export interface SymbolSearchResult {
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string;
  language: string;
}

export interface ProjectStats {
  total_files: number;
  total_symbols: number;
  languages: LanguageStat[];
  last_indexed: number | null;
}

export interface LanguageStat {
  language: string;
  displayName: string;
  file_count: number;
  symbol_count: number;
}

export interface FileSummary {
  path: string;
  language: string;
  symbol_count: number;
  symbols_by_kind: Record<string, string[]>;
}

/**
 * KnowledgeEngine — high-level query layer over the indexed codebase.
 * Used by MCP tools for search, stats, and cross-file analysis.
 */
export class KnowledgeEngine {
  /**
   * Full-text search across all indexed symbol names.
   * Uses SQLite FTS5 for fast, ranked results.
   */
  searchSymbols(query: string, limit = 30): SymbolSearchResult[] {
    const db = getDb();

    // Try FTS5 first for ranking
    try {
      const results = db
        .prepare(`
          SELECT
            s.name,
            s.kind,
            f.path        AS file_path,
            s.start_line,
            s.end_line,
            s.signature,
            f.language
          FROM symbols_fts
          JOIN symbols s ON s.name = symbols_fts.name
                        AND s.kind = symbols_fts.kind
          JOIN files   f ON f.path = symbols_fts.file_path
          WHERE symbols_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(query, limit) as SymbolSearchResult[];

      if (results.length > 0) return results;
    } catch {
      // FTS5 query may fail on special chars — fall through to LIKE
    }

    // Fallback: LIKE search
    return db
      .prepare(`
        SELECT
          s.name,
          s.kind,
          f.path   AS file_path,
          s.start_line,
          s.end_line,
          s.signature,
          f.language
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE s.name LIKE ? OR f.path LIKE ?
        ORDER BY s.name
        LIMIT ?
      `)
      .all(`%${query}%`, `%${query}%`, limit) as SymbolSearchResult[];
  }

  /**
   * High-level project statistics — file count, symbol count, per-language breakdown.
   */
  getProjectStats(): ProjectStats {
    const db = getDb();

    const totals = db
      .prepare(`
        SELECT
          COUNT(DISTINCT f.id) AS total_files,
          COUNT(s.id)          AS total_symbols,
          MAX(f.last_parsed)   AS last_indexed
        FROM files f
        LEFT JOIN symbols s ON s.file_id = f.id
      `)
      .get() as { total_files: number; total_symbols: number; last_indexed: number | null };

    const byLang = db
      .prepare(`
        SELECT
          f.language,
          COUNT(DISTINCT f.id) AS file_count,
          SUM(f.symbol_count)  AS symbol_count
        FROM files f
        WHERE f.language IS NOT NULL
        GROUP BY f.language
        ORDER BY file_count DESC
      `)
      .all() as { language: string; file_count: number; symbol_count: number }[];

    const langDisplayMap = new Map(
      getAllLanguages().map((l) => [l.name, l.displayName])
    );

    return {
      total_files: totals.total_files,
      total_symbols: totals.total_symbols,
      last_indexed: totals.last_indexed,
      languages: byLang.map((r) => ({
        language: r.language,
        displayName: langDisplayMap.get(r.language) ?? r.language,
        file_count: r.file_count,
        symbol_count: r.symbol_count ?? 0,
      })),
    };
  }

  /**
   * Summary of all symbols in one file, grouped by kind.
   */
  getFileSummary(filePath: string): FileSummary | null {
    const db = getDb();

    const file = db
      .prepare('SELECT id, language, symbol_count FROM files WHERE path LIKE ?')
      .get(`%${filePath}%`) as
      | { id: number; language: string; symbol_count: number }
      | undefined;

    if (!file) return null;

    const symbols = db
      .prepare('SELECT name, kind FROM symbols WHERE file_id = ? ORDER BY start_line')
      .all(file.id) as { name: string; kind: string }[];

    const byKind: Record<string, string[]> = {};
    for (const s of symbols) {
      if (!byKind[s.kind]) byKind[s.kind] = [];
      byKind[s.kind].push(s.name);
    }

    return {
      path: filePath,
      language: file.language,
      symbol_count: file.symbol_count,
      symbols_by_kind: byKind,
    };
  }

  /**
   * Cross-layer search — finds symbols, features, and files related to a query.
   */
  findRelated(
    query: string,
    limit = 30
  ): {
    symbols: SymbolSearchResult[];
    features: { name: string; layer: string; file_path: string; description: string }[];
  } {
    const db = getDb();

    const symbols = db
      .prepare(`
        SELECT
          s.name,
          s.kind,
          f.path   AS file_path,
          s.start_line,
          s.end_line,
          s.signature,
          f.language
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE s.name LIKE ? OR f.path LIKE ?
        ORDER BY
          CASE WHEN s.name LIKE ? THEN 0 ELSE 1 END,
          s.name
        LIMIT ?
      `)
      .all(
        `%${query}%`,
        `%${query}%`,
        `${query}%`,
        limit
      ) as SymbolSearchResult[];

    const features = db
      .prepare(`
        SELECT name, layer, file_path, description
        FROM features
        WHERE name LIKE ? OR file_path LIKE ? OR description LIKE ?
        LIMIT 10
      `)
      .all(`%${query}%`, `%${query}%`, `%${query}%`) as {
      name: string;
      layer: string;
      file_path: string;
      description: string;
    }[];

    return { symbols, features };
  }

  /**
   * Language breakdown for the list_languages tool.
   */
  getLanguageBreakdown(): LanguageStat[] {
    const allDefs = getAllLanguages();
    const db = getDb();

    const indexed = db
      .prepare(`
        SELECT language, COUNT(*) AS file_count, SUM(symbol_count) AS symbol_count
        FROM files
        WHERE language IS NOT NULL
        GROUP BY language
      `)
      .all() as { language: string; file_count: number; symbol_count: number }[];

    const indexedMap = new Map(indexed.map((r) => [r.language, r]));

    return allDefs.map((def) => {
      const stats = indexedMap.get(def.name);
      return {
        language: def.name,
        displayName: def.displayName,
        file_count: stats?.file_count ?? 0,
        symbol_count: stats?.symbol_count ?? 0,
      };
    });
  }
}
