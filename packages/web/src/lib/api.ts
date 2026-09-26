import type {
  AddDependencyBody,
  ApiAsset,
  ApiCard,
  ApiCardEvent,
  ApiCardRef,
  ApiCommit,
  ApiCriterion,
  ApiDiff,
  ApiQuestion,
  ApiRepo,
  ApiSettings,
  BoardResponse,
  CardDetail,
  CreateCardBody,
  CreateRepoBody,
  CritReviewResponse,
  EffortLevel,
  HandoffResponse,
  ModelsResponse,
  MoveCardBody,
  ResolveConflictsResponse,
  Stage,
  UpdateRepoBody,
  UpdateSettingsBody,
} from '@reeve/shared';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    // `detail` is where the server puts the sentence worth reading — which
    // branch does not exist, which directory is not a repo. Dropping it left
    // forms showing "invalid repo" and nothing a person could act on.
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

  settings: () => fetch('/api/settings').then(json<ApiSettings>),
  updateSettings: (body: UpdateSettingsBody) => patch('/api/settings', body).then(json<ApiSettings>),
  /** What the Claude CLI offers. Empty when it could not be asked; the pickers then offer defaults only. */
  models: () => fetch('/api/models').then(json<ModelsResponse>),

  // --- repos ---
  createRepo: (body: CreateRepoBody) => post('/api/repos', body).then(json<ApiRepo>),
  updateRepo: (id: string, body: UpdateRepoBody) =>
    patch(`/api/repos/${id}`, body).then(json<ApiRepo>),

  createCard: (body: CreateCardBody) => post('/api/cards', body).then(json<ApiCard>),
  moveCard: (id: string, body: MoveCardBody) => post(`/api/cards/${id}/move`, body).then(json<ApiCard>),
  /** Soft: the card leaves the board, and everything it owns stays where it is. */
  archiveCard: (id: string) => post(`/api/cards/${id}/archive`, {}).then(json<{ ok: true }>),
  restoreCard: (id: string) => post(`/api/cards/${id}/restore`, {}).then(json<ApiCard>),
  /** Hard, but only for a card nobody touched: the server says whether it went. */
  discardCard: (id: string) => post(`/api/cards/${id}/discard`, {}).then(json<{ deleted: boolean }>),
  archivedCards: () => fetch('/api/cards/archived').then(json<ApiCard[]>),
  /**
   * One call: `/run` makes the worktree itself when there isn't one, so a
   * press of Run and a card starting on its own cannot both try to make it.
   */
  startStage: (id: string) =>
    post(`/api/cards/${id}/run`, {}).then(json<{ ok: true; runId: string; sessionId: string }>),
  updateCard: (
    id: string,
    body: {
      title?: string;
      body?: string;
      repoId?: string | null;
      model?: string | null;
      effort?: EffortLevel | null;
      generateMockups?: boolean;
      sicko?: boolean;
    },
  ) => patch(`/api/cards/${id}`, body).then(json<ApiCard>),

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
  /** A project's brief, broken into Backlog cards under it. Titles it already has are skipped. */
  splitProject: (id: string) => post(`/api/cards/${id}/split`, {}).then(json<{ ok: true; runId: string }>),
  addRef: (id: string, body: { kind: ApiCardRef['kind']; value: string; label?: string | null }) =>
    post(`/api/cards/${id}/refs`, body).then(json<ApiCardRef>),
  deleteRef: (id: string, refId: string) => del(`/api/cards/${id}/refs/${refId}`).then(json<{ ok: true }>),
  /** Refused, with the reason, for a project, the card itself, or a link that would close a loop. */
  addDependency: (id: string, body: AddDependencyBody) =>
    post(`/api/cards/${id}/dependencies`, body).then(json<{ ok: true }>),
  removeDependency: (id: string, dependsOnId: string) =>
    del(`/api/cards/${id}/dependencies/${dependsOnId}`).then(json<{ ok: true }>),

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
   * Push the branch and open its pull request, or push to the one already
   * open. Entering Done does this on its own; this is the retry.
   */
  openPr: (id: string) =>
    post(`/api/cards/${id}/pr`, {}).then(json<{ ok: true; url: string; number: number; reused: boolean }>),
  /** Merges the base branch in; Claude resolves the conflicts, and the server pushes once it has checked them. */
  resolveConflicts: (id: string) =>
    post(`/api/cards/${id}/resolve-conflicts`, {}).then(json<ResolveConflictsResponse>),
  /** Writes `.reeve/handoff.md` into the worktree and answers with the command to paste. */
  handoff: (id: string) => post(`/api/cards/${id}/handoff`, {}).then(json<HandoffResponse>),
  /** Opens the plan in Crit, or answers with the review already open. Finishing there is the verdict. */
  reviewWithCrit: (id: string) => post(`/api/cards/${id}/crit`, {}).then(json<CritReviewResponse>),
};

/** A column's cards in order, or only one lane's of them when a project is given: null is No project. */
export const cardsIn = (cards: ApiCard[], stage: Stage, projectId?: string | null): ApiCard[] =>
  cards
    .filter((c) => c.stage === stage && (projectId === undefined || c.projectId === projectId))
    .sort((a, b) => a.position - b.position);
