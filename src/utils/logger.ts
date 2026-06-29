import pino from 'pino';
import * as os from 'os';
import * as path from 'path';

const level = process.env.LOG_LEVEL ?? 'info';

// Write logs to a temp file to completely isolate from MCP stdio.
// process.cwd() may be '/' (read-only) when spawned by an IDE, so we use
// the OS temp directory which is always writable.

const logFilePath = process.env.LOG_FILE ?? path.join(os.tmpdir(), 'continuum.log');

// added this to test file touches
export const logger = pino(
  {
    level,
    base: { service: 'continuum' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination({ dest: logFilePath, sync: true })
);
