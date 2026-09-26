import { parseArgs } from 'node:util';
import { baseUrl, isRunning } from '../client.js';
import { note, parseOrUsage, print, printJson } from '../output.js';

/**
 * Whether a Reeve is answering, as a status rather than a sentence: 0 when one
 * is, 1 when none is, so a script can ask before it starts one.
 *
 * Every other command fails the same way when Reeve is down, and says so. This
 * one exists to be asked without that being a failure worth printing.
 */
export async function status(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() =>
    parseArgs({ args, options: { url: { type: 'string' }, json: { type: 'boolean' } } }),
  );
  const url = (values.url ?? baseUrl()).replace(/\/+$/, '');
  const running = await isRunning(url);

  // The exit code is the answer, so "no" is set rather than thrown: a refusal
  // would print `reeve: …` as though the question itself had failed.
  if (!running) process.exitCode = 1;

  if (values.json) return printJson({ running, url });
  if (running) print(`Reeve is running at ${url}`);
  else note(`Reeve isn't running at ${url}`);
}
