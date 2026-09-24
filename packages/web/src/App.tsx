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
                <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-(--color-muted) uppercase">
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
      <h1 className="text-sm font-semibold tracking-wide">Reeve</h1>
      <span className="text-xs text-(--color-muted)">{cardCount} cards</span>
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
        <h3 className="text-xs font-semibold tracking-wide text-(--color-muted) uppercase">{STAGE_LABELS[stage]}</h3>
        <span className="text-xs text-(--color-muted)/60">{cards.length}</span>
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
 * The card's sub-state, as colour. The column is where the human put the card;
 * this is what the machine has done with it since, and it is the only thing on
 * the board that changes without a drag.
 */
const ACTIVITY_STYLE: Record<CardActivity, string> = {
  idle: 'border-(--color-edge) bg-(--color-panel) hover:border-slate-600',
  running: 'border-sky-600/60 bg-sky-500/15',
  needs_review: 'border-emerald-600/60 bg-emerald-500/15',
  needs_input: 'border-amber-500/60 bg-amber-500/15',
  error: 'border-red-600/60 bg-red-500/15',
};

const CHIP_STYLE: Record<CardActivity, string> = {
  idle: 'bg-slate-500/15 text-slate-300',
  running: 'bg-sky-500/25 text-sky-200',
  needs_review: 'bg-emerald-500/25 text-emerald-200',
  needs_input: 'bg-amber-500/25 text-amber-100',
  error: 'bg-red-500/25 text-red-200',
};

/**
 * Colour alone is a poor signal, so every non-idle state says its name too.
 * `idle` has no label on purpose: it falls through to the raw run status, which
 * is the only way a deliberately cancelled run still shows up on the face.
 */
const ACTIVITY_LABELS: Partial<Record<CardActivity, string>> = {
  running: 'Claude running',
  needs_review: 'Ready for review',
  needs_input: 'Needs your answer',
  error: 'Error',
};

function CardFace({ card, dragging = false }: { card: ApiCard; dragging?: boolean }) {
  const run = card.latestRun;
  return (
    <article
      className={`cursor-grab rounded-md border p-2.5 ${ACTIVITY_STYLE[card.activity]} ${
        dragging ? 'rotate-2 shadow-xl shadow-black/40' : ''
      }`}
    >
      <p className="text-sm leading-snug">{card.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {card.projectName && (
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{ background: `${card.laneColor ?? '#3f4754'}33`, color: card.laneColor ?? '#9aa4b2' }}
          >
            {card.projectName}
          </span>
        )}
        {run && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${CHIP_STYLE[card.activity]}`}>
            {ACTIVITY_LABELS[card.activity] ?? run.status}
          </span>
        )}
        {run?.totalCostUsd != null && (
          <span className="text-[10px] text-(--color-muted)">${run.totalCostUsd.toFixed(3)}</span>
        )}
      </div>
    </article>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-(--color-muted)">{children}</div>;
}
