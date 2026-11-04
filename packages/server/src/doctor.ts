import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { firstLine, installChromiumHint } from './capture/screenshot.js';

export interface DoctorCheck {
  ok: boolean;
  detail: string;
}

/**
 * Whether the native binding this install got actually loads and opens a
 * database. `better-sqlite3` downloads or builds a prebuilt binary at
 * install time, against whatever Node ran the install — Homebrew's, say,
 * rather than whatever a `nvm` shell has active — and a mismatch between
 * the two fails here, in a command meant to be run, rather than silently on
 * the board's first request.
 */
export function checkSqlite(): DoctorCheck {
  try {
    new Database(':memory:').close();
    return { ok: true, detail: 'better-sqlite3 loads and opens a database' };
  } catch (cause) {
    return { ok: false, detail: firstLine(cause) };
  }
}

/** Playwright's own default is three minutes, which `reeve doctor` would sit through. */
const LAUNCH_TIMEOUT_MS = 20_000;

/**
 * Whether Testing has a Chromium to launch for its screenshots. Playwright
 * never downloads one on `npm install` — the download is a separate,
 * explicit step, since a sandboxed install (Homebrew's) cannot reach the
 * network during one — so this is expected to fail on a fresh install, and
 * says the one command that fixes it, the same one `captureTargets` points
 * at when a run hits the same gap.
 */
export async function checkChromium(): Promise<DoctorCheck> {
  try {
    const browser = await chromium.launch({ timeout: LAUNCH_TIMEOUT_MS });
    await browser.close();
    return { ok: true, detail: `chromium launches (${chromium.executablePath()})` };
  } catch (cause) {
    return { ok: false, detail: `${firstLine(cause)}. Run \`${installChromiumHint()}\`.` };
  }
}

const SDK = '@anthropic-ai/claude-agent-sdk';

/**
 * In a checkout, whether the Agent SDK in `node_modules` is the one
 * `package-lock.json` pins. Null in an install, which has no lockfile and
 * got its SDK from `npm install` like everything else.
 *
 * Worth a line of its own because the SDK carries Claude Code itself, and
 * with it what each model alias means and what it can do. A checkout that
 * pulled a lockfile bump without reinstalling kept SDK 0.3.281, where
 * `haiku` was Haiku 4.5 with no auto mode, while the lockfile already said
 * 0.3.296, where it is Haiku 5.5 and takes auto mode: every Haiku run on
 * that board was refused the commands the same card ran fine elsewhere.
 */
export function checkSdkMatchesLock(root: string): (DoctorCheck & { installed: string | null; locked: string }) | null {
  const lockPath = resolve(root, 'package-lock.json');
  if (!existsSync(lockPath)) return null;
  let locked: string | undefined;
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { packages?: Record<string, { version?: string }> };
    locked = lock.packages?.[`node_modules/${SDK}`]?.version;
  } catch {
    return null;
  }
  if (!locked) return null;
  let installed: string | null = null;
  try {
    installed = (JSON.parse(readFileSync(resolve(root, 'node_modules', SDK, 'package.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    // Not installed at all: the mismatch below says so.
  }
  return installed === locked
    ? { ok: true, detail: `${SDK} ${installed}, as package-lock.json pins it`, installed, locked }
    : { ok: false, detail: `${SDK} ${installed ?? 'is not installed'}${installed ? ' is installed' : ''}, but package-lock.json pins ${locked}`, installed, locked };
}
