import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { baseUrl, isRunning } from '../client.js';
import { EXIT, type ExitCode } from '../exit.js';
import { parseOrUsage, print, printJson, table } from '../output.js';

const exec = promisify(execFile);

/**
 * `reeve doctor`: what a fresh install is missing, one line per thing Reeve
 * relies on, and how to fix whatever is not there.
 *
 * A source checkout picks its requirements up as it goes. Someone who has just
 * installed Reeve gets a board whose first run fails for reasons that are not
 * obvious, and this is where the Homebrew caveats send them.
 *
 * Node, git and Claude credentials are required: without any one of them no
 * stage can run, and the exit status is 1. `gh`, Chromium and the web build
 * only warn, because each serves one feature — pull requests, screenshots,
 * `reeve serve` — and the board works without it. The server and the data
 * paths are information. Like `status`, a failed check is set as the exit
 * status rather than thrown: it is an answer, not a command that broke.
 *
 * The probes that need the Agent SDK, Playwright or `gh` live in the server,
 * beside the code whose failures they predict, and are reached the way
 * `serve` reaches it. Importing the server boots nothing and opens no
 * database; only `createApp()` does that, and this never calls it.
 */

export type CheckLevel = 'required' | 'optional' | 'info';

export interface Check {
  name: string;
  level: CheckLevel;
  status: 'ok' | 'warn' | 'fail' | 'info';
  /** What was found. */
  detail: string;
  /** What to do about it. Null when there is nothing to do. */
  fix: string | null;
}

type Server = typeof import('@reeve/server');

/** Long enough for a cold `git`; nothing here should take longer. */
const GIT_TIMEOUT_MS = 10_000;
const HEALTHZ_TIMEOUT_MS = 5_000;

const GIT_FIX = 'install git: on macOS `xcode-select --install` or `brew install git`, elsewhere https://git-scm.com/downloads';
const CLAUDE_FIX = 'run `claude` and log in, or set ANTHROPIC_API_KEY';
const GH_FIX = 'only pull requests need it: install it from https://cli.github.com if it is missing, then `gh auth login`';

/**
 * A check's line from whether it passed. A required check that did not is a
 * failure, an optional one a warning, and an informational one neither. The
 * fix is kept only where there is something to fix.
 */
export function verdict(name: string, level: CheckLevel, passed: boolean, detail: string, fix: string | null): Check {
  if (level === 'info') return { name, level, status: 'info', detail, fix };
  if (passed) return { name, level, status: 'ok', detail, fix: null };
  return { name, level, status: level === 'required' ? 'fail' : 'warn', detail, fix };
}

/** 1 when a required check failed, and 0 otherwise: a warning is still a board that runs. */
export function exitFor(checks: Check[]): ExitCode {
  return checks.some((c) => c.status === 'fail') ? EXIT.error : EXIT.ok;
}

/**
 * The version `>=X.Y[.Z]` asks for, or null for any other shape. That one
 * shape is all Reeve's `engines.node` has used, and a range this cannot read
 * is reported as unchecked rather than guessed at — no `semver` for one line.
 */
