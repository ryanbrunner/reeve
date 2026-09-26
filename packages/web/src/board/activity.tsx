import type { ApiCard, CardActivity } from '@reeve/shared';

/**
 * The card's sub-state, as light. The column is where the human put the card;
 * this is what the machine has done with it since, and it is the only thing on
 * the board that changes without a drag. A card Claude has touched glows from
 * all four edges into a dark centre; an idle one is plain panel.
 *
 * Shared with the detail modal, which wears the same skin at a larger size —
 * opening a card should feel like the card got bigger, not like arriving
 * somewhere else.
 */
export const ACTIVITY_STYLE: Record<CardActivity, string> = {
  idle: 'border-(--color-edge) bg-(--color-panel) hover:border-slate-600',
  running: 'card-glow card-glow-running',
  needs_review: 'card-glow card-glow-review',
  needs_input: 'card-glow card-glow-input',
  error: 'card-glow card-glow-error',
};

/**
 * The second signal, so a state never rests on colour alone: a 68px outline
 * mark, centred behind the card's own content and faint enough to read through.
 * `running` has none — it carries the progress rail instead — and `idle` has
 * nothing to say.
 */
export const ACTIVITY_MARKS: Partial<Record<CardActivity, React.ReactNode>> = {
  needs_review: (
    <Mark>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Mark>
  ),
  needs_input: (
    <Mark>
      <path d="M9 9a3 3 0 1 1 4.5 2.6c-.9.5-1.5 1.2-1.5 2.2V15" />
      <path d="M12 18.5v.01" />
    </Mark>
  ),
  error: (
    <Mark>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Mark>
  ),
};

/**
 * A card whose pull request has landed, in Done, is finished, and wears it:
 * green, with a check in a circle. Not a `CardActivity`, which is read from
 * the card's runs and which `reeve card wait` turns into exit codes; this is a
 * fact about the card, and Done has no runs to colour it anyway. Only in Done,
 * because a merged card dragged back for another round is running again, and
 * its activity is what matters there.
 *
 * The circle is what keeps it apart from `needs_review`'s bare check, which is
 * also green and means the opposite: that a person still has something to do.
 */
export function isMerged(card: Pick<ApiCard, 'stage' | 'mergedAt'>): boolean {
  return card.stage === 'done' && card.mergedAt != null;
}

export const MERGED_STYLE = 'card-glow card-glow-merged';

export const MERGED_MARK = (
  <Mark>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l2.75 2.75L16 9.75" />
  </Mark>
);

export const MERGED_LABEL = 'Merged';

export function Mark({ children }: { children: React.ReactNode }) {
  return (
    <svg className="card-mark" viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

/**
 * Every non-idle state says its name, as hidden text rather than a chip: the
 * glow and the mark carry it for the eye, this carries it for a screen reader.
 * `idle` has no label on purpose — it falls through to the raw run status,
 * which is the only way a deliberately cancelled run still shows on the face.
 */
export const ACTIVITY_LABELS: Partial<Record<CardActivity, string>> = {
  running: 'Claude running',
  needs_review: 'Ready for review',
  needs_input: 'Needs your answer',
  error: 'Error',
};

/**
 * Each non-idle state's colour, for when there is no card face to glow: a
 * collapsed lane's header tallies them with a dot. Most urgent first, which is
 * the order they are drawn in — a person is waiting on the first two.
 */
export const ACTIVITY_DOTS: ReadonlyArray<{ activity: CardActivity; color: string }> = [
  { activity: 'needs_input', color: 'var(--color-activity-input-mark)' },
  { activity: 'needs_review', color: 'var(--color-activity-review-mark)' },
  { activity: 'error', color: 'var(--color-activity-error-mark)' },
  { activity: 'running', color: 'var(--color-activity-running-mark)' },
];
