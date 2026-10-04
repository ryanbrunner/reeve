import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiCard, SuggestionDecisionBody } from '@reeve/shared';
import { api } from '../lib/api.js';

/**
 * A person's decision on a card a run suggested, shared by the card's face and
 * its modal. Rejecting archives the card, so the Archive's list goes stale too.
 */
export function useSuggestionDecision(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (decision: SuggestionDecisionBody['decision']) => api.decideSuggestion(cardId, decision),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['board'] });
      void qc.invalidateQueries({ queryKey: ['card', cardId] });
      void qc.invalidateQueries({ queryKey: ['archived'] });
    },
  });
}

/**
 * Accept and Reject on the face of a suggestion nobody has decided on, so an
 * idea can be kept or waved off without opening it. Accept is in the
 * suggestion's pink, since it keeps the card; Reject is a quiet cross, since
 * it only archives it, and the Archive can bring it back — which is also why
 * neither asks twice, as Merge does.
 */
export function SuggestionButtons({ card }: { card: ApiCard }) {
  const decide = useSuggestionDecision(card.id);
  // The whole card is the drag handle, so a press has to stop here or the
  // pointer sensor treats a click as the start of a drag, and the click would
  // open the card.
  const press = (decision: SuggestionDecisionBody['decision']) => ({
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      decide.mutate(decision);
    },
  });
  return (
    <>
      <span className="ml-auto flex gap-1">
        <button
          {...press('accepted')}
          disabled={decide.isPending}
          title="Keep this suggestion in Backlog"
          className="rounded border border-(--color-sug-border) bg-(--color-sug-fill) px-1.5 py-0.5 font-mono text-[10px]/4 text-(--color-sug) hover:border-(--color-sug-ring) disabled:opacity-40"
        >
          ✓ accept
        </button>
        <button
          {...press('rejected')}
          disabled={decide.isPending}
          aria-label="Reject suggestion"
          title="Reject this suggestion. The Archive can bring it back."
          className="rounded border border-(--color-edge) px-1.5 py-0.5 font-mono text-[10px]/4 text-(--color-muted) hover:border-slate-600 hover:text-(--color-text) disabled:opacity-40"
        >
          ×
        </button>
      </span>
      {decide.error && (
        <p className="basis-full font-mono text-[10px] leading-snug text-red-300">{decide.error.message}</p>
      )}
    </>
  );
}
