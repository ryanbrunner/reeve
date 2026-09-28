import { STAGES, STAGE_LABELS, type ApiCard, type Stage } from '@reeve/shared';
import { ACTIVITY_DOTS, ACTIVITY_LABELS } from './activity.js';

/**
 * A lane's header: the chevron that folds it, its colour, its name, and how
 * far through its tasks the project is.
 *
 * The chevron and the name are two buttons side by side, never one inside the
 * other — the name opens the project, and folding a lane should not.
 *
 * Folded, the header is all that is left of the lane, so it says what the
 * columns would have: how many cards, and a tally for each one Claude has
 * touched. A shut lane must never hide a card waiting on a person, because
 * nothing on the board moves until one acts. Open, the columns say it already.
 */
export function LaneHeader({
  laneId,
  name,
  color,
  cards,
  archivedDone,
  collapsed,
  onToggle,
  onOpen,
  bodyId,
  vibes,
  solo,
}: {
  /** The lane's project; null is No project, which has nothing to open. */
  laneId: string | null;
  name: string;
  color: string | null;
  /** Every card in the lane, whatever its column. */
  cards: ApiCard[];
  /** The project's `archivedDoneCount`: finished tasks the sweep took off the board. */
  archivedDone: number;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
  /** The lane body's id, for the chevron's aria-controls. */
  bodyId: string;
  /** The board's VIBES MODE, which dresses every lane alike. */
  vibes: boolean;
  /** This lane's project alone in VIBES MODE, on the calm board. */
  solo: boolean;
}) {
  return (
    <h2
      className={`flex items-center gap-2 font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted) uppercase ${
        collapsed ? '' : 'mb-2'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
        className={`-ml-0.5 flex h-4 w-4 items-center justify-center hover:text-(--color-text) ${vibes ? 'sk-lane-name' : ''}`}
      >
        <svg
          viewBox="0 0 12 12"
          aria-hidden="true"
          className={`h-2.5 w-2.5 transition-transform ${collapsed ? '-rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 4.5L6 8l3.5-3.5" />
        </svg>
      </button>
      <span
        className={`h-2 w-2 rounded-full ${vibes ? 'sk-lane-dot' : ''}`}
        style={{ background: color ?? '#3f4754' }}
      />
      {/* The lane is the project, and its header is the way into it. */}
      {laneId ?
        <button
          type="button"
          onClick={() => onOpen(laneId)}
          title="Open the project"
          className={`min-w-0 truncate uppercase hover:text-(--color-text) ${vibes ? 'sk-lane-name' : ''}`}
        >
          {name}
        </button>
      : <span className={`min-w-0 truncate ${vibes ? 'sk-lane-name' : ''}`}>{name}</span>}
      {/* The chip a card in VIBES MODE on its own wears, here because the
          project's switch is what put its cards there. Folded, it is the only
          sign left that they are moving with nobody watching. */}
      {solo && !vibes && (
        <span
          className="sk-solo rounded px-[5px] py-px font-mono text-[10px]/4 font-semibold tracking-normal normal-case"
          title="In VIBES MODE: Claude approves and merges every task in this project with nobody reviewing them"
        >
          <span>vibes</span>
        </span>
      )}
      {/* Before the tallies, so it stays put when the lane folds. No project
          is not a piece of work with an end, so it has none. */}
      {laneId && <Progress cards={cards} archivedDone={archivedDone} />}
      {collapsed && <Summary cards={cards} />}
    </h2>
  );
}

/** Each column's segment, dark to light as work moves right, and Done green. */
const STAGE_COLORS: Record<Stage, string> = {
  backlog: 'var(--color-stage-backlog)',
  planning: 'var(--color-stage-planning)',
  in_progress: 'var(--color-stage-in-progress)',
  testing: 'var(--color-stage-testing)',
  done: 'var(--color-merged-mark)',
};

/**
 * A bar split by column, each segment as wide as its share of the project's
 * tasks, and Done over the total beside it.
 *
 * The columns come from the lane's own cards rather than a count off the
 * server, so the bar moves with a drag the moment the card does. Done also
 * counts the tasks archived from it: the merge sweep takes a task off the
 * board ten minutes after it lands, and a project whose work had all merged
 * would otherwise lose its bar altogether.
 */
function Progress({ cards, archivedDone }: { cards: ApiCard[]; archivedDone: number }) {
  const counts = STAGES.map((stage) => ({
    stage,
    count: cards.filter((c) => c.stage === stage).length + (stage === 'done' ? archivedDone : 0),
  }));
  const total = counts.reduce((sum, { count }) => sum + count, 0);
  // An empty track would read as work that has stalled, not work not yet written.
  if (total === 0) return null;
  const done = counts.find((c) => c.stage === 'done')?.count ?? 0;
  // The shades alone cannot tell Planning from Testing, so the words carry
  // every column, the empty ones too.
  const text = [
    `${done} of ${total} ${total === 1 ? 'task' : 'tasks'} done`,
    ...counts.map(({ stage, count }) =>
      stage === 'done' && archivedDone > 0 ?
        `${STAGE_LABELS[stage]} ${count} (${archivedDone} archived after finishing)`
      : `${STAGE_LABELS[stage]} ${count}`,
    ),
  ].join(' · ');
  return (
    <span className="ml-1.5 flex shrink-0 items-center gap-2" title={text}>
      <span
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={text}
        // The gap is the track showing through, so two neighbouring shades
        // still read as two segments.
        className="flex h-1 w-24 gap-px overflow-hidden rounded-full bg-(--color-edge)"
      >
        {counts.map(({ stage, count }) =>
          count === 0 ? null : (
            <span key={stage} className="h-full basis-0" style={{ flexGrow: count, background: STAGE_COLORS[stage] }} />
          ),
        )}
      </span>
      <span aria-hidden="true" className="tracking-normal">
        {done}/{total}
      </span>
    </span>
  );
}

function Summary({ cards }: { cards: ApiCard[] }) {
  return (
    <span className="ml-1 flex items-center gap-3 text-(--color-muted)/60">
      <span>{cards.length === 1 ? '1 card' : `${cards.length} cards`}</span>
      {ACTIVITY_DOTS.map(({ activity, color }) => {
        const count = cards.filter((c) => c.activity === activity).length;
        if (count === 0) return null;
        const label = ACTIVITY_LABELS[activity];
        // Named in text as well as by colour, so the tally is not just a dot to
        // a screen reader.
        return (
          <span key={activity} title={label} className="flex items-center gap-1.5 text-(--color-muted)">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
            {count}{' '}
            <span className="sr-only">{label}</span>
          </span>
        );
      })}
    </span>
  );
}
