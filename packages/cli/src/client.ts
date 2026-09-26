import {
  DEFAULT_PORT,
  type ApiCard,
  type ApiCardEvent,
  type ApiCardRef,
  type ApiCommit,
  type ApiDiff,
  type ApiCriterion,
  type ApiError,
  type ApiQuestion,
  type ApiRepo,
  type ApiSettings,
  type ApiRunSummary,
  type BoardResponse,
  type CardDetail,
  type CreateCardBody,
  type CreateRepoBody,
  type ModelsResponse,
  type MoveCardBody,
  type ResolveConflictsResponse,
  type Stage,
  type UpdateRepoBody,
  type UpdateSettingsBody,
} from '@reeve/shared';
import { CliError } from './output.js';

/**
 * The CLI is a client of the running server, never of the database. The
 * server holds live runs in memory, and a second process opening the database
 * would reap them on the way in — the same reason the spikes are told to keep
 * off `data/reeve.db`.
 */

/** Where `reeve serve` would listen. Always loopback: that is all the server binds. */
export const localUrl = (port = Number(process.env.REEVE_PORT ?? DEFAULT_PORT)) => `http://127.0.0.1:${port}`;

/** Where the client commands look for Reeve. `REEVE_URL` wins over `REEVE_PORT`. */
export function baseUrl(): string {
  return (process.env.REEVE_URL ?? localUrl()).replace(/\/+$/, '');
}

/** The board, opened on one card — what a command prints so the card is a click away. */
export const cardUrl = (id: string) => `${baseUrl()}/?card=${encodeURIComponent(id)}`;

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

/**
 * One request, answered or refused. Handed back whole rather than parsed,
 * because a run's transcript is read as a stream and never as JSON.
 */
async function send(path: string, init?: RequestInit): Promise<Response> {
  const url = baseUrl();
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, init);
  } catch (e) {
    // `reeve serve` is the launcher the sibling serve card adds; the CLI names
    // it rather than `npm start`, which only works from inside Reeve's checkout.
    if (isRefused(e)) throw new CliError(`Reeve isn't running at ${url} — start it with \`reeve serve\``);
    throw new CliError(`could not reach Reeve at ${url}: ${describe(e)}`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Partial<ApiError>;
    // The same message the web UI shows: `detail` is the sentence worth reading.
    const message = body.detail ? `${body.error}: ${readable(body.detail)}` : body.error;
    throw new CliError(message ?? `HTTP ${res.status} from ${path}`);
  }
  return res;
}

/**
 * Whether something is already answering as Reeve. `serve` must be sure before
 * it boots: booting reaps every run the database still calls live, so a second
 * server over a running one interrupts its runs and only then fails on the port.
 */
export async function isRunning(url = baseUrl()): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/board`);
    return res.ok;
  } catch {
    return false;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init);
  // Something else on the port, such as Vite's dev server or a Reeve from
  // another checkout, can answer 200 with HTML. That is worth a sentence, not
  // a SyntaxError's stack.
  try {
    return (await res.json()) as T;
  } catch {
    throw new CliError(`${baseUrl()}${path} did not answer with JSON — is that Reeve's server?`);
  }
}

const post = <T>(path: string, body: unknown) => write<T>('POST', path, body);

/** Anything that changes a card. A body is sent only when there is one. */
const write = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

/** `PATCH /cards/:id`. Every field is optional; null clears the card's own model, effort or repo. */
export interface UpdateCardBody {
  title?: string;
  body?: string;
  repoId?: string | null;
  model?: string | null;
  effort?: string | null;
  generateMockups?: boolean;
}

const enc = encodeURIComponent;

/** What the routes answer with. Not in @reeve/shared because only the routes and their callers use them. */
export interface StartRunResponse {
  ok: true;
  runId: string;
  sessionId: string;
}

export interface ApproveResponse {
  ok: true;
  fromStage: Stage;
  toStage: Stage;
  /** False only when approving in Done, which has nowhere to go. */
  moved: boolean;
}

export interface RejectResponse {
  ok: true;
  stage: Stage;
  revisionRunId: string;
  forkedFrom: string | null;
}

/** See `AnswerResult` in the server's answers.ts. */
export interface AnswerResponse {
  ok: true;
  answered: number;
  of: number;
  resumed: string | null;
  blocked?: string;
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
  runs: (id: string) => request<ApiRunSummary[]>(`/api/cards/${enc(id)}/runs`),
  card: (id: string) => request<ApiCard>(`/api/cards/${enc(id)}`),
  run: (id: string) => request<ApiRunSummary>(`/api/runs/${enc(id)}`),

