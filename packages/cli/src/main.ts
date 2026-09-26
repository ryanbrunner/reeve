import { DEFAULT_PORT } from '@reeve/shared';
import { board } from './commands/board.js';
import { card } from './commands/card.js';
import { project } from './commands/project.js';
import { repos } from './commands/repos.js';
import { runCommands } from './commands/run.js';
import { runs } from './commands/runs.js';
import { EXIT } from './exit.js';
import { CliError, note, print, usageError } from './output.js';

const USAGE = `Usage: reeve <command> [options]

  reeve board [--repo NAME] [--project TITLE|ID] [--stage S] [--archived] [--json]
      The board, column by column: each card's id, activity, repo, project
      and title, then the projects. --archived lists what is off the board.
  reeve card show <card> [--json]
      A card in full: its facts, criteria, open questions, plan and runs.
  reeve repos [--json]
      The repos cards can be made in.
  reeve card add <title> / edit / move / note / criteria / archive / restore
      Write a card: the calls the card's modal makes, from a terminal.
      reeve card <verb> --help says what each one takes.
  reeve project add <title>
      A project to file cards under. Editing its brief and archiving it are
      the card commands: a project is a card to the server.
  reeve card run <card> [--follow] [--json]
      Start the stage the card is in. --follow streams the run's transcript.
  reeve card approve <card> [--notes T] / reject <card> --notes T
      The verdict a person gives a finished stage. Approving does not move the
      card; a human does that.
  reeve card questions <card> [--json] / answer <card> <question> <answer>
      What Claude could not decide for itself, and the answer that resumes it.
  reeve card wait <card> [--timeout S] [--json]
      Block until the card's run wants a person, and say which by exit status.
  reeve runs <card> [--json]
      Every run a card has had, newest first.
  reeve run follow <run> [--json] / run stop <run>
      Stream a run already going, or stop it.

<card>   a card's id, or any prefix of it no other card shares. The board
         shows the first 8 characters, which are what its branch is named
         after. The verbs that drive a run also take its number: 142, #142,
         or repo#142 while two repos both have one.
<stage>  backlog, planning, in-progress, testing or done

--json prints the API's answer unchanged, filtered by any flags given, alone
on stdout. Anything said to a person goes to stderr.

Exit status is 0 on success, 1 when Reeve refused or could not be reached, and
2 for a mistake in the command itself. card wait says how the run ended with
a status of its own: ${EXIT.needsInput} questions asked, ${EXIT.failed} the run failed, ${EXIT.idle} nothing
running, ${EXIT.timeout} --timeout ran out.

Talks to a running Reeve at $REEVE_URL, else http://127.0.0.1:$REEVE_PORT (${DEFAULT_PORT}).`;

/** `reeve run <verb>`: what is done to a run already going, rather than to its card. */
async function run(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === undefined) throw usageError(`run needs a verb: ${Object.keys(runCommands).join(', ')}`);
  const go = Object.hasOwn(runCommands, verb) ? runCommands[verb] : undefined;
  if (!go) throw usageError(`unknown run verb '${verb}'`);
  return go(rest);
}

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  board,
  card,
  project: (args) => project.run(args),
  repos,
  run,
  runs,
};

/** The nouns whose verbs carry help of their own, and so answer `--help` themselves. */
const SELF_HELP = new Set(['card', 'project']);

async function main(argv: string[]): Promise<void> {
  const [first] = argv;
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') return print(USAGE);
  const command = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
  if (!command) throw usageError(`unknown command '${first}'`);
  // Everything else takes its help from this page, so `--help` anywhere in the
  // line means the page rather than an unknown flag.
  if (!SELF_HELP.has(first) && (argv.includes('--help') || argv.includes('-h'))) return print(USAGE);
  return command(argv.slice(1));
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CliError)) throw e;
  note(`reeve: ${e.message}`);
  // A verb with help of its own says so on the error; the rest get the page.
  if (e.exitCode === 2) note(`\n${e.usage ?? USAGE}`);
  process.exitCode = e.exitCode;
}
