import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RunProjector, isTerminal, type ApiConversation, type CardDetail } from '@reeve/shared';
import { api } from '../../lib/api.js';

/**
 * The card's conversation, kept current.
 *
 * The endpoint projects every run once; the live run's tail then arrives over
 * its own SSE stream from where that projection stopped, and is folded in by
 * the same `RunProjector`, so a message appears the moment it is stored rather
 * than on the next poll. Refetched whenever the card's latest run changes —
 * a new run, or one ending — which is when the projection itself moves on.
 */
export function useConversation(detail: CardDetail) {
  const cardId = detail.card.id;
  const qc = useQueryClient();
  const latest = detail.runs.find((r) => r.kind === 'claude' && r.task === null) ?? null;
  const query = useQuery({
    queryKey: ['conversation', cardId],
    queryFn: () => api.conversation(cardId),
  });

  // The run and its status are what the projection follows: a new run, or
  // one finishing, is a refetch. A detail poll that changes neither is not.
  const key = `${latest?.id ?? ''}:${latest?.status ?? ''}`;
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['conversation', cardId] });
  }, [key, cardId, qc]);

  const [live, setLive] = useState<ApiConversation | null>(null);
  const liveRunId = latest && !isTerminal(latest.status) ? latest.id : null;

  useEffect(() => {
    setLive(null);
    const base = query.data;
    if (!liveRunId || !base) return;
    const stageIndex = base.stages.findIndex((s) => s.runs.some((r) => r.runId === liveRunId));
    const stage = base.stages[stageIndex];
    const run = stage?.runs.find((r) => r.runId === liveRunId);
    if (!stage || !run) return;

    const projector = RunProjector.resume(run);
    // Repainting on every event of a busy run is wasteful; one frame's worth
    // of events lands together.
    let frame = 0;
    const paint = () => {
      frame = 0;
      setLive({
        stages: base.stages.map((s, i) => i !== stageIndex ? s : {
          ...s,
          runs: s.runs.map((r) => r.runId !== liveRunId ? r : { ...r, items: [...projector.items], lastSeq: projector.lastSeq }),
        }),
      });
    };
    const source = new EventSource(`/api/runs/${liveRunId}/events?since=${run.lastSeq}`);
    const onEvent = (e: MessageEvent<string>) => {
      projector.add({ seq: Number(e.lastEventId), kind: e.type, payload: e.data, at: Date.now() });
      if (!frame) frame = requestAnimationFrame(paint);
    };
    for (const kind of RunProjector.KINDS) source.addEventListener(kind, onEvent);
    // Its status moves the card, the board and the projection.
    for (const kind of ['ask', 'ask_answered', 'submitted']) {
      source.addEventListener(kind, () => void qc.invalidateQueries({ queryKey: ['card', cardId] }));
    }
    source.addEventListener('end', () => {
      source.close();
      void qc.invalidateQueries({ queryKey: ['card', cardId] });
      void qc.invalidateQueries({ queryKey: ['conversation', cardId] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    });
    source.onerror = () => {};
    return () => {
      if (frame) cancelAnimationFrame(frame);
      source.close();
    };
  }, [liveRunId, query.data, cardId, qc]);

  return { conversation: live ?? query.data ?? null, isLoading: query.isLoading, error: query.error };
}
