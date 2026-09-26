import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { CardActivity } from '@reeve/shared';
import { ACTIVITY_LABELS, ACTIVITY_MARKS } from '../board/activity.js';
import { CardHeader } from './CardHeader.js';
import { Rail } from './Rail.js';
import { Tabs } from './Tabs.js';
import { useCardDetail, useLiveRun } from './useCardDetail.js';

/**
 * A card, opened.
 *
 * It wears the card's own glow at ten times the size, because this is the same
 * card and not a different place. The scrim is a plain element rather than a
 * `<dialog>`'s `::backdrop`: `showModal()` promotes to the top layer, and the
 * panel's outer bloom is supposed to fall on the board behind it, which it
 * cannot do from a separate stacking context.
 *
 * Which means focus and Escape are ours to handle, below.
 */
const GLOW: Record<CardActivity, string> = {
  idle: 'border-(--color-edge) bg-(--color-panel)',
  running: 'card-glow card-glow-running modal-glow-running',
  needs_review: 'card-glow card-glow-review modal-glow-review',
  needs_input: 'card-glow card-glow-input modal-glow-input',
  error: 'card-glow card-glow-error modal-glow-error',
};

export function CardModal({ cardId, onClose, onOpen, editTitle = false, vibes = false }: {
  cardId: string;
  onClose: () => void;
  /** Open another card in this one's place: a project's task, or one of a task's dependencies. */
  onOpen: (id: string) => void;
  /** Open with the title selected for typing over: a card just made. */
  editTitle?: boolean;
  /** VIBES MODE: the work happens, but you do not get to see how. */
  vibes?: boolean;
}) {
  const { data, isLoading, error } = useCardDetail(cardId);
  const panel = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const run = data?.card.latestRun ?? null;
  const live = useLiveRun(cardId, run?.id ?? null, data?.card.activity === 'running', run?.startedAt ?? null);

  // Escape closes, and focus goes back where it came from. The board behind is
  // inert only in the sense that the scrim swallows clicks — a modal this size
  // is read more than it is tabbed through, and trapping focus outright costs
  // more than it buys here.
  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    // A new card's header selects its title, and that survives this only
    // because the header mounts later, once the card has loaded. Seeding the
    // detail query so it rendered at once would let this take focus back.
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Not while someone is typing. Escape closing the modal out from under a
      // half-written brief or a rejection note would throw away their words on
      // one keystroke. Leaving the field is enough, and the brief and title
      // save when they lose focus.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        target.blur();
        return;
      }
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

  const activity = data?.card.activity ?? 'idle';
  // The ring the card wears on the calm board when it is in VIBES MODE alone,
  // at this size too: it is the same card. Not in the board's VIBES MODE, which
  // dresses every card the same and so has nothing to single this one out for.
  const solo = !vibes && data?.card.vibes === true && data.card.mergedAt == null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 sm:p-10">
      <div className="absolute inset-0 bg-[#0e1116c2]" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-title"
        tabIndex={-1}
        className={`relative flex h-[min(820px,100%)] w-[min(1160px,100%)] flex-col overflow-hidden rounded-lg border outline-none ${GLOW[activity]} ${solo ? 'sk-solo-ring' : ''}`}
      >
        {isLoading && <Middle>Loading card…</Middle>}
        {error && <Middle>Could not load this card. {error.message}</Middle>}
        {data && (
          <>
            <CardHeader detail={data} live={live} onClose={onClose} editTitle={editTitle} />
            <div className="flex min-h-0 grow">
              <Tabs detail={data} onOpen={onOpen} vibes={vibes} />
              {/* The rail is the card's way through the stages, and a project
                  has none. In VIBES MODE the whole rail goes rather than parts
                  of it: every control and fact on it is a lever or a look under
                  the hood. */}
              {data.card.kind === 'task' && !vibes && <Rail detail={data} onOpen={onOpen} />}
            </div>
            {/* The same rail of light the board card carries while Claude works. */}
            {activity === 'running' && (
              <span className="card-rail" aria-hidden="true">
                <span />
              </span>
            )}
            <span className="sr-only">{ACTIVITY_LABELS[activity]}</span>
          </>
        )}
        {/* Decorative, and behind the header rather than the whole panel. */}
        {data && ACTIVITY_MARKS[activity]}
      </div>
    </div>,
    document.body,
  );
}

function Middle({ children }: { children: React.ReactNode }) {
  return <div className="flex grow items-center justify-center text-sm text-(--color-muted)">{children}</div>;
}
