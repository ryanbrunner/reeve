import {
  DEFAULT_PORT,
  type ApiCard,
  type ApiQuestion,
  type ApiRunSummary,
  type BoardResponse,
  type Stage,
} from '@reeve/shared';
import { CliError } from './output.js';

/**
 * The CLI is a client of the running server, never of the database. Runs live
 * in the server's memory — their processes, their abort handles, the event bus
 * a transcript streams from — and a second process opening the database would
 * reap the live server's runs on the way in.
 */

/** Where the commands look for Reeve. `REEVE_URL` wins over `REEVE_PORT`; either way it is loopback. */
export function baseUrl(): string {
  const url = process.env.REEVE_URL ?? `http://127.0.0.1:${Number(process.env.REEVE_PORT ?? DEFAULT_PORT)}`;
  return url.replace(/\/+$/, '');
}

/**
 * Nothing listening, as opposed to something listening and failing. fetch says
 * only "fetch failed"; what went wrong is on its cause.
 */
function isRefused(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string; errors?: Array<{ code?: string }> } })?.cause;
  if (!cause) return false;
  if (cause.code === 'ECONNREFUSED') return true;
  // `localhost` tries each address it resolves to, and reports them together.
  return !!cause.errors?.length && cause.errors.every((err) => err.code === 'ECONNREFUSED');
}

function unreachable(url: string, e: unknown): CliError {
  if (isRefused(e)) return new CliError(`Reeve isn't running at ${url} — start it with \`npm start\` in its checkout`);
  return new CliError(`could not reach Reeve at ${url}: ${String((e as { cause?: unknown })?.cause ?? e)}`);
}

async function send(path: string, init?: RequestInit): Promise<Response> {
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
    // A bare "not found" does not say which id it was; the path does.
    if (res.status === 404 && !body.detail) throw new CliError(`${message ?? 'not found'}: ${path}`);
    throw new CliError(message ?? `HTTP ${res.status}`);
  }
  return res;
}

const get = <T>(path: string) => send(path).then((res) => res.json() as Promise<T>);

const post = <T>(path: string, body: unknown) =>
  send(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => res.json() as Promise<T>);

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

export const api = {
  board: () => get<BoardResponse>('/api/board'),
  card: (id: string) => get<ApiCard>(`/api/cards/${enc(id)}`),
  run: (id: string) => get<ApiRunSummary>(`/api/runs/${enc(id)}`),

  startRun: (cardId: string) => post<StartRunResponse>(`/api/cards/${enc(cardId)}/run`, {}),
  approve: (cardId: string, notes?: string) =>
    post<ApproveResponse>(`/api/cards/${enc(cardId)}/review`, { decision: 'approved', notes }),
  reject: (cardId: string, notes: string) =>
    post<RejectResponse>(`/api/cards/${enc(cardId)}/review`, { decision: 'rejected', notes }),
  questions: (cardId: string) => get<ApiQuestion[]>(`/api/cards/${enc(cardId)}/questions`),
  answer: (cardId: string, questionId: string, answer: string) =>
    post<AnswerResponse>(`/api/cards/${enc(cardId)}/questions/${enc(questionId)}/answer`, { answer }),
  stopRun: (runId: string) => post<ApiRunSummary>(`/api/runs/${enc(runId)}/stop`, {}),

  /** The run's transcript from after `since`, live until the run ends. See ./sse.ts. */
  events: (runId: string, since: number) =>
    send(`/api/runs/${enc(runId)}/events?since=${since}`, { headers: { accept: 'text/event-stream' } }),
};
