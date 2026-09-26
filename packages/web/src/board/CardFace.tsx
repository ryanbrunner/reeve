import { canStartRun, type ApiCard, type ApiCardLink } from '@reeve/shared';
import { tok, tokenTitle } from '../card/format.js';
import { ACTIVITY_LABELS, ACTIVITY_MARKS, ACTIVITY_STYLE } from './activity.js';
import { NeededByGlyph, SuggestedGlyph, WaitsGlyph } from './Glyph.js';
import { useLinks, type LinkRole } from './links.js';

/**
 * How a card looks while another's chain is traced: what the focused card
 * waits on ringed solid, what waits on it ringed dashed, and everything else
 * stepped back. Suggestions ring the same way in pink. The focused card itself
 * is left alone; the cursor is on it.
 */
const LINK_STYLE: Record<LinkRole, string> = {
  focus: '',
  upstream: 'card-link-up',
  downstream: 'card-link-down',
  origin: 'card-link-origin',
  offshoot: 'card-link-offshoot',
  unlinked: 'card-link-dim',
};
import { MergeButton } from './MergeButton.js';
import { RunButton } from './RunButton.js';

export function CardFace({
  card,
  dragging = false,
  onOpen,
  vibes = false,
  stamped = false,
}: {
  card: ApiCard;
  dragging?: boolean;
  onOpen?: (id: string) => void;
  /**
   * The card as VIBES MODE wears it: a fixed size so it can fly between
   * columns, and a chip naming the guardrail its column is not applying.
   */
  vibes?: boolean;
  /** Just landed on main. The stamp slams on for a couple of seconds and goes. */
  stamped?: boolean;
}) {
  const run = card.latestRun;
  const label = ACTIVITY_LABELS[card.activity];
  // A merged card gets a skin of its own, which exists only in VIBES MODE:
  // there is no calm state for "this is on main now", because on the calm board
  // a person put it there and knows.
  const skin = vibes && card.mergedAt != null ? 'sk-merged' : ACTIVITY_STYLE[card.activity];
  const links = useLinks();
  // The copy under the cursor mid-drag is not on the board, so it neither
  // traces a chain nor takes part in one.
  const role = dragging ? null : links.role(card.id);
  // In VIBES MODE on its own, on the calm board. Not once merged: after that
  // there is nothing left for it to do.
  const solo = !vibes && card.vibes && card.mergedAt == null;
  return (
    <article
      // The card opens its details, but the whole card is also the drag handle.
      // dnd-kit's sensor has a 4px activation distance, so a press that never
      // moved still arrives here as a click and a real drag never does.
      onClick={onOpen ? () => onOpen(card.id) : undefined}
      onMouseEnter={dragging ? undefined : () => links.enter(card.id)}
      onMouseLeave={dragging ? undefined : () => links.leave(card.id)}
      className={`relative cursor-grab rounded-md border p-2.5 transition-opacity duration-150 ${skin} ${
        dragging ? 'rotate-2 shadow-xl shadow-black/40' : ''
      } ${vibes ? 'sk-card' : ''} ${solo ? 'sk-solo-ring' : ''} ${role ? LINK_STYLE[role] : ''}`}
    >
      {ACTIVITY_MARKS[card.activity]}
      {/* The title and footer are positioned so they read above the mark. */}
      <p className={`relative text-sm leading-snug font-medium tracking-[-0.01em] ${vibes ? 'sk-card-title' : ''}`}>
        {card.title}
      </p>
      <div className={`relative mt-2 flex flex-wrap items-center gap-1.5 ${vibes ? 'sk-card-foot' : ''}`}>
        {/* The ring dresses the card; this names why, so it is not left to
            colour alone. */}
        {solo && (
          <span
            className="sk-solo rounded px-[5px] py-px font-mono text-[10px]/4 font-semibold"
            title="In VIBES MODE: Claude approves and merges this card with nobody reviewing it"
          >
            <span>vibes</span>
          </span>
        )}
        {/* In VIBES MODE the repo chip, the Run button and the PR link all give
            way to one chip: at 88px there is room for the state and the bill,
            and nothing on the card is pressable any more anyway. */}
        {vibes ?
          <span className="sk-chip rounded font-mono text-[10px]/4">{vibesChip(card)}</span>
        : card.repoName && (
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[10px]/4"
              style={{ background: `${card.laneColor ?? '#3f4754'}33`, color: card.laneColor ?? '#9aa4b2' }}
            >
              {card.repoName}
            </span>
          )
        }
        {!vibes && <Suggestions card={card} />}
        <Dependencies card={card} vibes={vibes} />
        {label && <span className="sr-only">{label}</span>}
        {/* Only an idle card shows a status chip, and only to surface the run
            status the glow cannot say — a cancelled run. */}
        {!vibes && card.activity === 'idle' && run && (
          <span className="rounded bg-slate-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-slate-300">
            {run.status}
          </span>
        )}
        {run?.totalTokens != null && (
          <span
            title={tokenTitle(run.tokenBreakdown)}
            className={`font-mono text-[10px] leading-snug whitespace-nowrap text-(--color-muted) ${vibes ? 'sk-cost' : ''}`}
          >
            {tok(run.totalTokens)}
          </span>
        )}
        {!vibes && card.mergedAt != null && (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-emerald-300">
            merged
          </span>
        )}
        {!vibes && card.prUrl && (
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
        {!vibes && (card.prConflicting || card.resolvingConflicts) && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-amber-300">
            {card.resolvingConflicts ? 'resolving…' : 'conflicts'}
          </span>
        )}
        {!vibes && card.openingPr && !card.prUrl && (
          <span className="rounded bg-slate-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-slate-300">
            opening PR…
          </span>
        )}
        {!vibes && !dragging && canStartRun(card) && <RunButton card={card} />}
        {/* Never beside Run: that is for a column Claude works in, and this is
            Done's alone. Gone while a push or a resolution is changing the
            branch GitHub's verdict was about. */}
        {!vibes && !dragging && (card.prMergeable || card.mergingPr) && !card.openingPr && !card.resolvingConflicts && (
          <MergeButton card={card} />
        )}
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

/** How many waiting cards the blocked chip names before it says how many more. */
const NAMED = 3;

/**
 * What this card waits on, and how many wait on it.
 *
 * Only an unfinished dependency makes the card blocked, and only those are
 * named on the chip; the tooltip lists every one with where it stands. A card
 * whose dependencies have all finished keeps a quiet chip rather than losing
 * it, because "this waited on #12" is still true and still why it is here —
 * it just no longer reads as a warning.
 *
 * The other direction is lighter on purpose: being needed is not a problem,
 * so it is a glyph and a count, with the names in the tooltip.
 *
 * VIBES MODE's card has one footer line and no room to spare, so there it is
 * the blocked chip alone: the first number and how many more.
 */
function Dependencies({ card, vibes }: { card: ApiCard; vibes: boolean }) {
  const open = card.dependsOn.filter((d) => !d.done);
  const ref = (d: ApiCardLink) => refFrom(card, d);
  // A Done card whose pull request is still open is not done here, and saying
  // so plainly keeps it from reading as work still under way.
  const status = (d: ApiCardLink) => (d.done ? ' (done)' : d.awaitingMerge ? ' (PR not merged)' : '');
  const list = card.dependsOn.map((d) => `${ref(d)} ${d.title}${status(d)}`).join('\n');
  // Free to wrap: a column can be 136px wide, and three refs from another repo
  // are wider than that. VIBES's one footer line cannot wrap, so it names one.
  const chip = 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px]/4';
  const named = vibes ? 1 : NAMED;
  return (
    <>
      {open.length > 0 ?
        <span
          title={`Waits on\n${list}`}
          className={`${chip} bg-(--color-dep-fill) text-(--color-dep) ${vibes ? 'sk-dep whitespace-nowrap' : ''}`}
        >
          <WaitsGlyph />
          <span className="sr-only">Blocked:</span>
          {!vibes && 'waits on'} {open.slice(0, named).map(ref).join(' ')}
          {open.length > named && ` +${open.length - named}`}
        </span>
      : !vibes && card.dependsOn.length > 0 && (
          <span title={`Waited on, all done\n${list}`} className={`${chip} bg-slate-500/15 text-(--color-muted)`}>
            <WaitsGlyph open />
            <span className="sr-only">Dependencies done:</span>
            {card.dependsOn.slice(0, NAMED).map(ref).join(' ')}
            {card.dependsOn.length > NAMED && ` +${card.dependsOn.length - NAMED}`}
          </span>
        )
      }
      {!vibes && card.dependents.length > 0 && (
        <span
          title={`${card.dependents.length} ${card.dependents.length === 1 ? 'card waits' : 'cards wait'} on this`}
          className="inline-flex items-center gap-1 font-mono text-[10px]/4 text-(--color-muted)"
        >
          <NeededByGlyph />
          <span className="sr-only">Needed by</span>
          {card.dependents.length}
        </span>
      )}
    </>
  );
}

/** `#142` is per repo, so a card in another repo from this one says which. */
function refFrom(card: ApiCard, to: { number: number; repoName: string | null }): string {
  return `${to.repoName && to.repoName !== card.repoName ? to.repoName : ''}#${to.number}`;
}

/**
 * Which card suggested this one, and how many this one suggested, drawn the
 * way dependencies are but in pink: a suggestion holds nothing up, and must
 * not read as something that does. Neither is on VIBES MODE's one-line card,
 * which has no room for what is not a blocker.
 *
 * The suggester is named, as a dependency is, because it has often merged and
 * gone by the time anyone looks. What this card suggested is a count, with
 * the titles the board still has in the tooltip.
 */
function Suggestions({ card }: { card: ApiCard }) {
  const links = useLinks();
  const from = card.suggestedBy;
  const n = card.suggestions.length;
  const titles = card.suggestions
    .map((id) => links.card(id))
    .filter((c) => c !== undefined)
    .map((c) => `${refFrom(card, c)} ${c.title}`);
  return (
    <>
      {from && (
        <span
          title={`Suggested by\n${refFrom(card, from)} ${from.title}`}
          className="inline-flex items-center gap-1 rounded bg-(--color-sug-fill) px-1.5 py-0.5 font-mono text-[10px]/4 text-(--color-sug)"
        >
          <SuggestedGlyph />
          <span className="sr-only">Suggested by</span>
          from {refFrom(card, from)}
        </span>
      )}
      {n > 0 && (
        <span
          title={[`Suggested ${n} ${n === 1 ? 'card' : 'cards'}`, ...titles].join('\n')}
          className="inline-flex items-center gap-1 font-mono text-[10px]/4 text-(--color-sug)"
        >
          <SuggestedGlyph />
          <span className="sr-only">Suggested</span>
          {n}
        </span>
      )}
    </>
  );
}

/**
 * What the card's column is not doing for it.
 *
 * Each one names the guardrail that column applies on the calm board and does
 * not apply here — the chip is the card telling you what it got away with.
 */
function vibesChip(card: ApiCard): string {
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
