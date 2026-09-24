import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import type { Db } from './client.js';

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: config.migrationsFolder });
}
