import { DEFAULT_PORT } from '@reeve/shared';
import { cardCommands } from './commands/card.js';
import { runCommands } from './commands/run.js';
import { EXIT } from './exit.js';
import { CliError, note, print, usageError } from './output.js';

const USAGE = `Usage: reeve <card|run> <command> [options]

  reeve card run <card> [--follow] [--json]
      Start the card's stage. Prints the run id.
  reeve card approve <card> [--notes TEXT | --notes-file PATH|-] [--json]
      Pass the review gate: the card moves on one column and its next stage starts.
  reeve card reject <card> (--notes TEXT | --notes-file PATH|-) [--follow] [--json]
      Send the stage back. The notes are the next run's prompt. Prints the run id.
  reeve card questions <card> [--json]
      What the stage's run asked, and what has been answered.
  reeve card answer <card> <question> (<answer…> | --suggestion N) [--json]
      Answer one, by its number or id. The last answer resumes the run and prints its id.
  reeve card wait <card> [--timeout SECONDS] [--json]
      Block until the card needs a person, and exit saying why (below).
  reeve run follow <run> [--json]
      The run's transcript, from the start, until it ends.
  reeve run stop <run> [--json]
      Stop a run.

<card>   its id, the start of its id, 142, #142 or <repo>#142

Exit codes. wait ends with the first that applies; follow uses the same for how its run ended.
  ${EXIT.ok}  wait: the run finished and awaits review    follow: the run succeeded
  ${EXIT.error}  something went wrong: Reeve unreachable, no such card, the server refused
  ${EXIT.usage}  the command line was wrong
  ${EXIT.needsInput}  wait: Claude asked questions (reeve card questions)
  ${EXIT.failed}  wait: the stage's run failed or was interrupted    follow: the run did
  ${EXIT.idle}  wait: nothing running or waiting — Backlog, Done, stopped, or refused a start
     follow: the run was stopped
  ${EXIT.timeout}  wait: --timeout ran out with the card still running

Nothing here approves on its own. --follow streams the run a command started, as run follow does.
--json puts JSON alone on stdout (one event per line for follow); messages go to stderr.
Talks to $REEVE_URL, else http://127.0.0.1:$REEVE_PORT (${DEFAULT_PORT}).`;

const GROUPS: Record<string, Record<string, (args: string[]) => Promise<void>>> = {
  card: cardCommands,
  run: runCommands,
};

async function main(argv: string[]): Promise<void> {
  const [group, command, ...rest] = argv;
  if (group === undefined || group === 'help' || argv.includes('--help') || argv.includes('-h')) return print(USAGE);
  const commands = Object.hasOwn(GROUPS, group) ? GROUPS[group] : undefined;
  if (!commands) throw usageError(`unknown command '${group}'`);
  const run = command !== undefined && Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (!run) throw usageError(command === undefined ? `reeve ${group} needs a command` : `unknown command '${group} ${command}'`);
  return run(rest);
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CliError)) throw e;
  note(`reeve: ${e.message}`);
  if (e.exitCode === EXIT.usage) note(`\n${USAGE}`);
  process.exitCode = e.exitCode;
}
