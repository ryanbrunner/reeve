import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STAGE_LABELS, type ApiCard } from '@reeve/shared';
import { api } from '../lib/api.js';
import { when } from '../card/format.js';
import { Empty, SmallButton } from '../card/ui.js';

/**
 * Every card taken off the board, newest first.
 *
 * Archiving is the board's only delete, and it is soft precisely so that this
 * list can exist: a card archived by mistake is one click from where it was.
 * Opening one hands over to the card modal rather than stacking on top of it —
 * both listen for Escape on the document, and two dialogs answering the same
 * keystroke is a bug waiting to be found.
 */
export function ArchiveModal({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['archived'], queryFn: api.archivedCards });
  const cards = data ?? [];
  const panel = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      restoreFocus.current?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 sm:p-10">
      <div className="absolute inset-0 bg-[#0e1116c2]" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-title"
        tabIndex={-1}
        className="relative flex h-[min(640px,100%)] w-[min(760px,100%)] flex-col overflow-hidden rounded-lg border border-(--color-edge) bg-(--color-panel) outline-none"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-(--color-edge) px-5 py-3.5">
          <h2 id="archive-title" className="text-[18px]/[26px] font-medium tracking-[-0.01em]">
            Archive
          </h2>
          <span className="font-mono text-[11px]/4 tracking-[0.06em] text-(--color-muted) uppercase">
            {cards.length} {cards.length === 1 ? 'card' : 'cards'}
          </span>
          <div className="grow" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close archive"
            className="flex items-center gap-1.5 rounded-sm border border-(--color-edge) py-[3px] pr-1 pl-2 font-mono text-[11px]/4 text-(--color-text) hover:border-slate-600"
          >
            Close
            <kbd className="rounded-[3px] bg-(--color-ink) px-1 font-mono text-[10px]/[14px] text-(--color-muted)">
              esc
            </kbd>
          </button>
        </header>

        <div className="flex min-h-0 grow flex-col overflow-y-auto p-5">
          {isLoading ?
            <Empty>Loading archive…</Empty>
          : error ?
            <Empty>Could not load the archive. {error.message}</Empty>
          : cards.length === 0 ?
            <Empty>Nothing archived. A card deleted from its header lands here.</Empty>
          : <ul className="-mx-1.5 flex flex-col">
              {cards.map((card) => (
                <ArchivedRow key={card.id} card={card} onOpen={onOpen} />
              ))}
            </ul>
          }
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ArchivedRow({ card, onOpen }: { card: ApiCard; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const restore = useMutation({
    mutationFn: () => api.restoreCard(card.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['archived'] });
      void qc.invalidateQueries({ queryKey: ['board'] });
      void qc.invalidateQueries({ queryKey: ['card', card.id] });
    },
  });

  return (
    <li className="flex items-center gap-3 rounded-sm border border-transparent px-1.5 py-1.5 hover:border-(--color-edge) hover:bg-white/4">
      <button
        type="button"
        onClick={() => onOpen(card.id)}
        className="flex min-w-0 grow items-center gap-2 text-left"
      >
        {card.repoName && (
          <span
            className="shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px]/4"
            style={{ background: `${card.laneColor ?? '#3f4754'}33`, color: card.laneColor ?? '#9aa4b2' }}
          >
            {card.repoName}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px]/4 text-(--color-muted)">#{card.number}</span>
        <span className="min-w-0 truncate text-sm text-(--color-text)">{card.title}</span>
      </button>
      <span className="shrink-0 font-mono text-[10px]/4 text-(--color-muted)">
        {STAGE_LABELS[card.stage]} · {when(card.archivedAt)}
      </span>
      {restore.error && (
        <span className="shrink-0 font-mono text-[10px]/4 text-red-300">{restore.error.message}</span>
      )}
      <SmallButton tone="sky" disabled={restore.isPending} onClick={() => restore.mutate()}>
        {restore.isPending ? 'Restoring…' : 'Restore'}
      </SmallButton>
    </li>
  );
}
