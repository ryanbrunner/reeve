import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiCard } from '@reeve/shared';
import { api } from '../lib/api.js';

/**
 * Land a Done card on the default branch, straight from the board.
 *
 * The face knows nothing about git — whether the tree is dirty, whether there
 * is anything committed — and does not try to: it asks, and when the server
 * refuses, the refusal is the explanation, shown under the card.
 */
export function MergeButton({ card }: { card: ApiCard }) {
  const qc = useQueryClient();
  const merge = useMutation({
    mutationFn: () => api.merge(card.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['board'] });
      void qc.invalidateQueries({ queryKey: ['card', card.id] });
    },
  });

  return (
    <>
      <button
        // The whole card is the drag handle, so the press has to stop here or
        // the pointer sensor treats a click as the start of a drag.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); merge.mutate(); }}
        disabled={merge.isPending}
        title="Squash into the default branch, then remove the worktree and branch"
        className="ml-auto rounded border border-emerald-800 px-1.5 py-0.5 font-mono text-[10px]/4 text-emerald-300 hover:border-emerald-600 hover:bg-emerald-500/10 disabled:opacity-40"
      >
        {merge.isPending ? 'Merging…' : 'Merge'}
      </button>
      {merge.error && (
        <p className="basis-full font-mono text-[10px] leading-snug text-red-300">{merge.error.message}</p>
      )}
    </>
  );
}
