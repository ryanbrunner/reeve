import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { STAGE_LABELS, isRunnable, type CardDetail } from '@reeve/shared';
import { api } from '../lib/api.js';
import { AttentionBand } from './AttentionBand.js';
import { cost, plural, when } from './format.js';
import { SmallButton } from './ui.js';
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
  editTitle = false,
}: {
  detail: CardDetail;
  live: LiveRun | null;
  onClose: () => void;
  /** Arrive with the title selected, so typing replaces it. For a card just made. */
  editTitle?: boolean;
}) {
  const { card } = detail;
  const runs = detail.runs.filter((r) => r.kind === 'claude');
  const spent = runs.reduce((n, r) => n + (r.totalCostUsd ?? 0), 0);
  const running = card.activity === 'running';

  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['card', card.id] });
    void qc.invalidateQueries({ queryKey: ['board'] });
    void qc.invalidateQueries({ queryKey: ['archived'] });
  };
  // Closes on success: the card has left the board, and the archive is where
  // it can be found again — which is also why there is no "are you sure".
  const archive = useMutation({
    mutationFn: () => api.archiveCard(card.id),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const restore = useMutation({ mutationFn: () => api.restoreCard(card.id), onSuccess: invalidate });
  const rename = useMutation({
    mutationFn: (title: string) => api.updateCard(card.id, { title }),
    onSuccess: invalidate,
  });
  const failed = archive.error ?? restore.error ?? rename.error;

  // The heading is the field. It is left to the DOM while it is being typed in,
  // so everything that ends an edit without saving one — an empty title, no
  // change, a failed save — has to put the text back by hand.
  const commit = (el: HTMLElement) => {
    // Collapsed, not just trimmed: Enter is handled, but a pasted paragraph
    // still arrives with its newlines in it, and a title is one line.
    const title = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!title || title === card.title) {
      el.textContent = card.title;
      return;
    }
    rename.mutate(title, {
      onError: () => {
        el.textContent = card.title;
      },
    });
  };

  // Selected rather than just focused: a bare caret would leave "Untitled" in
  // front of whatever was typed. Once per header, not per heading — the heading
  // remounts on every saved rename, and taking focus back then would pull it out
  // of the brief just as someone moved on to it. This only holds because the
  // header mounts after the card has loaded, and so after the modal has focused
  // its panel; were it there on the first render, the panel would win.
  const heading = useRef<HTMLHeadingElement>(null);
  const selected = useRef(false);
  useEffect(() => {
    const el = heading.current;
    if (!editTitle || selected.current || !el) return;
    selected.current = true;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editTitle]);

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
        {card.archivedAt ?
          <>
            <span className="font-mono text-[10px]/4 text-(--color-muted)">Archived {when(card.archivedAt)}</span>
            <SmallButton tone="sky" disabled={restore.isPending} onClick={() => restore.mutate()}>
              {restore.isPending ? 'Restoring…' : 'Restore'}
            </SmallButton>
          </>
        : <>
            <span className="font-mono text-[10px]/4 text-(--color-muted)">Updated {when(card.updatedAt)}</span>
            <SmallButton
              disabled={running || archive.isPending}
              title={running ? 'Stop the run before deleting' : 'Take the card off the board. The Archive can restore it.'}
              onClick={() => archive.mutate()}
            >
              {archive.isPending ? 'Deleting…' : 'Delete'}
            </SmallButton>
          </>
        }
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

      {/* Keyed on the title so a saved rename remounts it with React's text,
          not the text the browser was left holding. */}
      <h2
        key={card.title}
        ref={heading}
        id="card-title"
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        title="Click to edit"
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          e.currentTarget.blur();
        }}
        className="relative -mx-1.5 mt-2.5 max-w-[33rem] cursor-text rounded-sm border border-transparent px-1.5 text-[18px]/[26px] font-medium tracking-[-0.01em] text-(--color-text) outline-none hover:border-(--color-edge) focus:border-sky-600"
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
      {failed && <p className="relative mt-1 font-mono text-[10px]/4 text-red-300">{failed.message}</p>}

      <AttentionBand detail={detail} live={live} />
    </header>
  );
}
