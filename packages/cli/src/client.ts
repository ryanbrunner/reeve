import {
  DEFAULT_PORT,
  type ApiCard,
  type ApiCardEvent,
  type ApiCardRef,
  type ApiCriterion,
  type ApiRunSummary,
  type BoardResponse,
  type CardDetail,
  type CreateCardBody,
  type MoveCardBody,
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
  if (isRefused(e)) return new CliError(`Reeve isn't running at ${url} — start it with \`npm run dev\``);
  return new CliError(`could not reach Reeve at ${url}: ${describe(e)}`);
}

/**
 * A refusal's `detail` as a sentence. Most are one already, but a body that
 * failed its schema carries zod's issues as a JSON array, which reads better
 * as one "field: problem" per issue than as the array.
 */
function readable(detail: string): string {
  try {
    const issues = JSON.parse(detail) as unknown;
    if (Array.isArray(issues) && issues.every((i) => typeof i?.message === 'string')) {
      return (issues as Array<{ message: string; path?: unknown[] }>)
        .map((i) => (i.path?.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
    }
  } catch {
    // Not JSON: already a sentence.
  }
  return detail;
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
    // The server's refusals are passed on as they come; the CLI adds none of its own.
    const message = body.detail ? `${body.error}: ${readable(body.detail)}` : body.error;
    throw new CliError(message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

/** `PATCH /cards/:id`. Every field is optional; null clears the card's own model, effort or repo. */
export interface UpdateCardBody {
  title?: string;
  body?: string;
  repoId?: string | null;
  model?: string | null;
  effort?: string | null;
  generateMockups?: boolean;
}

const card = (id: string) => `/api/cards/${encodeURIComponent(id)}`;

export const api = {
  board: () => request<BoardResponse>('/api/board'),
  archived: () => request<ApiCard[]>('/api/cards/archived'),
  detail: (id: string) => request<CardDetail>(`${card(id)}/detail`),
  runs: (id: string) => request<ApiRunSummary[]>(`${card(id)}/runs`),

  createCard: (body: CreateCardBody) => send<ApiCard>('POST', '/api/cards', body),
  updateCard: (id: string, body: UpdateCardBody) => send<ApiCard>('PATCH', card(id), body),
  /** The card it answers with has `repoName: null`; take that from the board. */
  moveCard: (id: string, body: MoveCardBody) => send<ApiCard>('POST', `${card(id)}/move`, body),
  archiveCard: (id: string) => send<{ ok: true }>('POST', `${card(id)}/archive`),
  restoreCard: (id: string) => send<ApiCard>('POST', `${card(id)}/restore`),
  splitProject: (id: string) => send<{ ok: true; runId: string }>('POST', `${card(id)}/split`),

  criteria: (id: string) => request<ApiCriterion[]>(`${card(id)}/criteria`),
  addCriterion: (id: string, text: string) => send<ApiCriterion>('POST', `${card(id)}/criteria`, { text }),
  deleteCriterion: (id: string, criterionId: string) =>
    send<{ ok: true }>('DELETE', `${card(id)}/criteria/${encodeURIComponent(criterionId)}`),

  addRef: (id: string, body: Pick<ApiCardRef, 'kind' | 'value'>) => send<ApiCardRef>('POST', `${card(id)}/refs`, body),
  addNote: (id: string, body: string) => send<ApiCardEvent>('POST', `${card(id)}/notes`, { body }),
};
