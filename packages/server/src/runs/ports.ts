import { createServer } from 'node:net';

const BASE = 4400;
const RANGE = 400;

/**
 * A free port per card, so two cards on the same repo can run their dev servers
 * side by side instead of fighting over one.
 *
 * Binds to 127.0.0.1 to test, matching where the child will bind. There is an
 * inherent race between releasing the probe and the child binding, which is why
 * `taken` excludes ports already handed out this process.
 */
export async function findFreePort(taken: ReadonlySet<number> = new Set()): Promise<number> {
  for (let i = 0; i < RANGE; i++) {
    const port = BASE + i;
    if (taken.has(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(`No free port in ${BASE}-${BASE + RANGE}`);
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}
