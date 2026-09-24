import type {
  ApiAsset,
  ApiCard,
  ApiCardEvent,
  ApiCardRef,
  ApiCommit,
  ApiCriterion,
  ApiDiff,
  ApiProject,
  ApiQuestion,
  BoardResponse,
  CardDetail,
  CreateCardBody,
  CreateProjectBody,
  MoveCardBody,
  Stage,
  UpdateProjectBody,
} from '@reeve/shared';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    // `detail` is where the server puts the sentence worth reading — which
    // branch does not exist, which directory is not a repo. Dropping it left
    // forms showing "invalid project" and nothing a person could act on.
    const message = body.detail ? `${body.error}: ${body.detail}` : body.error;
    throw new Error(message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const patch = (url: string, body: unknown) =>
  fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const del = (url: string) => fetch(url, { method: 'DELETE' });

export const api = {
  board: () => fetch('/api/board').then(json<BoardResponse>),

  // --- repos ---
  createProject: (body: CreateProjectBody) => post('/api/projects', body).then(json<ApiProject>),
  updateProject: (id: string, body: UpdateProjectBody) =>
    patch(`/api/projects/${id}`, body).then(json<ApiProject>),

  createCard: (body: CreateCardBody) => post('/api/cards', body).then(json<ApiCard>),
  moveCard: (id: string, body: MoveCardBody) => post(`/api/cards/${id}/move`, body).then(json<ApiCard>),
  archiveCard: (id: string) => post(`/api/cards/${id}/archive`, {}).then(json<{ ok: true }>),
  /**
   * Starting a stage is two calls, in this order: `/run` refuses a card whose
   * worktree isn't there yet, and `/worktree` is idempotent — it answers
   * `reused: true` for a healthy tree — so this is safe to press twice.
   *
   * The project's setup command (`npm install` and friends) is kicked off by
   * `/worktree` as a background shell run and deliberately not awaited here:
   * it is a different run kind, so it counts against neither the card's active
   * run nor the concurrency cap.
   */
  startStage: async (id: string) => {
    await post(`/api/cards/${id}/worktree`, {}).then(
      json<{ ok: true; reused: boolean; path: string; setupRunId?: string | null }>,
    );
    return post(`/api/cards/${id}/run`, {}).then(json<{ ok: true; runId: string; sessionId: string }>);
  },
  updateCard: (id: string, body: { title?: string; body?: string; projectId?: string | null }) =>
    patch(`/api/cards/${id}`, body).then(json<ApiCard>),

  // --- one card, in full ---
  detail: (id: string) => fetch(`/api/cards/${id}/detail`).then(json<CardDetail>),
  /** Separate from `detail` because it shells out to git; fetched per tab. */
  diff: (id: string) => fetch(`/api/cards/${id}/diff`).then(json<ApiDiff>),
  commits: (id: string) => fetch(`/api/cards/${id}/commits`).then(json<ApiCommit[]>),

  // --- the brief ---
  addCriterion: (id: string, text: string) =>
    post(`/api/cards/${id}/criteria`, { text }).then(json<ApiCriterion>),
  updateCriterion: (id: string, criterionId: string, body: { text?: string }) =>
    patch(`/api/cards/${id}/criteria/${criterionId}`, body).then(json<ApiCriterion>),
  deleteCriterion: (id: string, criterionId: string) =>
    del(`/api/cards/${id}/criteria/${criterionId}`).then(json<{ ok: true }>),
  suggestCriteria: (id: string) =>
    post(`/api/cards/${id}/criteria/suggest`, {}).then(json<{ ok: true; runId: string }>),
  addRef: (id: string, body: { kind: ApiCardRef['kind']; value: string; label?: string | null }) =>
    post(`/api/cards/${id}/refs`, body).then(json<ApiCardRef>),
  deleteRef: (id: string, refId: string) => del(`/api/cards/${id}/refs/${refId}`).then(json<{ ok: true }>),

  // --- talking back to Claude ---
  /** Answering the last open question resumes the run that asked. */
  answerQuestion: (id: string, questionId: string, answer: string) =>
    post(`/api/cards/${id}/questions/${questionId}/answer`, { answer }).then(
      json<{ ok: true; answered: number; of: number; resumed: string | null; blocked?: string }>,
    ),
  addNote: (id: string, body: string) => post(`/api/cards/${id}/notes`, { body }).then(json<ApiCardEvent>),
  /** Approving advances the card a stage; rejecting forks a revision run. */
  review: (id: string, decision: 'approved' | 'rejected', notes?: string) =>
    post(`/api/cards/${id}/review`, { decision, notes }).then(
      json<{ ok: true; fromStage?: Stage; toStage?: Stage; moved?: boolean; revisionRunId?: string }>,
    ),
  stopRun: (runId: string) => post(`/api/runs/${runId}/stop`, {}).then(json<{ ok: true }>),

  // --- pictures ---
  uploadMockup: (id: string, form: FormData) =>
    fetch(`/api/cards/${id}/assets`, { method: 'POST', body: form }).then(json<ApiAsset>),
  deleteAsset: (id: string, assetId: string) =>
    del(`/api/cards/${id}/assets/${assetId}`).then(json<{ ok: true }>),
  listQuestions: (id: string) => fetch(`/api/cards/${id}/questions`).then(json<ApiQuestion[]>),

  // --- the worktree ---
  startServer: (id: string) =>
    post(`/api/cards/${id}/server`, {}).then(json<{ ok: true; runId: string; port: number; url: string }>),
  stopServer: (id: string) => del(`/api/cards/${id}/server`).then(json<{ ok: true }>),
  removeWorktree: (id: string) => del(`/api/cards/${id}/worktree`).then(json<{ ok: true; forced: boolean }>),
  /**
   * Squash into the default branch, then remove the worktree and branch.
   * `cleanup` is set when the merge landed but the tidying after it did not.
   */
  merge: (id: string) =>
    post(`/api/cards/${id}/merge`, {}).then(json<{ ok: true; sha: string; cleanup?: string }>),
};

export const cardsIn = (cards: ApiCard[], stage: Stage, projectId?: string | null): ApiCard[] =>
  cards
    .filter((c) => c.stage === stage && (projectId === undefined || c.projectId === projectId))
    .sort((a, b) => a.position - b.position);
