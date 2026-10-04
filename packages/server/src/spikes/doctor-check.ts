/**
 * Throwaway check: what `reeve doctor`'s probes answer, including the ones a
 * shell here cannot easily arrange — nobody logged in, and only an API key.
 *
 * Builds no app and opens no database, like the doctor itself. The logged-out
 * cases point `CLAUDE_CONFIG_DIR` at an empty directory and drop
 * `ANTHROPIC_API_KEY`, in the CLI's environment only; the key given there is
 * fake, which the probe must still report as found, because it never tries one.
 *
 *     npx tsx packages/server/src/spikes/doctor-check.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkChromium } from '../doctor.js';
import { accountProbe } from '../runs/models.js';
import { ghProbe } from '../git/github.js';

const empty = mkdtempSync(join(tmpdir(), 'reeve-doctor-'));
const { ANTHROPIC_API_KEY: _key, ...keyless } = process.env;

const cases: Array<[string, Promise<{ ok: boolean; detail: string }>, boolean | null]> = [
  // Whatever this machine has; its answer is shown but not judged.
  ['credentials, as this shell has them', accountProbe(), null],
  ['credentials, logged out', accountProbe({ ...keyless, CLAUDE_CONFIG_DIR: empty }), false],
  [
    'credentials, only an API key',
    accountProbe({ ...keyless, CLAUDE_CONFIG_DIR: empty, ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' }),
    true,
  ],
  ['gh', ghProbe(), null],
  ['chromium', checkChromium(), null],
];

let failed = 0;
for (const [name, probe, want] of cases) {
  const got = await probe;
  const wrong = want !== null && got.ok !== want;
  if (wrong) failed++;
  const mark = wrong ? 'FAIL' : want === null ? 'seen' : 'ok  ';
  console.log(`${mark} ${name}: ${got.ok ? 'passes' : 'fails'} — ${got.detail}${wrong ? ` (wanted ${want ? 'a pass' : 'a failure'})` : ''}`);
}
console.log(failed === 0 ? '\nall judged cases pass' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
