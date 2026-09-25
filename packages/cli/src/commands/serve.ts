import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { connect, health } from '../client.js';
import { UsageError, type Command } from '../command.js';

export const serve: Command = {
  summary: 'Start the server, and the board if it has been built',
  usage: `Usage: reeve serve [options]

Starts Reeve on 127.0.0.1, serving the board from packages/web/dist when
\`npm run build\` has made it. Each option sets the environment variable
beside it, which works just as well on its own.

Options:
  --port <n>            REEVE_PORT            Port to listen on (4317)
  --db <file>           REEVE_DB              SQLite database (data/reeve.db)
  --assets <dir>        REEVE_ASSETS          Mockups and screenshots (data/assets)
  --max-concurrent <n>  REEVE_MAX_CONCURRENT  Claude runs at once, until Settings says otherwise (3)`,

  async run(args) {
    const { values } = parseArgs({
      args,
      options: {
        port: { type: 'string' },
        db: { type: 'string' },
        assets: { type: 'string' },
        'max-concurrent': { type: 'string' },
      },
    });

    // Flags only ever become environment variables: config.ts has one source
    // for its settings, and `--port 5000` and `REEVE_PORT=5000` are the same
    // server. Paths resolve against where the command was typed, as whoever
    // typed them meant, rather than wherever the server happens to look.
    setEnv('REEVE_PORT', wholeNumber('--port', values.port));
    setEnv('REEVE_DB', values.db && resolve(values.db));
    setEnv('REEVE_ASSETS', values.assets && resolve(values.assets));
    setEnv('REEVE_MAX_CONCURRENT', wholeNumber('--max-concurrent', values['max-concurrent']));

    // config.ts reads the environment as it is imported, so the server is
    // imported only now that the flags are in it.
    const { config, startServer } = await import('@reeve/server');

    // Starting reaps every run the database says is running, on the grounds
    // that no process owns it. Run twice against one database, the second
    // server would mark the first one's live runs interrupted before failing
    // to bind, so the common way of doing that is caught before it can.
    const url = `http://${config.hostname}:${config.port}`;
    const alreadyUp = await health(connect(url)).then(
      () => true,
      () => false,
    );
    if (alreadyUp) {
      console.error(`reeve: Reeve is already running at ${url}`);
      return 1;
    }
    // Something else holding the port would otherwise surface as an uncaught
    // EADDRINUSE from serve(), after createApp had already migrated the
    // database and reaped its runs. Found in verification, where port 4400
    // was taken by an unrelated server.
    if (!(await portFree(config.port, config.hostname))) {
      console.error(`reeve: port ${config.port} on ${config.hostname} is in use by something other than Reeve`);
      return 1;
    }

    startServer();
  },
};

/** Takes the port and lets it go at once. Any failure but EADDRINUSE is thrown as it is. */
function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((answer, fail) => {
    const probe = createServer();
    probe.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? answer(false) : fail(e)));
    probe.listen(port, host, () => probe.close(() => answer(true)));
  });
}

function setEnv(name: string, value: string | undefined) {
  if (value !== undefined) process.env[name] = value;
}

function wholeNumber(flag: string, value: string | undefined): string | undefined {
  if (value !== undefined && !/^\d+$/.test(value)) {
    throw new UsageError(`${flag} takes a whole number, not "${value}"`);
  }
  return value;
}
