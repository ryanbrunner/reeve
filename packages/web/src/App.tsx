import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { STAGES, type ApiCard, type ApiProject, type BoardResponse, type Stage } from '@reeve/shared';
import { CardFace } from './board/CardFace.js';
import { COLUMN_PREFIX, Column, columnCollisions } from './board/Column.js';
import { ArchiveModal } from './archive/ArchiveModal.js';
import { CardModal } from './card/CardModal.js';
import { SettingsModal, type SettingsPane } from './settings/SettingsModal.js';
import { api, cardsIn } from './lib/api.js';

export function App() {
  const qc = useQueryClient();
  const [swimlanes, setSwimlanes] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Which pane Settings opens on, or null while it is shut.
  const [settingsOpen, setSettingsOpen] = useState<SettingsPane | null>(null);
  // Stable, because the modal's focus effect depends on it and the board
  // re-renders this component on every poll: a fresh arrow each time would
  // re-run that effect and yank focus out of whichever field was being typed in.
  const closeSettings = useCallback(() => setSettingsOpen(null), []);
  const [dragging, setDragging] = useState<ApiCard | null>(null);
  const [openCard, openAndClose] = useOpenCard();

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
      held ? false : q.state.data?.cards.some((c) => c.activity === 'running' || c.openingPr) ? 1_500 : 5_000,
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

  // Escape cancels a drag rather than ending it, and dnd-kit reports that here
  // and nowhere else. Without this the overlay card stayed stuck to the screen
  // and `dragging` never cleared, which also pins `held` below — and with it the
  // board's refetch — until a reload.
  function onDragCancel() {
    setDragging(null);
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const { active, over } = e;
    if (!over) return;
    const id = String(active.id);
    const overId = String(over.id);
    const card = byId.get(id);
    // Put back down in its own slot: nothing moved.
    if (!card || overId === id) return;

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
      // The slot is the target's index in the column as it stands, dragged card
      // included — the index `arrayMove` takes, and the one the server reads by
      // dropping the card out of the column before counting off to it. Filtering
      // the card out here first made a nudge one slot down a no-op: its own
      // removal pulled the target up into the slot the card had just left.
      index = cardsIn(cards, stage).findIndex((c) => c.id === overId);
      if (index < 0) return;
    }
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
        projects={data?.projects ?? []}
        onAdd={(title, projectId) => create.mutate({ title, projectId, stage: 'backlog' })}
        onOpenSettings={setSettingsOpen}
        onOpenArchive={() => setArchiveOpen(true)}
        cardCount={cards.length}
      />
      <DndContext
        sensors={sensors}
        collisionDetection={columnCollisions}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div className="flex-1 overflow-auto p-4">
          {lanes.map((lane) => (
            <section key={lane.id ?? 'all'} className="mb-6 last:mb-0">
              {swimlanes && (
                <h2 className="mb-2 flex items-center gap-2 font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted) uppercase">
                  <span className="h-2 w-2 rounded-full" style={{ background: lane.color ?? '#3f4754' }} />
                  {lane.name}
                </h2>
              )}
              <div className="grid grid-cols-5 gap-3 min-w-[920px]">
                {STAGES.map((stage) => (
                  <Column
                    key={stage}
                    stage={stage}
                    laneId={lane.id}
                    cards={cardsIn(cards, stage, lane.id)}
                    onOpen={openAndClose.open}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
        <DragOverlay>{dragging ? <CardFace card={dragging} dragging /> : null}</DragOverlay>
      </DndContext>
      {openCard && <CardModal cardId={openCard} onClose={openAndClose.close} />}
      {settingsOpen && <SettingsModal initial={settingsOpen} onClose={closeSettings} />}
      {archiveOpen && (
        <ArchiveModal
          onClose={() => setArchiveOpen(false)}
          onOpen={(id) => {
            setArchiveOpen(false);
            openAndClose.open(id);
          }}
        />
      )}
    </div>
  );
}

/**
 * Which card is open, kept in the URL as `?card=<id>`.
 *
 * A card becomes a link someone can send, a reload lands back on it, and Back
 * closes it — all without adding a router for one parameter.
 */
function useOpenCard() {
  const read = () => new URLSearchParams(window.location.search).get('card');
  const [openCard, setOpenCard] = useState<string | null>(read);
  // Whether the entry currently in the URL is one we pushed, or the one the
  // tab was opened on. Closing a card someone arrived at by link has nothing
  // to go back to, and back() there would leave the app entirely.
  const pushed = useRef(false);

  useEffect(() => {
    const onPop = () => {
      pushed.current = false;
      setOpenCard(read());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open = useCallback((id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('card', id);
    window.history.pushState(null, '', url);
    pushed.current = true;
    setOpenCard(id);
  }, []);

  const close = useCallback(() => {
    if (pushed.current) {
      // Consume the entry rather than stacking another, so Escape and the
      // browser's Back button end up doing the same thing.
      pushed.current = false;
      window.history.back();
    } else {
      const url = new URL(window.location.href);
      url.searchParams.delete('card');
      window.history.replaceState(null, '', url);
    }
    setOpenCard(null);
  }, []);

  return [openCard, useMemo(() => ({ open, close }), [open, close])] as const;
}

function Header({ swimlanes, onToggle, projects, onAdd, onOpenSettings, onOpenArchive, cardCount }: {
  swimlanes: boolean;
  onToggle: () => void;
  projects: ApiProject[];
  onAdd: (title: string, projectId: string | null) => void;
  onOpenSettings: (pane: SettingsPane) => void;
  onOpenArchive: () => void;
  cardCount: number;
}) {
  const [title, setTitle] = useState('');
  // Filed under the first project unless told otherwise, because an unfiled
  // card is a dead one: no repo means no worktree, which means no stage can
  // run. The picker sits next to the field rather than hiding the choice, so
  // "the first one" is never a silent answer.
  // `null` is "hasn't said", `''` is "said no project" — two different things,
  // and collapsing them makes No project unpickable: the fallback below would
  // read the empty string as untouched and snap the select back to the first.
  const [projectId, setProjectId] = useState<string | null>(null);
  const chosen = projectId === '' || projects.some((p) => p.id === projectId);
  const filedUnder = chosen ? projectId! : (projects[0]?.id ?? '');
  return (
    <header className="flex items-center gap-3 border-b border-(--color-edge) px-4 py-3">
      <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-[-0.02em]">
        <img src="/reeve-glyph.svg" alt="" className="h-5 w-auto" />
        Reeve
      </h1>
      <span className="font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted)">
        {cardCount} cards
      </span>
      <form
        className="ml-auto flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          onAdd(title.trim(), filedUnder || null);
          setTitle('');
        }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New idea → Backlog"
          className="w-64 rounded-md border border-(--color-edge) bg-(--color-panel) px-3 py-1.5 text-sm outline-none placeholder:text-(--color-muted) focus:border-sky-600"
        />
        {projects.length > 0 && (
          <select
            value={filedUnder}
            onChange={(e) => setProjectId(e.target.value)}
            aria-label="Project for the new card"
            className="rounded-md border border-(--color-edge) bg-(--color-panel) px-2 py-1.5 font-mono text-[11px]/4 text-(--color-muted) outline-none focus:border-sky-600"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
            <option value="">No project</option>
          </select>
        )}
        <button type="submit" className="rounded-md bg-sky-700 px-3 py-1.5 text-sm font-medium hover:bg-sky-600">
          Add
        </button>
      </form>
      <button
        onClick={() => onOpenSettings(projects.length === 0 ? { kind: 'repo', id: null } : { kind: 'runs' })}
        className={`rounded-md border px-3 py-1.5 text-sm ${
          projects.length === 0 ?
            'border-sky-600 text-sky-300'
          : 'border-(--color-edge) text-(--color-muted) hover:border-slate-600'
        }`}
      >
        {/* Highlighted, and straight to the new-repo form, when there are none:
            an empty board with no repo is a board where nothing can ever run,
            and this is the way out. */}
        {projects.length === 0 ? 'Add a repo' : 'Settings'}
      </button>
      <button
        onClick={onOpenArchive}
        className="rounded-md border border-(--color-edge) px-3 py-1.5 text-sm text-(--color-muted) hover:border-slate-600"
      >
        Archive
      </button>
      <button
        onClick={onToggle}
        className={`rounded-md border px-3 py-1.5 text-sm ${swimlanes ? 'border-sky-600 text-sky-300' : 'border-(--color-edge) text-(--color-muted)'}`}
      >
        Swim lanes
      </button>
    </header>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-(--color-muted)">{children}</div>;
}
