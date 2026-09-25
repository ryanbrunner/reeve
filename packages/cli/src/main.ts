import { UsageError, type Command } from './command.js';
import { serve } from './commands/serve.js';
import { status } from './commands/status.js';

// A Map rather than an object, so `reeve constructor` is an unknown command
// and not a lookup that finds Object's.
const commands = new Map<string, Command>([
  ['serve', serve],
  ['status', status],
]);

const usage = `Usage: reeve <command> [options]

Commands:
${[...commands].map(([name, c]) => `  ${name.padEnd(8)}${c.summary}`).join('\n')}

Run \`reeve <command> --help\` for a command's options.`;

const isHelp = (arg: string | undefined) => arg === '--help' || arg === '-h';

const [name, ...args] = process.argv.slice(2);
const command = name === undefined ? undefined : commands.get(name);

if (name === undefined || name === 'help' || isHelp(name)) {
  console.log(usage);
} else if (!command) {
  console.error(`reeve: no command "${name}"\n\n${usage}`);
  process.exitCode = 2;
} else if (args.some(isHelp)) {
  console.log(command.usage);
} else {
  try {
    // exitCode rather than exit(): `serve` returns with the server still
    // listening, and the process has to be left to run.
    process.exitCode = (await command.run(args)) ?? 0;
  } catch (e) {
    // parseArgs throws for an unknown or malformed flag with an ERR_PARSE_ARGS_*
    // code. That and a UsageError are both the typist's to fix.
    const code = (e as { code?: unknown }).code;
    const isUsage = e instanceof UsageError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS'));
    if (!isUsage) throw e;
    console.error(`reeve ${name}: ${(e as Error).message}\n\n${command.usage}`);
    process.exitCode = 2;
  }
}
