import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { firstLine } from './capture/screenshot.js';

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
    const browser = await chromium.launch();
    await browser.close();
    return { ok: true, detail: `chromium launches (${chromium.executablePath()})` };
  } catch (cause) {
    return { ok: false, detail: `${firstLine(cause)}. Run \`npx playwright install chromium\`.` };
  }
}
