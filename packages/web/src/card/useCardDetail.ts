import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { describeMessage, isTerminal, nextThought, type CardDetail } from '@reeve/shared';
import { api } from '../lib/api.js';

/**
 * One card, kept current.
 *
 * The board polls because nothing pushes a card's activity to it. The modal is
 * looking at exactly one run, so it can do better: while that run is live it
 * opens the per-run SSE stream the server has always had and nothing consumed,
 * and reads the elapsed time and what Claude is doing right now off it. The detail query itself stays on a slow poll underneath, because the
 * stream carries the run and not the card around it.
 */
export function useCardDetail(cardId: string | null) {
  const query = useQuery({
    queryKey: ['card', cardId],
    queryFn: () => api.detail(cardId!),
    enabled: cardId !== null,
    // Slow: the live parts arrive over SSE, and everything else changes only
    // when this modal or the board does something that invalidates it. Three
    // things are the exception, and none is pushed: a Suggest is not the
    // card's run, so nothing streams it, and on a Backlog card nothing else
    // would ever notice it finish; a pull request opened on entering Done
    // comes back on its own schedule; and one merged on GitHub is only noticed
    // by the server's own sync, which is slower still.
    refetchInterval: (q) => {
      const data = q.state.data;
      // A resolution checks and pushes after its run has ended, so it is
      // watched by the card's own flag rather than the run's.
      if (data?.card.openingPr || data?.card.resolvingConflicts || data?.card.mergingPr) return 1_500;
      // A stage starting has no run yet to stream, and the band waits on the
      // refetch that finds one to stop saying so.
      if (data?.card.startingStage) return 1_500;
      // A dev server says where it is in its output, a second or two after it
      // starts, and nothing pushes that to the Rail.
      if (data?.worktree.server?.running && !data.worktree.server.url) return 1_500;
      if (data?.runs.some((r) => r.task !== null && !isTerminal(r.status))) return 2_000;
      if (data?.card.activity === 'running') return 5_000;
      return data?.card.prUrl && data.card.mergedAt == null ? 15_000 : false;
    },
  });
  return query;
}

export interface LiveRun {
  /** Milliseconds since the run started, ticking. */
  elapsedMs: number;
  /** The last thing Claude said or did, one line. */
  activity: string | null;
  /** The latest summary of Claude's reasoning, whole. */
  thinking: string | null;
}

/**
 * The run's own stream, while it is running.
 *
 * `Last-Event-ID` resume is deliberately not used: reconnecting mid-run should
 * pick up from now, not replay a transcript this only ever shows one line of.
 * On `end` the detail query is invalidated, which is what turns the card from
 * running into whatever it became.
 */
export function useLiveRun(
  cardId: string | null,
  runId: string | null,
  running: boolean,
  startedAt: number | null,
): LiveRun | null {
  const qc = useQueryClient();
  const [live, setLive] = useState<LiveRun | null>(null);
  const since = useRef<number>(Date.now());

  useEffect(() => {
    if (!running || !runId) {
      setLive(null);
      return;
    }
    // From when the run actually began, not from when this modal opened. A run
    // that has been going half an hour reads "31m", not "0s" counting up.
    since.current = startedAt ?? Date.now();
    setLive({ elapsedMs: Date.now() - since.current, activity: null, thinking: null });

    // `since=live` asks for new events only. Without it the server replays the
    // whole transcript, which for a long run is thousands of messages to learn
    // the one line this shows. What came before is on the detail, as the
    // thought the server stored; the band falls back to that until this has
    // something of its own.
    const source = new EventSource(`/api/runs/${runId}/events?since=live`);

    const onEvent = (e: MessageEvent<string>) => {
      const line = describeMessage(e.data);
      if (line === null) return;
      setLive((prev) => ({
        elapsedMs: prev?.elapsedMs ?? Date.now() - since.current,
        ...nextThought({ activity: prev?.activity ?? null, thinking: prev?.thinking ?? null }, line),
      }));
    };
    // The server names every event after its kind, and a named event never
    // reaches `onmessage` — so each kind describeMessage reads is listened for.
    source.addEventListener('assistant', onEvent);
    source.addEventListener('system:thinking_tokens', onEvent);
    source.addEventListener('end', () => {
      source.close();
      void qc.invalidateQueries({ queryKey: ['card', cardId] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    });
    // A dropped connection is not worth surfacing: the poll underneath still
    // has the card, and EventSource reconnects on its own.
    source.onerror = () => {};

    const tick = setInterval(() => {
      setLive((prev) => (prev ? { ...prev, elapsedMs: Date.now() - since.current } : prev));
    }, 1_000);

    return () => {
      clearInterval(tick);
      source.close();
    };
  }, [cardId, runId, running, startedAt, qc]);

  return live;
}
