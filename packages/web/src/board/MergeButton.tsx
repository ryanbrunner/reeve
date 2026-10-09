import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiCard } from '@reeve/shared';
import { api } from '../lib/api.js';
import { useArmed } from '../lib/armed.js';

/**
 * Merges a Release card's pull request on GitHub, offered only once GitHub has
 * said it merges cleanly. It sits on the card for the same reason Run does:
 * it is the one thing left to do with it, and opening the card to find the
 * button is a step with nothing in it.
 *
 * The first press arms it and the second merges. Run can be stopped and a card
 * dragged back, but a merge cannot be taken back from the board, and a stray
 * click on a card that is also a drag handle should not land anything. Emerald,
 * the merged chip's colour, rather than Run's sky: this is not Claude's work.
 */
export function MergeButton({ card }: { card: ApiCard }) {
  const qc = useQueryClient();
  const [armed, setArmed] = useArmed();
  const merge = useMutation({
    mutationFn: () => api.mergePr(card.id),
    onSettled: () => {
      setArmed(false);
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const merging = merge.isPending || card.mergingPr;
  return (
    <>
      <button
        // The whole card is the drag handle, so the press has to stop here or
        // the pointer sensor treats a click as the start of a drag.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (armed) merge.mutate();
          else setArmed(true);
        }}
        disabled={merging}
        title={armed ? 'Press again to merge the pull request on GitHub' : `Merge PR #${card.prNumber ?? ''}: GitHub says it merges cleanly`}
        className={`ml-auto rounded border px-1.5 py-0.5 font-mono text-[10px]/4 disabled:opacity-40 ${
          armed
            ? 'border-emerald-600 bg-emerald-500/20 text-emerald-200'
            : 'border-emerald-800 text-emerald-300 hover:border-emerald-600 hover:bg-emerald-500/10'
        }`}
      >
        {merging ? 'Merging…' : armed ? 'Confirm' : 'Merge'}
      </button>
      {/* Cleared by the next click: a fresh attempt resets the mutation. */}
      {merge.error && (
        <p className="basis-full font-mono text-[10px] leading-snug text-red-300">{merge.error.message}</p>
      )}
    </>
  );
}
