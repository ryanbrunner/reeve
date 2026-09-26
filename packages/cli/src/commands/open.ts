import { parseArgs } from 'node:util';
import { openBrowser } from '../browser.js';
import { api, baseUrl, cardUrl } from '../client.js';
import { parseOrUsage, print, usageError } from '../output.js';
import { resolveCard, whereAmI } from '../resolve.js';

/** The board, or one card on it through the `?card=` link the web app reads. */
export async function open(args: string[]): Promise<void> {
  const { positionals } = parseOrUsage(() => parseArgs({ args, allowPositionals: true, options: {} }));
  if (positionals.length > 1) throw usageError('open takes at most one card');
  const [ref] = positionals;

  // Asked even for the bare board, so a stopped server says so instead of
  // opening a tab onto nothing.
  const board = await api.board();
  const url = ref === undefined ? baseUrl() : cardUrl(resolveCard(board, ref, whereAmI(board, process.cwd())).id);
  print(url);
  openBrowser(url);
}
