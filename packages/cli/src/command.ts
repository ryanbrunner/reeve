import { CliError, print, usageError } from './output.js';

/**
 * One thing `reeve` can be asked to do, and the lines of help that say how.
 * A command whose usage is empty is left out of the help: it is there only to
 * answer a verb someone will reasonably try, with why it is not one.
 */
export interface Command {
  usage: string;
  run: (args: string[]) => Promise<void>;
  /** A group answers `--help` itself, for whichever of its verbs was named. */
  isGroup?: boolean;
}

/** A usage mistake gets the help of the innermost command it came from, and no other. */
function withUsage(e: unknown, usage: string): unknown {
  if (e instanceof CliError && e.exitCode === 2 && e.usage === null) e.usage = usage;
  return e;
}

/**
 * A noun and its verbs: `reeve card move …` is the `card` group running
 * `move`. Groups nest, so `reeve card criteria add` is a group in a group.
 */
export function group(name: string, commands: Record<string, Command>): Command {
  const usage = Object.values(commands)
    .map((c) => c.usage)
    .filter(Boolean)
    .join('\n');
  return {
    usage,
    isGroup: true,
    async run(args) {
      const [verb, ...rest] = args;
      if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') return print(usage);
      const command = Object.hasOwn(commands, verb) ? commands[verb] : undefined;
      if (!command) throw withUsage(usageError(`unknown command '${name} ${verb}'`), usage);
      if (!command.isGroup && command.usage && (rest.includes('--help') || rest.includes('-h'))) {
        return print(command.usage);
      }
      try {
        await command.run(rest);
      } catch (e) {
        throw withUsage(e, command.usage || usage);
      }
    },
  };
}
