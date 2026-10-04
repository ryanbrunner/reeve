import { parseArgs } from 'node:util';
import { note, parseOrUsage, print, printJson } from '../output.js';

/**
 * Whether this install can actually run a stage, not whether a server is
 * listening (`status` answers that). Checked here rather than left to fail on
 * a card's first run: `better-sqlite3`'s native binary has to match whatever
 * Node ran `npm install` — Homebrew's, say, not a shell's `nvm` one — and
 * Playwright never downloads Chromium on install, by design, so a fresh
 * install is expected to be missing it until a person runs the one command
 * this says to.
 *
 * Exits 1 if either check fails, 0 otherwise, same shape as `status`. Nothing
 * in `EXIT` names this: it is not a verdict on a run.
 */
export async function doctor(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() => parseArgs({ args, options: { json: { type: 'boolean' } } }));

  // Imported only now: this is the one CLI command besides `serve` that
  // needs the server's own dependencies, and no other command should pay for
  // loading better-sqlite3 and Playwright just to ask Reeve a question.
  const { checkChromium, checkSqlite } = await import('@reeve/server');
  const sqlite = checkSqlite();
  const chromium = await checkChromium();

  if (!sqlite.ok || !chromium.ok) process.exitCode = 1;

  if (values.json) return printJson({ sqlite, chromium });

  print(`${sqlite.ok ? 'ok  ' : 'FAIL'} sqlite:   ${sqlite.detail}`);
  print(`${chromium.ok ? 'ok  ' : 'FAIL'} chromium: ${chromium.detail}`);
  if (!chromium.ok) {
    note('Testing still runs without Chromium; it reports screenshots as unavailable instead of taking them.');
  }
}
