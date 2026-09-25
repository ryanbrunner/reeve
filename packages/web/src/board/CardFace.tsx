import { canStartRun, type ApiCard } from '@reeve/shared';
import { ACTIVITY_LABELS, ACTIVITY_MARKS, ACTIVITY_STYLE } from './activity.js';
import { RunButton } from './RunButton.js';

export function CardFace({
  card,
  dragging = false,
  onOpen,
}: {
  card: ApiCard;
  dragging?: boolean;
  onOpen?: (id: string) => void;
}) {
  const run = card.latestRun;
  const label = ACTIVITY_LABELS[card.activity];
  return (
    <article
      // The card opens its details, but the whole card is also the drag handle.
      // dnd-kit's sensor has a 4px activation distance, so a press that never
      // moved still arrives here as a click and a real drag never does.
      onClick={onOpen ? () => onOpen(card.id) : undefined}
      className={`relative cursor-grab rounded-md border p-2.5 ${ACTIVITY_STYLE[card.activity]} ${
        dragging ? 'rotate-2 shadow-xl shadow-black/40' : ''
      }`}
    >
      {ACTIVITY_MARKS[card.activity]}
      {/* The title and footer are positioned so they read above the mark. */}
      <p className="relative text-sm leading-snug font-medium tracking-[-0.01em]">{card.title}</p>
      <div className="relative mt-2 flex flex-wrap items-center gap-1.5">
        {card.projectName && (
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[10px]/4"
            style={{ background: `${card.laneColor ?? '#3f4754'}33`, color: card.laneColor ?? '#9aa4b2' }}
          >
            {card.projectName}
          </span>
        )}
        {label && <span className="sr-only">{label}</span>}
        {/* Only an idle card shows a status chip, and only to surface the run
            status the glow cannot say — a cancelled run. */}
        {card.activity === 'idle' && run && (
          <span className="rounded bg-slate-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-slate-300">
            {run.status}
          </span>
        )}
        {run?.totalCostUsd != null && (
          <span className="font-mono text-[10px] leading-snug text-(--color-muted)">
            ${run.totalCostUsd.toFixed(3)}
          </span>
        )}
        {card.mergedAt != null && (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-emerald-300">
            merged
          </span>
        )}
        {card.prUrl && (
          <a
            href={card.prUrl}
            target="_blank"
            rel="noreferrer"
            // The whole card is the drag handle, so the press has to stop here
            // or the pointer sensor treats a click as the start of a drag.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            title={card.prUrl}
            className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-sky-300 hover:bg-sky-500/25"
          >
            PR{card.prNumber != null && ` #${card.prNumber}`}
          </a>
        )}
        {card.openingPr && !card.prUrl && (
          <span className="rounded bg-slate-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-slate-300">
            opening PR…
          </span>
        )}
        {!dragging && canStartRun(card) && <RunButton card={card} />}
      </div>
      {card.activity === 'running' && (
        <span className="card-rail" aria-hidden="true">
          <span />
        </span>
      )}
    </article>
  );
}
