import { existsSync } from 'node:fs';
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
 */
export async function serve(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() =>
    parseArgs({ args, options: { port: { type: 'string' }, 'no-open': { type: 'boolean' } } }),
  );
  const port = values.port === undefined ? undefined : parseCount('port', values.port);
  const url = localUrl(port);

  if (await isRunning(url)) {
    note(`Reeve is already running at ${url}`);
    if (!values['no-open']) openBrowser(url);
    return;
  }

  // Imported only now: the server brings SQLite, the Agent SDK and Playwright,
  // and no other command needs them.
  const { config, startServer } = await import('@reeve/server');
  // `npm run dev` serves the frontend from Vite, so the server treats a
  // missing build as normal. Here it would be a blank page.
  if (!existsSync(config.webDist)) {
    throw new CliError(`the web app has not been built. Run \`npm run build\` in ${config.root}, then \`reeve\` again.`);
  }

  let listening: string;
  try {
    listening = await startServer({ port });
  } catch (e) {
    throw new CliError(`could not start Reeve on ${url}: ${(e as Error).message}`);
  }
  if (!values['no-open']) openBrowser(listening);
}
