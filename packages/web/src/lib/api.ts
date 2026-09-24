import type { ApiCard, BoardResponse, CreateCardBody, MoveCardBody, Stage } from '@reeve/shared';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  board: () => fetch('/api/board').then(json<BoardResponse>),
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
  updateCard: (id: string, patch: { title?: string; body?: string }) =>
    fetch(`/api/cards/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(json<ApiCard>),
};

export const cardsIn = (cards: ApiCard[], stage: Stage, projectId?: string | null): ApiCard[] =>
  cards
    .filter((c) => c.stage === stage && (projectId === undefined || c.projectId === projectId))
    .sort((a, b) => a.position - b.position);
