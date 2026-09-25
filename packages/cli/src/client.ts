import {
  DEFAULT_PORT,
  type ApiCard,
  type ApiCommit,
  type ApiDiff,
  type ApiRepo,
  type ApiSettings,
  type BoardResponse,
  type CardDetail,
  type CreateCardBody,
  type CreateRepoBody,
  type ModelsResponse,
  type MoveCardBody,
  type ResolveConflictsResponse,
  type UpdateRepoBody,
  type UpdateSettingsBody,
} from '@reeve/shared';
import { CliError } from './output.js';

/**
 * The CLI is a client of the running server, never of the database. Creating
 * or moving a card starts runs the server holds in memory, and a second
 * process opening the database would reap the live server's runs on the way in.
 */

/** Where `reeve serve` would listen. Always loopback: that is all the server binds. */
export const localUrl = (port = Number(process.env.REEVE_PORT ?? DEFAULT_PORT)) => `http://127.0.0.1:${port}`;

/** Where the client commands look for Reeve. `REEVE_URL` wins over `REEVE_PORT`. */
export function baseUrl(): string {
  return (process.env.REEVE_URL ?? localUrl()).replace(/\/+$/, '');
}

export const cardUrl = (id: string) => `${baseUrl()}/?card=${encodeURIComponent(id)}`;

/**
 * Nothing listening, as opposed to something listening and failing. Only this
 * may be read as "Reeve is not running": `reeve` boots a server on it, and
 * booting reaps every run still marked live in the database.
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

function unreachable(url: string, e: unknown): CliError {
  if (isRefused(e)) return new CliError(`Reeve isn't running at ${url} — start it with \`reeve\``);
  return new CliError(`could not reach Reeve at ${url}: ${describe(e)}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = baseUrl();
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, init);
  } catch (e) {
    throw unreachable(url, e);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    // The same message the web UI shows: `detail` is the sentence worth reading.
    const message = body.detail ? `${body.error}: ${body.detail}` : body.error;
    throw new CliError(message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

export const api = {
  board: () => request<BoardResponse>('/api/board'),
  createCard: (body: CreateCardBody) => post<ApiCard>('/api/cards', body),
  /** The card it answers with has `repoName: null`; take that from the board. */
  moveCard: (id: string, body: MoveCardBody) => post<ApiCard>(`/api/cards/${id}/move`, body),
  detail: (id: string) => request<CardDetail>(`/api/cards/${id}/detail`),

  /** Made, or the healthy one already there. `setupRunId` only on the first. */
  createWorktree: (id: string) =>
    post<{ ok: true; reused: boolean; path: string; branch?: string; setupRunId?: string | null }>(
      `/api/cards/${id}/worktree`,
      {},
    ),
  /** `forced` is true when the tree had uncommitted work, which went with it. */
  removeWorktree: (id: string) => del<{ ok: true; forced: boolean }>(`/api/cards/${id}/worktree`),
  openPr: (id: string) =>
    post<{ ok: true; url: string; number: number; reused: boolean }>(`/api/cards/${id}/pr`, {}),
  resolveConflicts: (id: string) => post<ResolveConflictsResponse>(`/api/cards/${id}/resolve-conflicts`, {}),
  startServer: (id: string) =>
    post<{ ok: true; runId: string; port: number; url: string }>(`/api/cards/${id}/server`, {}),
  stopServer: (id: string) => del<{ ok: true }>(`/api/cards/${id}/server`),
  diff: (id: string) => request<ApiDiff>(`/api/cards/${id}/diff`),
  commits: (id: string) => request<ApiCommit[]>(`/api/cards/${id}/commits`),

  createRepo: (body: CreateRepoBody) => post<ApiRepo>('/api/repos', body),
  updateRepo: (id: string, body: UpdateRepoBody) => patch<ApiRepo>(`/api/repos/${id}`, body),

  settings: () => request<ApiSettings>('/api/settings'),
  updateSettings: (body: UpdateSettingsBody) => patch<ApiSettings>('/api/settings', body),
  /** Slow only on the first call after the server boots, which asks the Claude CLI. */
  models: () => request<ModelsResponse>('/api/models'),
};

/**
 * Whether Reeve answers at `url`. False only when nothing is listening at all;
 * anything else there — a timeout, another program — is an error rather than
 * a reason to boot a second server over it.
 */
export async function isRunning(url: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) });
  } catch (e) {
    if (isRefused(e)) return false;
    throw new CliError(`could not tell whether Reeve is running at ${url}: ${describe(e)}`);
  }
  const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
  if (res.ok && body?.ok === true) return true;
  throw new CliError(`something other than Reeve is answering at ${url} (HTTP ${res.status})`);
}
