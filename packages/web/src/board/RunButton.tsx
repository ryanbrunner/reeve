import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import type { ApiCard } from '@reeve/shared';
import { api } from '../lib/api.js';

/**
 * Starts Claude on a card that did not start on its own when it entered the
 * column — the cap was full, or a run from the column it left was still
 * going — or whose run failed. It sits on the card rather than in the column
 * header because a stage runs per card, and it is absent once a run has
 * succeeded: from there the review gate takes over. On an error
 * card it takes that card's red, because a button on a tinted card belongs to
 * it; everywhere else it stays sky, because sky is Claude.
 */
export function RunButton({ card }: { card: ApiCard }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['board'] });
  // The same key as the attention band's Retry: it is the same start, and a
  // refusal from either is the card's to say.
  const key = ['start', card.id];
  const start = useMutation({
    mutationKey: key,
    // The start only answers once the repo's setup is done, which can be
    // minutes, and the card reads as starting from the moment the server
    // takes the request. So the board is looked at again as soon as the
    // request is sent, rather than the card sitting on a held button until
    // the next poll. Settled, not succeeded: a refused start ends the
    // starting too.
    mutationFn: () => {
      const started = api.startStage(card.id);
      refresh();
      return started;
    },
    onSettled: refresh,
  });
  // Read off the cache, not `start`: the card hides this button while it is
  // starting, so a refusal — the cap, say — lands on a button mounted afresh,
  // whose own mutation has never run. And only a refusal made since the
  // card's last run ended: the cache outlives a later run that started and
  // finished on its own. A fresh click is the latest entry, and clears it.
  const last = useMutationState({ filters: { mutationKey: key }, select: (m) => m.state }).at(-1);
  const refused = last?.error && last.submittedAt > (card.latestRun?.finishedAt ?? 0) ? last.error : null;
  const retry = card.activity === 'error';

  return (
    <>
      <button
        // The whole card is the drag handle, so the press has to stop here or
        // the pointer sensor treats a click as the start of a drag.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); start.mutate(); }}
        disabled={start.isPending}
        title={retry ? 'Start a fresh run' : 'Run this stage'}
        className={`ml-auto rounded border px-1.5 py-0.5 font-mono text-[10px]/4 disabled:opacity-40 ${
          retry
            ? 'border-(--color-btn-error-border) bg-(--color-btn-error-fill) text-red-200 shadow-(--shadow-btn-error-glow) hover:border-(--color-btn-error-hover-border) hover:bg-(--color-btn-error-hover-fill)'
            : 'border-sky-800 text-sky-300 hover:border-sky-600 hover:bg-sky-500/10'
        }`}
      >
        {start.isPending ? 'Starting…' : retry ? 'Retry' : 'Run'}
      </button>
      {refused && (
        <p className="basis-full font-mono text-[10px] leading-snug text-red-300">{refused.message}</p>
      )}
    </>
  );
}
