import { DEFAULT_PORT } from '@reeve/shared';
import { board } from './commands/board.js';
import { card } from './commands/card.js';
import { repos } from './commands/repos.js';
import { runs } from './commands/runs.js';
import { CliError, note, print, usageError } from './output.js';

const USAGE = `Usage: reeve <command> [options]

  reeve board [--repo NAME] [--project TITLE|ID] [--stage S] [--archived] [--json]
      The board, column by column: each card's id, activity, repo, project
      and title, then the projects. --archived lists what is off the board.
  reeve card show <card> [--json]
      A card in full: its facts, criteria, open questions, plan and runs.
  reeve repos [--json]
      The repos cards can be made in.
  reeve runs <card> [--json]
      Every run a card has had, newest first.

<card>   a card's id, or any prefix of it no other card shares. The board
         shows the first 8 characters, which are what its branch is named after.
<stage>  backlog, planning, in-progress, testing or done

--json prints the API's answer unchanged, filtered by any flags given, alone
on stdout. Anything said to a person goes to stderr.

Exit status is 0 on success, 1 when Reeve refused or could not be reached, and
2 for a mistake in the command itself.

Talks to a running Reeve at $REEVE_URL, else http://127.0.0.1:$REEVE_PORT (${DEFAULT_PORT}).`;

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = { board, card, repos, runs };

async function main(argv: string[]): Promise<void> {
  const [first] = argv;
  if (first === undefined || first === 'help' || argv.includes('--help') || argv.includes('-h')) return print(USAGE);
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
