import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'path';
import { SessionEngine } from '../session/SessionEngine';
import { IncrementalParser } from '../parser/IncrementalParser';
import { getAllWatchedExtensions } from '../languages/LanguageRegistry';
import { logger } from '../utils/logger';

const IGNORED_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist/,
  /build/,
  /\.next/,
  /\.nuxt/,
  /target\/debug/,  // Rust
  /target\/release/, // Rust
  /bin\/Debug/,     // .NET
  /bin\/Release/,   // .NET
  /obj\//,          // .NET build artifacts
  /\.angular/,      // Angular cache
  /coverage/,
  /\.nyc_output/,
  /\.db$/,
  /\.db-journal$/,
  /__pycache__/,    // Python
  /\.pytest_cache/,
  /\.venv/,         // Python virtualenv
  /venv/,
  /\.gradle/,       // Java/Kotlin
  /\.idea/,
  /\.vscode/,
];

/**
 * Watches configured paths and triggers incremental parsing on changes.
 * Only watches extensions registered in the LanguageRegistry.
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private readonly session: SessionEngine;
  private readonly parser: IncrementalParser;
  private isInitialScanComplete = false;

  constructor(session: SessionEngine, parser: IncrementalParser) {
    this.session = session;
    this.parser = parser;
  }

  start(watchPaths: string[]): void {
    const resolved = watchPaths.map((p) => path.resolve(p));
    const extensions = getAllWatchedExtensions();

    logger.info({ paths: resolved, languageCount: extensions.length }, 'FileWatcher starting');

    this.watcher = chokidar.watch(resolved, {
      ignored: IGNORED_PATTERNS,
      persistent: true,
      ignoreInitial: false, // Parse existing files on startup
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher
      .on('add', (filePath) => this.handleChange(filePath, 'created'))
      .on('change', (filePath) => this.handleChange(filePath, 'modified'))
      .on('unlink', (filePath) => this.handleDelete(filePath))
      .on('error', (error) => logger.error({ error }, 'FileWatcher error'))
      .on('ready', () => {
        this.isInitialScanComplete = true;
        logger.info('FileWatcher: initial scan complete');
      });
  }

  private isWatchedExtension(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return getAllWatchedExtensions().includes(ext);
  }

  private handleChange(filePath: string, action: 'created' | 'modified'): void {
    if (!this.isWatchedExtension(filePath)) return;

    logger.debug({ filePath, action }, 'File changed');

    // Only record to session AFTER initial scan (avoid polluting session with all existing files)
    if (this.isInitialScanComplete) {
      this.session.recordFileTouch(filePath, action);
    }

    // Always parse for indexing
    this.parser.parseFile(filePath).catch((err) =>
      logger.error({ filePath, err }, 'Parse failed')
    );
  }

  private handleDelete(filePath: string): void {
    if (!this.isWatchedExtension(filePath)) return;

    logger.debug({ filePath }, 'File deleted');

    if (this.isInitialScanComplete) {
      this.session.recordFileTouch(filePath, 'deleted');
    }

    // Remove from database
    const { getDb } = require('../database/Database');
    const db = getDb();
    const file = db
      .prepare('SELECT id FROM files WHERE path = ?')
      .get(filePath) as { id: number } | undefined;

    if (file) {
      db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
      logger.debug({ filePath }, 'Removed deleted file from index');
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close().catch(() => {});
      logger.info('FileWatcher stopped');
    }
  }
}
