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
import { syncMergedPullRequests } from './pullRequest.js';
import { actionRoutes } from './routes/actions.js';
import { apiRoutes } from './routes/api.js';
import { assetRoutes } from './routes/assets.js';
import { detailRoutes } from './routes/detail.js';
import { runRoutes } from './routes/runs.js';
import { stageRoutes } from './routes/stages.js';
import { EventWriter } from './runs/events.js';
import { listModels } from './runs/models.js';

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

  const writer = new EventWriter(db);

  const app = new Hono();
  app.route('/api', apiRoutes(db, writer));
  app.route('/api/runs', runRoutes(db));
  app.route('/api/cards', actionRoutes(db, writer));
  app.route('/api/cards', stageRoutes(db, writer));
  app.route('/api/cards', detailRoutes(db, writer));
  app.route('/api/assets', assetRoutes(db));
  app.get('/healthz', (c) => c.json({ ok: true }));

  // In production the built frontend is served from the same origin and port.
  // In dev, Vite serves it and proxies /api here, so this is absent and skipped.
  if (existsSync(config.webDist)) {
    const rel = `./${relative(process.cwd(), config.webDist)}`;
    app.use('/*', serveStatic({ root: rel }));
    app.get('*', serveStatic({ path: `${rel}/index.html` }));
  }

  return { app, db, writer };
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isEntry) {
  const { app, db } = createApp();
  // Out here rather than in createApp, which the spikes call and which should
  // not start a CLI each time. Warmed now so the first picker and the first
  // pinned run do not wait on it.
  void listModels();
  serve({ fetch: app.fetch, port: config.port, hostname: config.hostname }, (info) => {
    console.log(`[reeve] http://${config.hostname}:${info.port}`);
  });

  // Here rather than in createApp, so the spikes that build an app do not
  // shell out to GitHub. Nothing may escape: a rejection would end the server.
  const syncMerges = () => {
    syncMergedPullRequests(db).catch((e) => console.error(`[reeve] merge sync failed: ${String(e)}`));
  };
  syncMerges();
  setInterval(syncMerges, config.mergeSyncMs);
}
