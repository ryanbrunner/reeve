import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { isRunnable, RUNNABLE_STAGES, type CardActivity, type CardDetail, type RunnableStage } from '@reeve/shared';
import {
  ACTIVITY_LABELS, ACTIVITY_MARKS, isMerged, MERGED_LABEL, MERGED_MARK, MERGED_STYLE, shownActivity, STARTING_LABEL,
  SUGGESTION_LABEL, SUGGESTION_MARK, SUGGESTION_STYLE,
} from '../board/activity.js';
import { api } from '../lib/api.js';
import { CardHeader } from './CardHeader.js';
import { Rail } from './Rail.js';
import { Tabs, defaultTab, type TabId } from './Tabs.js';
import { useCardDetail, useLiveRun, type LiveRun } from './useCardDetail.js';
import { Composer } from './conversation/Composer.js';
import { ConversationThread, StageTabs, type StageTab } from './conversation/ConversationView.js';
import { useConversation } from './conversation/useConversation.js';

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

const MERGED_GLOW = `${MERGED_STYLE} modal-glow-merged`;
const SUGGESTION_GLOW = `${SUGGESTION_STYLE} modal-glow-suggested`;

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

  // Worn as the board card wears it, starting included; `live` above keys off
  // the real activity, since a start has no run to stream yet.
  const activity = data ? shownActivity(data.card) : 'idle';
  // The ring the card wears on the calm board when it is in VIBES MODE alone,
  // at this size too: it is the same card. Not in the board's VIBES MODE, which
  // dresses every card the same and so has nothing to single this one out for.
  // A task in a project in VIBES MODE wears it too, off the board, since the
  // card carries only its own flag; a project wears it for its own switch.
  const { data: board } = useQuery({ queryKey: ['board'], queryFn: api.board });
  const lane = board?.projects.find((p) => p.id === data?.card.projectId)?.vibes === true;
  const solo = !vibes && (data?.card.vibes === true || lane) && data?.card.mergedAt == null;
  // Finished, in the same green and circled check the board card wears. Not in
  // VIBES MODE, whose card wears its own pink for this and no mark.
  const merged = !vibes && data != null && isMerged(data.card);
  // A suggestion waiting on a decision, in the pink and lightbulb the board
  // card wears. The band in the header is where it is decided.
  const suggested = !vibes && !merged && data?.card.pendingSuggestion === true;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 sm:p-10">
      <div className="absolute inset-0 bg-[#0e1116c2]" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-title"
        tabIndex={-1}
        className={`relative flex h-[min(900px,100%)] w-[min(1320px,100%)] flex-col overflow-hidden rounded-lg border outline-none ${merged ? MERGED_GLOW : suggested ? SUGGESTION_GLOW : GLOW[activity]} ${solo ? 'sk-solo-ring' : ''}`}
      >
        {isLoading && <Middle>Loading card…</Middle>}
        {error && <Middle>Could not load this card. {error.message}</Middle>}
        {data && (
          <>
            {/* A task is its conversation with Claude, with the documents it
                produced beside it. A project has no stages to talk in, and in
                VIBES MODE nobody is talking — you do not get to see how — so
                both keep the card as its readings. */}
            {data.card.kind === 'task' && !vibes ? (
              <Conversation detail={data} live={live} onClose={onClose} onOpen={onOpen} editTitle={editTitle} />
            ) : (
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
              </>
            )}
            {/* The same rail of light the board card carries while Claude works. */}
            {activity === 'running' && (
              <span className="card-rail" aria-hidden="true">
                <span />
              </span>
            )}
            <span className="sr-only">
              {merged ? MERGED_LABEL
                : suggested ? SUGGESTION_LABEL
                : data.card.startingStage ? STARTING_LABEL
                : ACTIVITY_LABELS[activity]}
            </span>
          </>
        )}
        {/* Decorative, and behind the header rather than the whole panel. */}
        {data && (merged ? MERGED_MARK : suggested ? SUGGESTION_MARK : ACTIVITY_MARKS[activity])}
      </div>
    </div>,
    document.body,
  );
}

function Middle({ children }: { children: React.ReactNode }) {
  return <div className="flex grow items-center justify-center text-sm text-(--color-muted)">{children}</div>;
}

/**
 * The card as a conversation: stage tabs, the thread, and the composer under
 * it, with the stage's documents and the card's facts in a panel beside.
 */
function Conversation({ detail, live, onClose, onOpen, editTitle }: {
  detail: CardDetail;
  live: LiveRun | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  editTitle: boolean;
}) {
  const { conversation } = useConversation(detail);
  const stage = detail.card.stage;
  const [tab, setTab] = useState<StageTab>(() => openingStage(detail));
  // Follows the card into each stage it moves to, which is where the talking is.
  useEffect(() => {
    if (isRunnable(stage)) setTab(stage as RunnableStage);
  }, [stage]);

  // Wide enough for the thread and the panel together, or the panel waits
  // behind its button.
  const [sideOpen, setSideOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1100);
  const [sideTab, setSideTab] = useState<TabId>(() => defaultTab(detail, false));

  return (
    <>
      <CardHeader detail={detail} live={live} onClose={onClose} editTitle={editTitle} band={false} />
      <div className="flex min-h-0 grow">
        <section aria-label="Conversation" className="flex min-w-0 grow flex-col bg-(--color-ink)/90">
          <StageTabs detail={detail} conversation={conversation} tab={tab} onTab={setTab} />
          <ConversationThread
            detail={detail}
            conversation={conversation}
            tab={tab}
            onOpenPanel={(panel) => {
              setSideTab(panel);
              setSideOpen(true);
            }}
          />
          <Composer detail={detail} live={live} tab={tab} onClose={onClose} />
        </section>
        {sideOpen ? (
          <aside aria-label="Documents and facts" className="flex w-[420px] shrink-0 flex-col border-l border-(--color-edge) bg-(--color-card-core) max-md:w-full max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-10">
            <Tabs detail={detail} onOpen={onOpen} side tab={sideTab} onTab={setSideTab} onCollapse={() => setSideOpen(false)} />
          </aside>
        ) : (
          <button
            type="button"
            title="Show the plan, changes, preview and the card's facts"
            onClick={() => setSideOpen(true)}
            className="flex w-11 shrink-0 flex-col items-center gap-3 border-l border-(--color-edge) bg-(--color-card-core) pt-3 font-mono text-[11px] text-(--color-muted) hover:text-(--color-text)"
          >
            <span aria-hidden="true">⇤</span>
            <span className="[writing-mode:vertical-rl] tracking-[0.06em] uppercase">Plan · Changes · Card</span>
          </button>
        )}
      </div>
    </>
  );
}

/** The stage the conversation opens on: the card's own, or the last one it talked in. */
function openingStage(detail: CardDetail): StageTab {
  const stage = detail.card.stage;
  if (isRunnable(stage)) return stage as RunnableStage;
  const talked = RUNNABLE_STAGES.filter((s) => detail.runs.some((r) => r.kind === 'claude' && r.task === null && r.stage === s));
  return talked.at(-1) ?? 'planning';
}
