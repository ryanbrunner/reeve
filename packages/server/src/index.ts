import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { assertContractsConvertible } from '@reeve/shared';
import { config } from './config.js';
import { openDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { reapOrphanedRuns } from './db/queries.js';
import { apiRoutes } from './routes/api.js';

/**
 * Boot order matters. Contracts convert first so a schema JSON Schema can't
 * express crashes startup rather than a run at 2am; the reaper runs before we
 * serve, so no request can observe a run that is "running" with no process.
 */
export function createApp() {
  assertContractsConvertible();

  const db = openDatabase(config.dbFile);
  runMigrations(db);

  const orphans = reapOrphanedRuns(db, new Date());
  if (orphans.length > 0) {
    console.log(`[reeve] reaped ${orphans.length} orphaned run(s) from a previous process:`);
    for (const o of orphans) {
      // Session ids were written before the subprocess existed, so these stay resumable.
      console.log(`         ${o.id} (${o.kind}) session=${o.sessionId?.slice(0, 8) ?? '-'} -> interrupted`);
    }
    // TODO(step 7): also kill orphaned server_command process groups by pid.
  }

  const app = new Hono();
  app.route('/api', apiRoutes(db));
  app.get('/healthz', (c) => c.json({ ok: true }));

  // In production the built frontend is served from the same origin and port.
  // In dev, Vite serves it and proxies /api here, so this is absent and skipped.
  if (existsSync(config.webDist)) {
    const rel = `./${relative(process.cwd(), config.webDist)}`;
    app.use('/*', serveStatic({ root: rel }));
    app.get('*', serveStatic({ path: `${rel}/index.html` }));
  }

  return { app, db };
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isEntry) {
  const { app } = createApp();
  serve({ fetch: app.fetch, port: config.port, hostname: config.hostname }, (info) => {
    console.log(`[reeve] http://${config.hostname}:${info.port}`);
  });
}
