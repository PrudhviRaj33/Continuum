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
  private pendingParseQueue: Set<string> = new Set();
  private pendingTouchQueue: Map<string, 'created' | 'modified' | 'deleted'> = new Map();
  private parseTimer: NodeJS.Timeout | null = null;

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

    this.enqueueTouch(filePath, action);
    this.enqueueParse(filePath);
  }

  private enqueueParse(filePath: string): void {
    this.pendingParseQueue.add(filePath);
    this.scheduleQueue();
  }

  private enqueueTouch(filePath: string, action: 'created' | 'modified' | 'deleted'): void {
    if (!this.isInitialScanComplete) return;
    this.pendingTouchQueue.set(filePath, action);
    this.scheduleQueue();
  }

  private scheduleQueue(): void {
    if (this.parseTimer) {
      clearTimeout(this.parseTimer);
    }
    this.parseTimer = setTimeout(() => {
      this.processQueue().catch(err => logger.error({ err }, 'Queue processing error'));
    }, 500);
  }

  private async processQueue(): Promise<void> {
    const files = Array.from(this.pendingParseQueue);
    this.pendingParseQueue.clear();
    
    const touches = Array.from(this.pendingTouchQueue.entries());
    this.pendingTouchQueue.clear();
    
    // Process touches
    if (touches.length > 0) {
      const bulkThreshold = parseInt(process.env.BULK_TOUCH_THRESHOLD || '30', 10);
      if (touches.length <= bulkThreshold) {
        for (const [filePath, action] of touches) {
          this.session.recordFileTouch(filePath, action);
        }
      } else {
        logger.info({ count: touches.length, threshold: bulkThreshold }, 'Bulk operation detected, skipping session touch recording');
      }
    }

    if (files.length === 0) return;
    
    logger.info({ count: files.length }, 'Processing debounced file batch');
    
    // Process files concurrently in chunks to maximize CPU and I/O
    const CHUNK_SIZE = 10;
    for (let i = 0; i < files.length; i += CHUNK_SIZE) {
      const chunk = files.slice(i, i + CHUNK_SIZE);
      await Promise.all(chunk.map(async (file) => {
        try {
          await this.parser.parseFile(file);
        } catch (err) {
          logger.error({ file, err }, 'Parse failed in batch');
        }
      }));
    }
  }

  private handleDelete(filePath: string): void {
    if (!this.isWatchedExtension(filePath)) return;

    logger.debug({ filePath }, 'File deleted');

    this.enqueueTouch(filePath, 'deleted');

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

  /**
   * Force reindex one file or all watched files by resetting their stored hash.
   * Returns the count of files queued for re-parsing.
   */
  async reindex(filePath?: string): Promise<number> {
    const { getDb } = require('../database/Database') as typeof import('../database/Database');
    const db = getDb();

    if (filePath) {
      // Single file: reset hash and re-parse immediately
      db.prepare("UPDATE files SET hash = 'force-reindex' WHERE path = ?").run(filePath);
      await this.parser.parseFile(filePath);
      logger.info({ filePath }, 'Force reindexed single file');
      return 1;
    }

    // All files: reset hashes and re-enqueue via watcher paths
    const result = db.prepare("UPDATE files SET hash = 'force-reindex'").run();
    const count = result.changes;

    // Re-enqueue all tracked files for parsing
    const files = db
      .prepare('SELECT path FROM files')
      .all() as { path: string }[];

    for (const f of files) {
      this.pendingParseQueue.add(f.path);
    }
    this.scheduleQueue();

    logger.info({ count }, 'Force reindex queued for all files');
    return count;
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close().catch(() => {});
      logger.info('FileWatcher stopped');
    }
  }
}
