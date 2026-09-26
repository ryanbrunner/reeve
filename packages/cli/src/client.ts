import {
  DEFAULT_PORT,
  type ApiCard,
  type ApiError,
  type ApiQuestion,
  type ApiRepo,
  type ApiRunSummary,
  type BoardResponse,
  type CardDetail,
  type Stage,
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
    const message = body.detail ? `${body.error}: ${body.detail}` : body.error;
    throw new CliError(message ?? `HTTP ${res.status} from ${path}`);
  }
  return res;
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

const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

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
};