export function engineFloor(range: string): number[] | null {
  const m = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Whether `version` meets `range`. Null when the range is not one `engineFloor` reads. */
export function satisfiesEngine(version: string, range: string): boolean | null {
  const floor = engineFloor(range);
  if (!floor) return null;
  const have = version.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < floor.length; i++) {
    const a = have[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Node against the `engines.node` in Reeve's own package.json. */
export function nodeCheck(version: string, range: string | null): Check {
  if (range === null) {
    return verdict('node', 'required', false, `v${version}, but Reeve's package.json could not be read`, 'reinstall Reeve');
  }
  const meets = satisfiesEngine(version, range);
  if (meets === null) {
    // A warning, not a failure: this is the doctor not knowing, not Node being wrong.
    return { name: 'node', level: 'required', status: 'warn', detail: `v${version}; could not compare with ${range}`, fix: null };
  }
  return verdict(
    'node',
    'required',
    meets,
    `v${version} (Reeve needs ${range})`,
    `install Node ${engineFloor(range)?.join('.')} or newer`,
  );
}

function readEngine(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { engines?: { node?: unknown } };
    return typeof pkg.engines?.node === 'string' ? pkg.engines.node : null;
  } catch {
    return null;
  }
}

/** Errors worth a line, not a paragraph. */
const firstLine = (e: unknown) => {
  const text = e instanceof Error ? e.message : String(e);
  return text.split('\n').find((l) => l.trim())?.trim() ?? text;
};

/** `git --version` from this shell's PATH. Every stage runs in a worktree `git` makes. */
export async function gitCheck(): Promise<Check> {
  try {
    const { stdout } = await exec('git', ['--version'], { timeout: GIT_TIMEOUT_MS });
    return verdict('git', 'required', true, stdout.trim(), null);
  } catch (e) {
    // macOS's /usr/bin/git is a shim that is there without the developer tools,
    // and fails rather than being missing; its own message says as much.
    const missing = (e as { code?: unknown }).code === 'ENOENT';
    return verdict('git', 'required', false, missing ? 'not on PATH' : `\`git --version\` failed: ${firstLine(e)}`, GIT_FIX);
  }
}

/**
 * Where the database and the assets are. A running server says for itself,
 * because `reeve serve --db f` set REEVE_DB in its process and not in this one;
 * otherwise it is where `reeve serve` from this shell would put them. Only
 * ever `existsSync` on the database: opening it is what this must not do.
 */
async function dataCheck(url: string, running: boolean, server: Server | null): Promise<Check> {
  if (running) {
    const said = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS) })
      .then((res) => res.json() as Promise<{ dbFile?: unknown; assetsDir?: unknown }>)
      .catch(() => null);
    if (typeof said?.dbFile === 'string' && typeof said.assetsDir === 'string') {
      return verdict('data', 'info', true, `database ${said.dbFile}, assets ${said.assetsDir} (the running server's)`, null);
    }
  }
  if (!server) {
    return verdict('data', 'info', false, "unknown: Reeve's server could not be loaded, and no running one said", null);
  }
  const { dbFile, assetsDir } = server.config;
  const created = existsSync(dbFile) ? '' : ' (not created yet)';
  // A server from before /healthz carried the paths answers without them.
  const unsaid = running ? ' (the running server did not say where its own are)' : '';
  return verdict(
    'data',
    'info',
    true,
    `database ${dbFile}${created}, assets ${assetsDir}, where \`reeve serve\` from this shell would put them${unsaid}`,
    null,
  );
}

export async function doctor(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() =>
    parseArgs({ args, options: { url: { type: 'string' }, json: { type: 'boolean' } } }),
  );
  const url = (values.url ?? baseUrl()).replace(/\/+$/, '');

  // A broken install — a native module built for another Node, a missing SDK
  // binary — fails right here, and that is itself worth a line rather than a
  // stack trace.
  let server: Server | null = null;
  let broken = '';
  try {
    server = await import('@reeve/server');
  } catch (e) {
    broken = `could not load Reeve's server: ${firstLine(e)}`;
  }
  const unloaded = (name: string, level: CheckLevel) => verdict(name, level, false, broken, 'reinstall Reeve');
  // Where config.ts would say, for a server that would not load.
  const root = server?.config.root ?? resolve(import.meta.dirname, '../../../..');

  const running = isRunning(url);
  // In parallel, printed in this order. The credentials probe starts the
  // Claude CLI and is the slowest by far; its own timeout bounds the command.
  const checks = await Promise.all([
    nodeCheck(process.versions.node, readEngine(root)),
    gitCheck(),
    server ?
      server.accountProbe().then((r) => verdict('claude', 'required', r.ok, `${r.detail}, as this shell sees it`, CLAUDE_FIX))
    : unloaded('claude', 'required'),
    server ? server.ghProbe().then((r) => verdict('gh', 'optional', r.ok, r.detail, GH_FIX)) : unloaded('gh', 'optional'),
    server ?
      server
        .browserProbe()
        .then((r) => verdict('chromium', 'optional', r.ok, r.detail, `only screenshots need it. ${server.INSTALL_CHROMIUM}`))
    : unloaded('chromium', 'optional'),
    server ?
      verdict(
        'web build',
        'optional',
        existsSync(server.config.webDist),
        existsSync(server.config.webDist) ? server.config.webDist : 'the web app has not been built',
        // What `serve` says when it refuses for want of one.
        `only \`reeve serve\` needs it: run \`npm run build\` in ${root}`,
      )
    : unloaded('web build', 'optional'),
    running.then((up) =>
      verdict(
        'server',
        'info',
        up,
        up ? `Reeve is running at ${url}` : `none answers at ${url}`,
        up ? null : 'start it with `reeve serve`',
      ),
    ),
    running.then((up) => dataCheck(url, up, server)),
  ]);

  process.exitCode = exitFor(checks);

  if (values.json) return printJson({ ok: process.exitCode === EXIT.ok, checks });
  const label = { ok: 'ok', warn: 'warn', fail: 'FAIL', info: 'info' } as const;
  for (const line of table(checks.map((c) => [label[c.status], c.name, c.fix ? `${c.detail} — ${c.fix}` : c.detail]))) {
    print(line);
  }
}
