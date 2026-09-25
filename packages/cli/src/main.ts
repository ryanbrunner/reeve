import { DEFAULT_PORT } from '@reeve/shared';
import { add } from './commands/add.js';
import { card } from './commands/card.js';
import { list } from './commands/list.js';
import { move } from './commands/move.js';
import { open } from './commands/open.js';
import { serve } from './commands/serve.js';
import { models, settings } from './commands/settings.js';
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

  reeve card worktree [<card>] [--remove]
      Print the card's worktree path, making it first if need be. --remove
      deletes it, uncommitted work included; the branch stays.
  reeve card pr [<card>]
      Push a Done card's branch and open its pull request, or push to the open one.
  reeve card resolve-conflicts [<card>]
      Merge the base branch into a Done card's branch; Claude resolves any conflicts.
  reeve card server [<card>] [--stop]
      Start the repo's dev server in the card's worktree and print its URL.
  reeve card diff [<card>] [--stat]
      What the card has changed since its worktree was made.
  reeve card commits [<card>]
      The card's commits, newest first.

  reeve settings [--json]
      Reeve's settings: the run cap, SICKO MODE, and each stage's model and effort.
  reeve settings set <key> <value> [--json]
  reeve settings unset <stage>.model|<stage>.effort [--json]
      Change one. Keys: max-concurrent-runs, or <stage>.model or <stage>.effort
      for planning, in-progress or testing. Unset goes back to the default.
  reeve models [--json]
      The models the Claude CLI offers, for <stage>.model.

<card>   142, #142, <repo>#142, or a card id or prefix of one. Where it is
         optional, leaving it out means the card whose worktree you are in.
<stage>  backlog, planning, in-progress, testing or done

--json, which the card actions and settings all take, puts JSON alone on stdout; messages
go to stderr.
Commands other than serve talk to $REEVE_URL, else http://127.0.0.1:$REEVE_PORT (${DEFAULT_PORT}).`;

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  serve, list, add, move, show, open, card, settings, models,
};

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
