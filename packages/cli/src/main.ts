import { DEFAULT_PORT } from '@reeve/shared';
import type { Command } from './command.js';
import { card } from './commands/card.js';
import { project } from './commands/project.js';
import { CliError, note, print, usageError } from './output.js';

const COMMANDS: Record<string, Command> = { card, project };

const USAGE = `Usage: reeve <command> [options]

${Object.values(COMMANDS).map((c) => c.usage).join('\n')}

<card>     142, #142, <repo>#142, or a card id or prefix of one. The card
           commands also take a project, by its id or its title.
<stage>    backlog, planning, in-progress, testing or done
<repo>     a repo's name or id
<project>  a project's id or prefix of one, or its title

--json puts JSON alone on stdout; messages go to stderr. \`reeve <command> --help\` says more.
Reeve must be running: the CLI talks to $REEVE_URL, else http://127.0.0.1:$REEVE_PORT (${DEFAULT_PORT}).`;

async function main(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') return print(USAGE);
  const command = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
  if (!command) throw usageError(`unknown command '${first}'`);
  return command.run(rest);
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CliError)) throw e;
  note(`reeve: ${e.message}`);
  if (e.exitCode === 2) note(`\n${e.usage ?? USAGE}`);
  process.exitCode = e.exitCode;
}
