import { STAGE_LABELS, isRunnable, type CardDetail } from '@reeve/shared';
import { AttentionBand } from './AttentionBand.js';
import { cost, plural, when } from './format.js';
import type { LiveRun } from './useCardDetail.js';

/**
 * Who this card is, and then what it wants from you.
 *
 * The identity line is fixed; the band below it is whatever the card's activity
 * says needs doing, or nothing at all for a card quietly sitting in Backlog.
 */
export function CardHeader({
  detail,
  live,
  onClose,
}: {
  detail: CardDetail;
  live: LiveRun | null;
  onClose: () => void;
}) {
  const { card } = detail;
  const runs = detail.runs.filter((r) => r.kind === 'claude');
  const spent = runs.reduce((n, r) => n + (r.totalCostUsd ?? 0), 0);
  const running = card.activity === 'running';

  return (
    <header className="relative shrink-0 border-b border-(--color-edge) px-5 pt-3.5 pb-4">
      <div className="relative flex items-center gap-2">
        {card.projectName && (
          <span
            className="rounded-sm px-1.5 py-0.5 font-mono text-[10px]/4"
            style={{ background: `${card.laneColor ?? '#3f4754'}33`, color: card.laneColor ?? '#9aa4b2' }}
          >
            {card.projectName}
          </span>
        )}
        <span className="font-mono text-[11px]/4 text-(--color-muted)">#{card.number}</span>
        <span aria-hidden="true" className="h-3 w-px bg-(--color-edge)" />
        <span className="flex items-center gap-1.5 font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-text) uppercase">
          {STAGE_LABELS[card.stage]}
          {isRunnable(card.stage) && (
            <span title="Claude runs here" className="text-[10px] text-sky-500">◆</span>
          )}
        </span>
        <div className="grow" />
        <span className="font-mono text-[10px]/4 text-(--color-muted)">Updated {when(card.updatedAt)}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close card details"
          className="flex items-center gap-1.5 rounded-sm border border-(--color-edge) py-[3px] pr-1 pl-2 font-mono text-[11px]/4 text-(--color-text) hover:border-slate-600"
        >
          Close
          <kbd className="rounded-[3px] bg-(--color-ink) px-1 font-mono text-[10px]/[14px] text-(--color-muted)">
            esc
          </kbd>
        </button>
      </div>

      <h2
        id="card-title"
        className="relative mt-2.5 max-w-[32rem] text-[18px]/[26px] font-medium tracking-[-0.01em] text-(--color-text)"
      >
        {card.title}
      </h2>

      <div className="relative mt-1 font-mono text-[11px]/4 text-(--color-muted)">
        {/* "by you" is rendered, never stored: there is one person, and the day
            there are two this is the line that changes. */}
        Created {when(card.createdAt)} by you ·{' '}
        {runs.length === 0 ? 'No runs yet' : `${plural(runs.length, 'run')} · ${cost(spent)}`}
        {running && runs.length > 0 && ' so far'}
      </div>

      <AttentionBand detail={detail} live={live} />
    </header>
  );
}
