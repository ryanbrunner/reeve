import { spawn } from 'node:child_process';
import { note } from './output.js';

/** Hands the URL to the platform's opener. A failure to open is a note, never an error: the URL still works. */
export function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => note(`Could not open a browser. Reeve is at ${url}`));
  child.unref();
}
