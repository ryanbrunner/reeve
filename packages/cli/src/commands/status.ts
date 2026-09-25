import { parseArgs } from 'node:util';
import { DEFAULT_URL, connect, health, serverUrl } from '../client.js';
import type { Command } from '../command.js';

export const status: Command = {
  summary: 'Say whether a Reeve server is running',
  usage: `Usage: reeve status [--url <url>]

Exits 0 if a Reeve server answers at the URL and 1 if not, so a script can
ask before it starts one.

Options:
  --url <url>  The server to check. Defaults to $REEVE_URL, then ${DEFAULT_URL}.`,

  async run(args) {
    const { values } = parseArgs({ args, options: { url: { type: 'string' } } });
    const client = connect(serverUrl(values.url));
    try {
      await health(client);
    } catch (e) {
      console.log(`reeve: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    console.log(`Reeve is running at ${client.url}`);
    return 0;
  },
};
