import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openBrowser } from '../browser.js';
import { isRunning, localUrl } from '../client.js';
import { CliError, note, parseCount, parseOrUsage } from '../output.js';

/**
 * `reeve`: open the board, starting Reeve first if nothing is listening.
 *
 * The probe comes first and must be right. Booting reaps every run the
 * database still calls live, before the port is even tried — so a second
 * server over a running one would interrupt its runs and only then fail.
 *
 * The options beyond `--port` only ever become environment variables, so
 * `config.ts` stays the one source for a setting and `--db f` and `REEVE_DB=f`
 * are the same server. Paths resolve against where the command was typed,
 * as whoever typed them meant, rather than wherever the server looks.
 */
export async function serve(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        db: { type: 'string' },
        assets: { type: 'string' },
        'max-concurrent': { type: 'string' },
      },
    }),
  );
  const port = values.port === undefined ? undefined : parseCount('port', values.port);
  const url = localUrl(port);

  if (await isRunning(url)) {
    note(`Reeve is already running at ${url}`);
    if (!values['no-open']) openBrowser(url);
    return;
  }

  // Before the server is imported below, because `config.ts` reads the
  // environment as it is imported and never again.
  if (port !== undefined) process.env.REEVE_PORT = String(port);
  if (values.db !== undefined) process.env.REEVE_DB = resolve(values.db);
  if (values.assets !== undefined) process.env.REEVE_ASSETS = resolve(values.assets);
  if (values['max-concurrent'] !== undefined) {
    process.env.REEVE_MAX_CONCURRENT = String(parseCount('max-concurrent', values['max-concurrent']));
  }

  // Imported only now: the server brings SQLite, the Agent SDK and Playwright,
  // and no other command needs them.
  const { config, startServer } = await import('@reeve/server');
  // `npm run dev` serves the frontend from Vite, so the server treats a
  // missing build as normal. Here it would be a blank page. Which fix makes
  // sense depends on whether `config.root` is a checkout or an install — the
  // same test `config.ts` uses to place the database — since telling someone
  // to `npm run build` inside a Homebrew Cellar would be nonsense.
  if (!existsSync(config.webDist)) {
    throw new CliError(
      existsSync(resolve(config.root, '.git'))
        ? `the web app has not been built. Run \`npm run build\` in ${config.root}, then \`reeve\` again.`
        : `this install of Reeve is missing its web app (${config.webDist}). Reinstall Reeve.`,
    );
  }

  let listening: string;
  try {
    listening = await startServer({ port });
  } catch (e) {
    throw new CliError(`could not start Reeve on ${url}: ${(e as Error).message}`);
  }
  if (!values['no-open']) openBrowser(listening);
}
