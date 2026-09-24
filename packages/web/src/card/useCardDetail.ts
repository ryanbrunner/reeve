import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CardDetail } from '@reeve/shared';
import { api } from '../lib/api.js';

/**
 * One card, kept current.
 *
 * The board polls because nothing pushes a card's activity to it. The modal is
 * looking at exactly one run, so it can do better: while that run is live it
 * opens the per-run SSE stream the server has always had and nothing consumed,
 * and reads the elapsed time, the cost and what Claude is doing right now off
 * it. The detail query itself stays on a slow poll underneath, because the
 * stream carries the run and not the card around it.
 */
export function useCardDetail(cardId: string | null) {
  const query = useQuery({
    queryKey: ['card', cardId],
    queryFn: () => api.detail(cardId!),
    enabled: cardId !== null,
    // Slow: the live parts arrive over SSE, and everything else changes only
    // when this modal or the board does something that invalidates it.
    refetchInterval: (q) => (q.state.data?.card.activity === 'running' ? 5_000 : false),
  });
  return query;
}

export interface LiveRun {
  /** Milliseconds since the run started, ticking. */
  elapsedMs: number;
  /** The last thing Claude said or did, one line. */
  activity: string | null;
  /** Turns completed so far, as the stream reports them. */
  turns: number;
}

/**
 * The run's own stream, while it is running.
 *
 * `Last-Event-ID` resume is deliberately not used: reconnecting mid-run should
 * pick up from now, not replay a transcript this only ever shows one line of.
 * On `end` the detail query is invalidated, which is what turns the card from
 * running into whatever it became.
 */
export function useLiveRun(cardId: string | null, runId: string | null, running: boolean): LiveRun | null {
  const qc = useQueryClient();
  const [live, setLive] = useState<LiveRun | null>(null);
  const startedAt = useRef<number>(Date.now());

  useEffect(() => {
    if (!running || !runId) {
      setLive(null);
      return;
    }
    startedAt.current = Date.now();
    setLive({ elapsedMs: 0, activity: null, turns: 0 });

    // `since=live` asks for new events only. Without it the server replays the
    // whole transcript, which for a long run is thousands of messages to learn
    // the one line this shows.
    const source = new EventSource(`/api/runs/${runId}/events?since=live`);
    let turns = 0;

    source.onmessage = (e) => {
      const line = describe(e.data);
      if (line === null) return;
      if (line.turn) turns++;
      setLive((prev) => ({
        elapsedMs: prev?.elapsedMs ?? 0,
        activity: line.text ?? prev?.activity ?? null,
        turns,
      }));
    };
    source.addEventListener('end', () => {
      source.close();
      void qc.invalidateQueries({ queryKey: ['card', cardId] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    });
    // A dropped connection is not worth surfacing: the poll underneath still
    // has the card, and EventSource reconnects on its own.
    source.onerror = () => {};

    const tick = setInterval(() => {
      setLive((prev) => (prev ? { ...prev, elapsedMs: Date.now() - startedAt.current } : prev));
    }, 1_000);

    return () => {
      clearInterval(tick);
      source.close();
    };
  }, [cardId, runId, running, qc]);

  return live;
}

/**
 * One line of "what is happening", from a raw SDK message.
 *
 * Deliberately shallow. The stream carries forty-odd message shapes and this
 * needs exactly two facts: whether a turn happened, and the most recent human
 * -readable thing to put after the step count. Anything it does not recognise
 * is skipped rather than guessed at.
 */
function describe(raw: string): { text: string | null; turn: boolean } | null {
  let msg: { type?: string; message?: { content?: unknown } };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return null;
  }
  if (msg.type !== 'assistant') return null;

  const content = msg.message?.content;
  if (!Array.isArray(content)) return { text: null, turn: true };

  for (const block of content as Array<{ type?: string; name?: string; text?: string }>) {
    if (block.type === 'tool_use' && block.name) return { text: toolLine(block.name), turn: true };
    if (block.type === 'text' && block.text?.trim()) {
      return { text: block.text.trim().split('\n')[0]!.slice(0, 120), turn: true };
    }
  }
  return { text: null, turn: true };
}

const toolLine = (name: string): string => {
  switch (name) {
    case 'Read': return 'reading a file';
    case 'Glob':
    case 'Grep': return 'searching the codebase';
    case 'Edit':
    case 'Write': return 'editing a file';
    case 'Bash': return 'running a command';
    default: return `using ${name}`;
  }
};
