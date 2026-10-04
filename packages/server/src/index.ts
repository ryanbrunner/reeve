import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { assertContractsConvertible } from '@reeve/shared';
import { adoptPastedImages } from './assets/pasted.js';
import { ASSET_ROUTE } from './assets/store.js';
import { config } from './config.js';
import { openDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { reapOrphanedRuns } from './db/queries.js';
import { archiveMergedCards, cleanUpArchivedWorktrees, syncMergedPullRequests } from './pullRequest.js';
import { vibesSweep } from './vibes/engine.js';
import { actionRoutes } from './routes/actions.js';
import { apiRoutes } from './routes/api.js';
import { assetRoutes } from './routes/assets.js';
import { detailRoutes } from './routes/detail.js';
import { runRoutes } from './routes/runs.js';
import { sameOriginGuard } from './routes/security.js';
import { stageRoutes } from './routes/stages.js';
import { EventWriter } from './runs/events.js';
import { listModels } from './runs/models.js';
import { seedUsage } from './usage.js';

/**
 * Boot order matters. Contracts convert first so a schema JSON Schema can't
 * express crashes startup rather than a run at 2am; the reaper runs before we
 * serve, so no request can observe a run that is "running" with no process.
 */
export function createApp() {
  assertContractsConvertible();

  const db = openDatabase(config.dbFile);
  runMigrations(db);
  seedUsage(db);

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
  // Ahead of every route: the board is the only thing that should ever reach
  // a mutating one, and this is what tells it apart from another origin or a
  // DNS name rebound to loopback after a browser's own check passed.
  app.use('/api/*', sameOriginGuard);
  app.route('/api', apiRoutes(db, writer));
  app.route('/api/runs', runRoutes(db));
  app.route('/api/cards', actionRoutes(db, writer));
  app.route('/api/cards', stageRoutes(db, writer));
  app.route('/api/cards', detailRoutes(db, writer));
  app.route(ASSET_ROUTE, assetRoutes(db));
  // The paths too, for `reeve doctor`: `reeve serve --db f` sets REEVE_DB in the
  // server's process only, so the doctor's own config can name the wrong file.
  app.get('/healthz', (c) => c.json({ ok: true, dbFile: config.dbFile, assetsDir: config.assetsDir }));

  // In production the built frontend is served from the same origin and port.
  // In dev, Vite serves it and proxies /api here, so this is absent and skipped.
  if (existsSync(config.webDist)) {
    const rel = `./${relative(process.cwd(), config.webDist)}`;
    app.use('/*', serveStatic({ root: rel }));
    app.get('*', serveStatic({ path: `${rel}/index.html` }));
  }

  return { app, db, writer };
}

/**
 * Builds the app and serves it, resolving with the URL once it is listening.
 *
 * Importing this module must never boot anything: the CLI imports it, and a
 * second server would reap the first one's runs before failing to bind. So
 * booting is this call, made by ./main.ts and by `reeve`, and nothing else.
 */
export function startServer({ port = config.port }: { port?: number } = {}): Promise<string> {
  const { app, db, writer } = createApp();

  // Everything past the bind waits for it, so a port already in use leaves no
  // child process or timer holding the failed process open.
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: config.hostname }, (info) => {
      const url = `http://${config.hostname}:${info.port}`;
      console.log(`[reeve] ${url}`);
      // Named at every boot, so an installed user can find their board, and a
      // checkout that took itself for an install (an empty ~/.reeve board where
      // data/ was expected) says so at once rather than looking like data loss.
      console.log(`[reeve] board: ${config.dbFile}`);

      // Out here rather than in createApp, which the spikes call and which should
      // not start a CLI each time. Warmed now so the first picker and the first
      // pinned run do not wait on it.
      void listModels();

      // Out here rather than in createApp, because it writes files, and a spike
      // on a scratch database may still have its assets going to data/assets.
      // Synchronous, so no request lands in the middle of a brief being
      // rewritten, and caught, so a failure costs a log line rather than a
      // server that is otherwise fine.
      try {
        const adopted = adoptPastedImages(db);
        if (adopted > 0) console.log(`[reeve] gave ${adopted} card(s) their own copies of another card's pasted images`);
      } catch (e) {
        console.error(`[reeve] copying pasted images failed: ${String(e)}`);
      }

      // Here rather than in createApp, so the spikes that build an app do not
      // shell out to GitHub. Nothing may escape: a rejection would end the server.
      const syncMerges = () => {
        syncMergedPullRequests(db).catch((e) => console.error(`[reeve] merge sync failed: ${String(e)}`));
      };
      // Beside the sync rather than inside it: a slow `gh` call skips the next
      // sync, and archiving should not wait on it. Synchronous, so a throw here
      // would escape the timer unless caught.
      const archiveMerged = () => {
        try {
          archiveMergedCards(db);
        } catch (e) {
          console.error(`[reeve] archiving merged cards failed: ${String(e)}`);
        }
      };
      // Straight after archiving, so a card taken off the board just now loses
      // its worktree on the same tick. Each tick also retries a removal that
      // failed, or one a restart cut short: the archive route starts one too,
      // and nothing remembers it across a restart.
      const cleanUpWorktrees = () => {
        cleanUpArchivedWorktrees(db, writer).catch((e) =>
          console.error(`[reeve] worktree clean-up failed: ${String(e)}`),
        );
      };
      syncMerges();
      archiveMerged();
      cleanUpWorktrees();
      setInterval(() => {
        syncMerges();
        archiveMerged();
        cleanUpWorktrees();
      }, config.mergeSyncMs);

      // The other half of VIBES MODE. Out here for the same reason: the sweep
      // starts Claude runs and talks to GitHub, and a spike that builds an app
      // should do neither. It reads the switch itself and, while it is off, looks
      // only at cards flagged on their own — a cheap settings read and one small
      // select every couple of seconds, and the price of the switches being rows
      // rather than a process that has to be restarted.
      const sweep = () => {
        vibesSweep(db, writer).catch((e) => console.error(`[reeve] vibes sweep failed: ${String(e)}`));
      };
      setInterval(sweep, config.vibesSweepMs);

      resolve(url);
    });
    server.once('error', reject);
  });
}

export { config };
// For `reeve doctor`: each predicts a failure from beside the code that would have it.
export { accountProbe, type ProbeResult } from './runs/models.js';
export { checkChromium, checkSqlite } from './doctor.js';
export { ghProbe } from './git/github.js';
