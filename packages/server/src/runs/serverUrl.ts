/**
 * Where a card's dev server can be reached, told rather than guessed.
 *
 * Reeve used to pick a port, put it in `PORT`, and link to
 * `http://localhost:<that port>` whether or not the server read it. Next and
 * Puma do; Vite does not, and binds 5173 whatever it is told — so the link
 * went to a dead port and Testing waited a minute on it. Now the URL comes
 * only from something that knows: the repo's template, a `{{port}}` the
 * command itself was handed, or the address the server prints.
 *
 * The variables are few and strict on purpose. `renderPrompt` blanks a name
 * it does not know, which is right for a prompt and wrong here: `{{prot}}`
 * blanked out of a URL is a broken link nobody can explain, so the repo form
 * refuses it instead (`unknownVars`).
 */

export const SERVER_VARS = ['port', 'worktree', 'slug'] as const;
export type ServerVar = (typeof SERVER_VARS)[number];
export type ServerVars = Partial<Record<ServerVar, string>>;

/**
 * Only a plain identifier is a variable. A Go template in a command —
 * `docker ps --format '{{.Names}}'` — is left exactly as written.
 */
const VAR = /\{\{([A-Za-z_]\w*)\}\}/g;

/**
 * The card's names, in forms safe anywhere: digits or `[a-z0-9-]`, so a
 * command needs no quoting around them and a host name no escaping.
 *
 * `worktree` is the directory `worktreePathFor` names, the card id's first
 * eight characters. `slug` is the branch without `reeve/`, cut to a DNS
 * label's 63; `branchNameFor` already makes it safe, but a branch Reeve did
 * not name may not be. Takes the branch separately because the setup command
 * runs before the card row has it.
 */
export function serverVars(cardId: string, branchName: string | null, port?: number): ServerVars {
  const worktree = cardId.slice(0, 8).toLowerCase();
  const slug =
    (branchName ?? '')
      .replace(/^reeve\//, '')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .slice(0, 63)
      .replace(/^-+|-+$/g, '') || worktree;
  return { worktree, slug, ...(port != null ? { port: String(port) } : {}) };
}

/** The same names for a command's environment, where a script can read them. */
export function serverEnv(vars: ServerVars): Record<string, string> {
  return {
    ...(vars.worktree ? { REEVE_WORKTREE: vars.worktree } : {}),
    ...(vars.slug ? { REEVE_SLUG: vars.slug } : {}),
  };
}

/** Replace the variables it has; anything else stays as written. */
export function fillVars(text: string, vars: ServerVars): string {
  return text.replace(VAR, (whole, name: string) => (isServerVar(name) ? (vars[name] ?? whole) : whole));
}

/** Whether `text` names this variable, by the same rule `fillVars` fills it. */
export function usesVar(text: string, name: ServerVar): boolean {
  return [...text.matchAll(VAR)].some((m) => m[1] === name);
}

/** Every `{{identifier}}` that is not one of ours, once each, for the error. */
export function unknownVars(text: string): string[] {
  const names = [...text.matchAll(VAR)].map((m) => m[1]!).filter((n) => !isServerVar(n));
  return [...new Set(names)];
}

function isServerVar(name: string): name is ServerVar {
  return (SERVER_VARS as readonly string[]).includes(name);
}

/**
 * The address a server printed about itself, if the line has one on this
 * machine.
 *
 * Covers what the common ones say: Vite's `Local:   http://localhost:5174/`,
 * Next's `- Local: http://localhost:3000`, Puma's `Listening on
 * http://127.0.0.1:3000`. Colour codes go first, because Vite bolds the port
 * in the middle of the URL. Only loopback counts: a banner also links to docs
 * and changelogs, and Vite's `Network:` line is a LAN address a person did
 * not ask to serve on. `0.0.0.0` is where a server listens, not somewhere a
 * browser can go, so it reads as localhost.
 *
 * Unlike crit.ts, which takes the first URL of any kind: crit prints one, and
 * it is always the right one.
 */
export function announcedUrl(line: string): string | null {
  const plain = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  for (const [candidate] of plain.matchAll(/https?:\/\/[^\s'"<>]+/g)) {
    let url: URL;
    try {
      url = new URL(candidate.replace(/[.,;:)\]]+$/, ''));
    } catch {
      continue;
    }
    if (!isLoopback(url.hostname)) continue;
    if (url.hostname === '0.0.0.0') url.hostname = 'localhost';
    // `new URL` adds a trailing slash to a bare origin, which the Rail would
    // then show; the server's own spelling is kept otherwise.
    return url.pathname === '/' && !url.search ? url.origin : url.toString();
  }
  return null;
}

function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}
