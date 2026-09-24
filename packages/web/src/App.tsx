import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  STAGES,
  STAGE_LABELS,
  canStartRun,
  isRunnable,
  type ApiCard,
  type BoardResponse,
  type CardActivity,
  type Stage,
} from '@reeve/shared';
import { api, cardsIn } from './lib/api.js';

const COLUMN_PREFIX = 'col:';

export function App() {
  const qc = useQueryClient();
  const [swimlanes, setSwimlanes] = useState(false);
  const [dragging, setDragging] = useState<ApiCard | null>(null);

  const move = useMutation({
    mutationFn: ({ id, stage, index }: { id: string; stage: Stage; index: number }) =>
      api.moveCard(id, { stage, index }),
    // Optimistic: the card must land under the cursor immediately, not after a round trip.
    onMutate: async ({ id, stage, index }) => {
      await qc.cancelQueries({ queryKey: ['board'] });
      const prev = qc.getQueryData<BoardResponse>(['board']);
      if (prev) {
        const moving = prev.cards.find((c) => c.id === id);
        if (moving) {
          const others = cardsIn(prev.cards, stage).filter((c) => c.id !== id);
          const before = others[index - 1]?.position;
          const after = others[index]?.position;
          const position =
            before === undefined && after === undefined ? 1000
            : before === undefined ? after! - 1000
            : after === undefined ? before + 1000
            : (before + after) / 2;
          qc.setQueryData<BoardResponse>(['board'], {
            ...prev,
            cards: prev.cards.map((c) => (c.id === id ? { ...c, stage, position } : c)),
          });
        }
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(['board'], ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ['board'] }),
  });

  // A card's activity changes on its own as a run progresses, and nothing pushes
  // that to the board — the SSE stream is per-run, not board-wide — so it polls:
  // briskly while Claude is working, lazily when the board is quiet. Paused
  // mid-drag so a refetch cannot yank a card out from under the cursor.
  const held = dragging !== null || move.isPending;
  const { data, isLoading, error } = useQuery({
    queryKey: ['board'],
    queryFn: api.board,
    staleTime: 0,
    refetchInterval: (q) =>
      held ? false : q.state.data?.cards.some((c) => c.activity === 'running') ? 1_500 : 5_000,
  });

  const create = useMutation({
    mutationFn: api.createCard,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board'] }),
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const cards = data?.cards ?? [];
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  function onDragStart(e: DragStartEvent) {
    setDragging(byId.get(String(e.active.id)) ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const { active, over } = e;
    if (!over) return;
    const id = String(active.id);
    const overId = String(over.id);
    const card = byId.get(id);
    if (!card) return;

    // Dropped on empty column space, or onto another card.
    let stage: Stage;
    let index: number;
    if (overId.startsWith(COLUMN_PREFIX)) {
      stage = overId.slice(COLUMN_PREFIX.length).split('|')[0] as Stage;
      index = cardsIn(cards, stage).filter((c) => c.id !== id).length;
    } else {
      const target = byId.get(overId);
      if (!target) return;
      stage = target.stage;
      index = cardsIn(cards, stage).filter((c) => c.id !== id).findIndex((c) => c.id === overId);
      if (index < 0) index = 0;
    }
    if (card.stage === stage && index < 0) return;
    move.mutate({ id, stage, index });
  }

  if (isLoading) return <Centered>Loading board…</Centered>;
  if (error) return <Centered>Could not reach the server. Is <code className="mx-1 text-sky-300">npm run dev</code> running?</Centered>;

  const lanes = swimlanes
    ? (data?.projects ?? []).map((p) => ({ id: p.id as string | null, name: p.name, color: p.laneColor }))
    : [{ id: undefined as unknown as string | null, name: '', color: null }];

  return (
    <div className="flex h-full flex-col">
      <Header
        swimlanes={swimlanes}
        onToggle={() => setSwimlanes((s) => !s)}
        onAdd={(title) => create.mutate({ title, stage: 'backlog' })}
        cardCount={cards.length}
      />
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="flex-1 overflow-auto p-4">
          {lanes.map((lane) => (
            <section key={lane.id ?? 'all'} className="mb-6 last:mb-0">
              {swimlanes && (
                <h2 className="mb-2 flex items-center gap-2 font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted) uppercase">
                  <span className="h-2 w-2 rounded-full" style={{ background: lane.color ?? '#3f4754' }} />
                  {lane.name}
                </h2>
              )}
              <div className="grid grid-cols-6 gap-3 min-w-[1100px]">
                {STAGES.map((stage) => (
                  <Column
                    key={stage}
                    stage={stage}
                    laneId={lane.id}
                    cards={cardsIn(cards, stage, lane.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
        <DragOverlay>{dragging ? <CardFace card={dragging} dragging /> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}

function Header({ swimlanes, onToggle, onAdd, cardCount }: {
  swimlanes: boolean; onToggle: () => void; onAdd: (title: string) => void; cardCount: number;
}) {
  const [title, setTitle] = useState('');
  return (
    <header className="flex items-center gap-3 border-b border-(--color-edge) px-4 py-3">
      <h1 className="text-sm font-semibold tracking-[-0.02em]">Reeve</h1>
      <span className="font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted)">
        {cardCount} cards
      </span>
      <form
        className="ml-auto flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); if (title.trim()) { onAdd(title.trim()); setTitle(''); } }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New idea → Backlog"
          className="w-64 rounded-md border border-(--color-edge) bg-(--color-panel) px-3 py-1.5 text-sm outline-none placeholder:text-(--color-muted) focus:border-sky-600"
        />
        <button type="submit" className="rounded-md bg-sky-700 px-3 py-1.5 text-sm font-medium hover:bg-sky-600">
          Add
        </button>
      </form>
      <button
        onClick={onToggle}
        className={`rounded-md border px-3 py-1.5 text-sm ${swimlanes ? 'border-sky-600 text-sky-300' : 'border-(--color-edge) text-(--color-muted)'}`}
      >
        Swim lanes
      </button>
    </header>
  );
}

function Column({ stage, laneId, cards }: { stage: Stage; laneId: string | null | undefined; cards: ApiCard[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${stage}|${laneId ?? 'all'}` });
  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-32 flex-col rounded-lg border p-2 transition-colors ${
        isOver ? 'border-sky-600 bg-sky-950/20' : 'border-(--color-edge) bg-(--color-panel)/40'
      }`}
    >
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h3 className="font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted) uppercase">
          {STAGE_LABELS[stage]}
        </h3>
        <span className="font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted)/60">
          {cards.length}
        </span>
        {isRunnable(stage) && <span title="Claude runs here" className="ml-auto text-xs text-sky-500">◆</span>}
      </div>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2">
          {cards.map((c) => <SortableCard key={c.id} card={c} />)}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableCard({ card }: { card: ApiCard }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'opacity-30' : ''}
      {...attributes}
      {...listeners}
    >
      <CardFace card={card} />
    </div>
  );
}

/**
 * The card's sub-state, as light. The column is where the human put the card;
 * this is what the machine has done with it since, and it is the only thing on
 * the board that changes without a drag. A card Claude has touched glows from
 * all four edges into a dark centre; an idle one is plain panel.
 */
const ACTIVITY_STYLE: Record<CardActivity, string> = {
  idle: 'border-(--color-edge) bg-(--color-panel) hover:border-slate-600',
  running: 'card-glow card-glow-running',
  needs_review: 'card-glow card-glow-review',
  needs_input: 'card-glow card-glow-input',
  error: 'card-glow card-glow-error',
};

/**
 * The second signal, so a state never rests on colour alone: a 68px outline
 * mark, centred behind the card's own content and faint enough to read through.
 * `running` has none — it carries the progress rail instead — and `idle` has
 * nothing to say.
 */
const ACTIVITY_MARKS: Partial<Record<CardActivity, React.ReactNode>> = {
  needs_review: (
    <Mark>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Mark>
  ),
  needs_input: (
    <Mark>
      <path d="M9 9a3 3 0 1 1 4.5 2.6c-.9.5-1.5 1.2-1.5 2.2V15" />
      <path d="M12 18.5v.01" />
    </Mark>
  ),
  error: (
    <Mark>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Mark>
  ),
};

function Mark({ children }: { children: React.ReactNode }) {
  return (
    <svg className="card-mark" viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

/**
 * Every non-idle state says its name, as hidden text rather than a chip: the
 * glow and the mark carry it for the eye, this carries it for a screen reader.
 * `idle` has no label on purpose — it falls through to the raw run status,
 * which is the only way a deliberately cancelled run still shows on the face.
 */
const ACTIVITY_LABELS: Partial<Record<CardActivity, string>> = {
  running: 'Claude running',
  needs_review: 'Ready for review',
  needs_input: 'Needs your answer',
  error: 'Error',
};

function CardFace({ card, dragging = false }: { card: ApiCard; dragging?: boolean }) {
  const run = card.latestRun;
  const label = ACTIVITY_LABELS[card.activity];
  return (
    <article
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

/**
 * The only thing on the board that starts Claude. It sits on the card rather
 * than in the column header because a stage runs per card, and it is absent
 * once a run has succeeded: from there the review gate takes over. On an error
 * card it takes that card's red, because a button on a tinted card belongs to
 * it; everywhere else it stays sky, because sky is Claude.
 */
function RunButton({ card }: { card: ApiCard }) {
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: () => api.startStage(card.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board'] }),
  });
  const retry = card.activity === 'error';

  return (
    <>
      <button
        // The whole card is the drag handle, so the press has to stop here or
        // the pointer sensor treats a click as the start of a drag.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => start.mutate()}
        disabled={start.isPending}
        title={retry ? 'Start a fresh run' : 'Run this stage'}
        className={`ml-auto rounded border px-1.5 py-0.5 font-mono text-[10px]/4 disabled:opacity-40 ${
          retry
            ? 'border-(--color-btn-error-border) bg-(--color-btn-error-fill) text-red-200 shadow-(--shadow-btn-error-glow) hover:border-(--color-btn-error-hover-border) hover:bg-(--color-btn-error-hover-fill)'
            : 'border-sky-800 text-sky-300 hover:border-sky-600 hover:bg-sky-500/10'
        }`}
      >
        {start.isPending ? 'Starting…' : retry ? 'Retry' : 'Run'}
      </button>
      {/* Cleared by the next click: a fresh attempt resets the mutation. */}
      {start.error && (
        <p className="basis-full font-mono text-[10px] leading-snug text-red-300">{start.error.message}</p>
      )}
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-(--color-muted)">{children}</div>;
}