  startRun: (cardId: string) => post<StartRunResponse>(`/api/cards/${enc(cardId)}/run`, {}),
  approve: (cardId: string, notes?: string) =>
    post<ApproveResponse>(`/api/cards/${enc(cardId)}/review`, { decision: 'approved', notes }),
  reject: (cardId: string, notes: string) =>
    post<RejectResponse>(`/api/cards/${enc(cardId)}/review`, { decision: 'rejected', notes }),
  questions: (cardId: string) => request<ApiQuestion[]>(`/api/cards/${enc(cardId)}/questions`),
  answer: (cardId: string, questionId: string, answer: string) =>
    post<AnswerResponse>(`/api/cards/${enc(cardId)}/questions/${enc(questionId)}/answer`, { answer }),
  stopRun: (runId: string) => post<ApiRunSummary>(`/api/runs/${enc(runId)}/stop`, {}),

  /** The run's transcript from after `since`, live until the run ends. See ./sse.ts. */
  events: (runId: string, since: number) =>
    send(`/api/runs/${enc(runId)}/events?since=${since}`, { headers: { accept: 'text/event-stream' } }),

  createCard: (body: CreateCardBody) => write<ApiCard>('POST', '/api/cards', body),
  updateCard: (id: string, body: UpdateCardBody) => write<ApiCard>('PATCH', `/api/cards/${enc(id)}`, body),
  /** The card it answers with has `repoName: null`; take that from the board. */
  moveCard: (id: string, body: MoveCardBody) => write<ApiCard>('POST', `/api/cards/${enc(id)}/move`, body),
  archiveCard: (id: string) => write<{ ok: true }>('POST', `/api/cards/${enc(id)}/archive`),
  restoreCard: (id: string) => write<ApiCard>('POST', `/api/cards/${enc(id)}/restore`),
  splitProject: (id: string) => write<{ ok: true; runId: string }>('POST', `/api/cards/${enc(id)}/split`),

  criteria: (id: string) => request<ApiCriterion[]>(`/api/cards/${enc(id)}/criteria`),
  addCriterion: (id: string, text: string) => write<ApiCriterion>('POST', `/api/cards/${enc(id)}/criteria`, { text }),
  deleteCriterion: (id: string, criterionId: string) =>
    write<{ ok: true }>('DELETE', `/api/cards/${enc(id)}/criteria/${enc(criterionId)}`),

  addRef: (id: string, body: Pick<ApiCardRef, 'kind' | 'value'>) =>
    write<ApiCardRef>('POST', `/api/cards/${enc(id)}/refs`, body),
  addNote: (id: string, body: string) => write<ApiCardEvent>('POST', `/api/cards/${enc(id)}/notes`, { body }),

  /** Made, or the healthy one already there. `setupRunId` only on the first. */
  createWorktree: (id: string) =>
    write<{ ok: true; reused: boolean; path: string; branch?: string; setupRunId?: string | null }>(
      'POST',
      `/api/cards/${enc(id)}/worktree`,
      {},
    ),
  /** `forced` is true when the tree had uncommitted work, which went with it. */
  removeWorktree: (id: string) => write<{ ok: true; forced: boolean }>('DELETE', `/api/cards/${enc(id)}/worktree`),
  openPr: (id: string) =>
    write<{ ok: true; url: string; number: number; reused: boolean }>('POST', `/api/cards/${enc(id)}/pr`, {}),
  resolveConflicts: (id: string) =>
    write<ResolveConflictsResponse>('POST', `/api/cards/${enc(id)}/resolve-conflicts`, {}),
  startServer: (id: string) =>
    // `url` is null until the server has said where it is, unless the repo's
    // template or a `{{port}}` in its command already did.
    write<{ ok: true; runId: string; port: number | null; url: string | null }>(
      'POST',
      `/api/cards/${enc(id)}/server`,
      {},
    ),
  stopServer: (id: string) => write<{ ok: true }>('DELETE', `/api/cards/${enc(id)}/server`),
  diff: (id: string) => request<ApiDiff>(`/api/cards/${enc(id)}/diff`),
  commits: (id: string) => request<ApiCommit[]>(`/api/cards/${enc(id)}/commits`),

  createRepo: (body: CreateRepoBody) => write<ApiRepo>('POST', '/api/repos', body),
  updateRepo: (id: string, body: UpdateRepoBody) => write<ApiRepo>('PATCH', `/api/repos/${enc(id)}`, body),

  settings: () => request<ApiSettings>('/api/settings'),
  updateSettings: (body: UpdateSettingsBody) => write<ApiSettings>('PATCH', '/api/settings', body),
  /** Slow only on the first call after the server boots, which asks the Claude CLI. */
  models: () => request<ModelsResponse>('/api/models'),
};
