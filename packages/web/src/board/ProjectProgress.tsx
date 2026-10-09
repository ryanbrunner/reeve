import { STAGES, STAGE_LABELS, type ApiCard, type Stage } from '@reeve/shared';

/** Each column's segment, dark to light as work moves right, and Release green. */
const STAGE_COLORS: Record<Stage, string> = {
  backlog: 'var(--color-stage-backlog)',
  planning: 'var(--color-stage-planning)',
  in_progress: 'var(--color-stage-in-progress)',
  testing: 'var(--color-stage-testing)',
  release: 'var(--color-merged-mark)',
};

/**
 * A bar split by column, each segment as wide as its share of the project's
 * tasks, and Release over the total beside it.
 *
 * The columns come from the project's live cards on the board rather than a
 * count off the server, so the bar moves with a drag the moment the card does.
 * Release also counts the tasks archived from it: the merge sweep takes a task off
 * the board ten minutes after it lands, and a project whose work had all merged
 * would otherwise lose its bar altogether.
 *
 * One component for the lane's header and the project's modal, so the two can
 * never count differently. The modal has the room to say `long`-hand what the
 * lane leaves to the tooltip: that the number is Release, and how much of it is
 * in the Archive, which is where a finished project's tasks all end up.
 */
export function ProjectProgress({ tasks, archivedDone, width = 'w-24', long = false, className = '' }: {
  /** The project's live tasks, whatever their column. */
  tasks: ApiCard[];
  /** The project's `archivedDoneCount`: finished tasks the sweep took off the board. */
  archivedDone: number;
  /** The track's width, as a Tailwind class. */
  width?: string;
  /** `2/6 done · 1 archived` rather than `2/6`. */
  long?: boolean;
  className?: string;
}) {
  const counts = STAGES.map((stage) => ({
    stage,
    count: tasks.filter((c) => c.stage === stage).length + (stage === 'release' ? archivedDone : 0),
  }));
  const total = counts.reduce((sum, { count }) => sum + count, 0);
  // An empty track would read as work that has stalled, not work not yet written.
  if (total === 0) return null;
  const done = counts.find((c) => c.stage === 'release')?.count ?? 0;
  // The shades alone cannot tell Planning from Testing, so the words carry
  // every column, the empty ones too.
  const text = [
    `${done} of ${total} ${total === 1 ? 'task' : 'tasks'} done`,
    ...counts.map(({ stage, count }) =>
      stage === 'release' && archivedDone > 0 ?
        `${STAGE_LABELS[stage]} ${count} (${archivedDone} archived after finishing)`
      : `${STAGE_LABELS[stage]} ${count}`,
    ),
  ].join(' · ');
  return (
    <span className={`flex shrink-0 items-center gap-2 ${className}`} title={text}>
      <span
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={text}
        // The gap is the track showing through, so two neighbouring shades
        // still read as two segments.
        className={`flex h-1 ${width} gap-px overflow-hidden rounded-full bg-(--color-edge)`}
      >
        {counts.map(({ stage, count }) =>
          count === 0 ? null : (
            <span key={stage} className="h-full basis-0" style={{ flexGrow: count, background: STAGE_COLORS[stage] }} />
          ),
        )}
      </span>
      {long ?
        <span aria-hidden="true" className="tracking-normal">
          <span className="font-medium text-(--color-text)">
            {done}/{total} done
          </span>
          {archivedDone > 0 && <span className="text-(--color-muted)"> · {archivedDone} archived</span>}
        </span>
      : <span aria-hidden="true" className="tracking-normal">
          {done}/{total}
        </span>
      }
    </span>
  );
}
