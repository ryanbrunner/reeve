import { DEFAULT_PORT } from '@reeve/shared';
import { add } from './commands/add.js';
import { list } from './commands/list.js';
import { move } from './commands/move.js';
import { open } from './commands/open.js';
import { serve } from './commands/serve.js';
import { show } from './commands/show.js';
import { CliError, note, print, usageError } from './output.js';

const USAGE = `Usage: reeve [command] [options]

  reeve [serve] [--port N] [--no-open]
      Start Reeve and open the board, or just open it if Reeve is running.
  reeve list [--stage S] [--repo NAME] [--json]
      The board, column by column.
  reeve add <title> [--body TEXT | --body-file PATH|-] [--repo NAME] [--stage S] [--json]
      A new card, in the repo you are in unless --repo says otherwise.
  reeve move <card> <stage> [--index N] [--json]
      Move a card to the end of a column, or to slot N in it.
  reeve show [<card>] [--json]
      A card in full. With no card, the one whose worktree you are in.
  reeve open [<card>]
      Open the board, or a card on it, in the browser.

<card>   142, #142, <repo>#142, or a card id or prefix of one
<stage>  backlog, planning, in-progress, testing or done

--json puts JSON alone on stdout; messages go to stderr.
Commands other than serve talk to $REEVE_URL, else http://127.0.0.1:$REEVE_PORT (${DEFAULT_PORT}).`;

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = { serve, list, add, move, show, open };

async function main(argv: string[]): Promise<void> {
  const [first] = argv;
  if (first === 'help' || argv.includes('--help') || argv.includes('-h')) return print(USAGE);
  // Bare `reeve`, and `reeve --no-open`, are serve.
  if (first === undefined || first.startsWith('-')) return serve(argv);
  const command = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
  if (!command) throw usageError(`unknown command '${first}'`);
  return command(argv.slice(1));
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CliError)) throw e;
  note(`reeve: ${e.message}`);
  if (e.exitCode === 2) note(`\n${USAGE}`);
  process.exitCode = e.exitCode;
}
