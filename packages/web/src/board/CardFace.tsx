import { canStartRun, type ApiCard } from '@reeve/shared';
import { ACTIVITY_LABELS, ACTIVITY_MARKS, ACTIVITY_STYLE } from './activity.js';
import { RunButton } from './RunButton.js';

export function CardFace({
  card,
  dragging = false,
  onOpen,
  sicko = false,
  stamped = false,
}: {
  card: ApiCard;
  dragging?: boolean;
  onOpen?: (id: string) => void;
  /**
   * The card as SICKO MODE wears it: a fixed size so it can fly between
   * columns, and a chip naming the guardrail its column is not applying.
   */
  sicko?: boolean;
  /** Just landed on main. The stamp slams on for a couple of seconds and goes. */
  stamped?: boolean;
}) {
  const run = card.latestRun;
  const label = ACTIVITY_LABELS[card.activity];
  // A merged card gets a skin of its own, which exists only in SICKO MODE:
  // there is no calm state for "this is on main now", because on the calm board
  // a person put it there and knows.
  const skin = sicko && card.mergedAt != null ? 'sk-merged' : ACTIVITY_STYLE[card.activity];
  return (
    <article
      // The card opens its details, but the whole card is also the drag handle.
      // dnd-kit's sensor has a 4px activation distance, so a press that never
      // moved still arrives here as a click and a real drag never does.
      onClick={onOpen ? () => onOpen(card.id) : undefined}
      className={`relative cursor-grab rounded-md border p-2.5 ${skin} ${
        dragging ? 'rotate-2 shadow-xl shadow-black/40' : ''
      } ${sicko ? 'sk-card' : ''}`}
    >
      {ACTIVITY_MARKS[card.activity]}
      {/* The title and footer are positioned so they read above the mark. */}
      <p className={`relative text-sm leading-snug font-medium tracking-[-0.01em] ${sicko ? 'sk-card-title' : ''}`}>
        {card.title}
      </p>
      <div className={`relative mt-2 flex flex-wrap items-center gap-1.5 ${sicko ? 'sk-card-foot' : ''}`}>
        {/* In SICKO MODE the repo chip, the Run button and the PR link all give
            way to one chip: at 88px there is room for the state and the bill,
            and nothing on the card is pressable any more anyway. */}
        {sicko ?
          <span className="sk-chip rounded font-mono text-[10px]/4">{sickChip(card)}</span>
        : card.repoName && (
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[10px]/4"
              style={{ background: `${card.laneColor ?? '#3f4754'}33`, color: card.laneColor ?? '#9aa4b2' }}
            >
              {card.repoName}
            </span>
          )
        }
        {label && <span className="sr-only">{label}</span>}
        {/* Only an idle card shows a status chip, and only to surface the run
            status the glow cannot say — a cancelled run. */}
        {!sicko && card.activity === 'idle' && run && (
          <span className="rounded bg-slate-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-slate-300">
            {run.status}
          </span>
        )}
        {run?.totalCostUsd != null && (
          <span className={`font-mono text-[10px] leading-snug text-(--color-muted) ${sicko ? 'sk-cost' : ''}`}>
            ${run.totalCostUsd.toFixed(3)}
          </span>
        )}
        {!sicko && card.mergedAt != null && (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-emerald-300">
            merged
          </span>
        )}
        {!sicko && card.prUrl && (
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
        {/* GitHub's verdict, which the server only has for a Done card's open pull request. */}
        {!sicko && (card.prConflicting || card.resolvingConflicts) && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-amber-300">
            {card.resolvingConflicts ? 'resolving…' : 'conflicts'}
          </span>
        )}
        {!sicko && card.openingPr && !card.prUrl && (
          <span className="rounded bg-slate-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-slate-300">
            opening PR…
          </span>
        )}
        {!sicko && !dragging && canStartRun(card) && <RunButton card={card} />}
      </div>
      {card.activity === 'running' && (
        <span className="card-rail" aria-hidden="true">
          <span />
        </span>
      )}
      {stamped && <span className="sk-stamp" aria-hidden="true">Merged</span>}
    </article>
  );
}

/**
 * What the card's column is not doing for it.
 *
 * Each one names the guardrail that column applies on the calm board and does
 * not apply here — the chip is the card telling you what it got away with.
 */
function sickChip(card: ApiCard): string {
  if (card.activity === 'error') return 'error ignored';
  switch (card.stage) {
    case 'backlog':
      return 'auto-run';
    case 'planning':
      return 'self-answered';
    case 'in_progress':
      return 'no tests';
    case 'testing':
      return 'auto-approved';
    case 'done':
      return card.mergedAt != null ? 'merged → main' : card.prUrl ? 'merging → main' : 'straight to main';
  }
}
