import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

export function openDatabase(file: string) {
  // SQLite will not make the directory it is asked to create the file in: a
  // fresh clone has no data/, since it is gitignored, and an installed copy's
  // first run has no ~/.reeve. This is what creates either.
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
