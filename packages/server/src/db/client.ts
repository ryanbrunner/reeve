import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

export function openDatabase(file: string) {
  // data/ is gitignored, so a fresh clone has no directory for SQLite to create the file in.
  mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  // WAL so the SSE readers never block the writer.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof openDatabase>;
