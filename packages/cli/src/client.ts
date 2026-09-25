import {
  DEFAULT_PORT,
  type ApiCard,
  type ApiError,
  type ApiRepo,
  type ApiRunSummary,
  type BoardResponse,
  type CardDetail,
} from '@reeve/shared';
import { CliError } from './output.js';

/**
 * The CLI is a client of the running server, never of the database. The
 * server holds live runs in memory, and a second process opening the database
 * would reap them on the way in — the same reason the spikes are told to keep
 * off `data/reeve.db`.
 */

/** Always loopback unless `REEVE_URL` says otherwise: that is all the server binds. */
export function baseUrl(): string {
  const port = Number(process.env.REEVE_PORT ?? DEFAULT_PORT);
  return (process.env.REEVE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
}

/**
 * Nothing listening, as opposed to something listening and failing. Worth
 * telling apart because the first has one fix — start Reeve — and the second
 * does not.
 */
function isRefused(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string; errors?: Array<{ code?: string }> } })?.cause;
  if (!cause) return false;
  if (cause.code === 'ECONNREFUSED') return true;
  // `localhost` tries each address it resolves to, and reports them together.
  return !!cause.errors?.length && cause.errors.every((err) => err.code === 'ECONNREFUSED');
}

/** fetch says only "fetch failed"; what went wrong is on its cause. */
const describe = (e: unknown) => String((e as { cause?: unknown })?.cause ?? e);

async function request<T>(path: string): Promise<T> {
  const url = baseUrl();
  let res: Response;
  try {
    res = await fetch(`${url}${path}`);
  } catch (e) {
    // `reeve serve` is the launcher the sibling serve card adds; the CLI names
    // it rather than `npm start`, which only works from inside Reeve's checkout.
    if (isRefused(e)) throw new CliError(`Reeve isn't running at ${url} — start it with \`reeve serve\``);
    throw new CliError(`could not reach Reeve at ${url}: ${describe(e)}`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Partial<ApiError>;
    // The same message the web UI shows: `detail` is the sentence worth reading.
    const message = body.detail ? `${body.error}: ${body.detail}` : body.error;
    throw new CliError(message ?? `HTTP ${res.status} from ${path}`);
  }
  // Something else on the port, such as Vite's dev server or a Reeve from
  // another checkout, can answer 200 with HTML. That is worth a sentence, not
  // a SyntaxError's stack.
  try {
    return (await res.json()) as T;
  } catch {
    throw new CliError(`${url}${path} did not answer with JSON — is that Reeve's server?`);
  }
}

/**
 * Each of these is one endpoint, answered with the server's own wire type, so
 * `--json` can print what came back without a second shape to keep in step.
 */
export const api = {
  board: () => request<BoardResponse>('/api/board'),
  /** Everything off the board, projects included, most recently archived first. */
  archived: () => request<ApiCard[]>('/api/cards/archived'),
  repos: () => request<ApiRepo[]>('/api/repos'),
  detail: (id: string) => request<CardDetail>(`/api/cards/${encodeURIComponent(id)}/detail`),
  /** Newest first, every kind. An unknown id is an empty list rather than a 404, so resolve it first. */
  runs: (id: string) => request<ApiRunSummary[]>(`/api/cards/${encodeURIComponent(id)}/runs`),
};
