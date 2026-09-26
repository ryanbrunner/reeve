import type { CardActivity } from '@reeve/shared';

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
