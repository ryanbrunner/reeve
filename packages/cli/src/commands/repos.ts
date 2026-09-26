import { parseArgs } from 'node:util';
import { api } from '../client.js';
import { parseOrUsage, print, printJson, table, usageError } from '../output.js';

/**
 * The repos cards can be made in. Named rather than numbered in the human
 * output because a name is what `--repo` takes. `--json` is the endpoint's
 * array as it came, commands and budgets included.
 */
export async function repos(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  if (positionals.length > 0) throw usageError('repos takes no arguments');
  const list = await api.repos();
  if (values.json) return printJson(list);
  if (list.length === 0) return print('No repos yet. Add one in Settings.');
  print(table(list.map((r) => [r.name, r.defaultBranch, r.repoPath])).join('\n'));
}
