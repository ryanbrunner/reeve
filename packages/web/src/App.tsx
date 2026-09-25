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
import { STAGES, type ApiCard, type ApiRepo, type BoardResponse, type Stage } from '@reeve/shared';
import { CardFace } from './board/CardFace.js';
import { COLUMN_PREFIX, Column, columnCollisions } from './board/Column.js';
import { Glyph } from './board/Glyph.js';
import { ArchiveModal } from './archive/ArchiveModal.js';
import { CardModal } from './card/CardModal.js';
import { SettingsModal, type SettingsPane } from './settings/SettingsModal.js';
import { SickoArming } from './sicko/Arming.js';
import { SickoHud } from './sicko/Hud.js';
import { SickoLane } from './sicko/Lane.js';
import { SickoLightsBehind, SickoLightsOver } from './sicko/Lights.js';
import { SickoSwitch } from './sicko/Switch.js';
import { SickoTicker } from './sicko/Ticker.js';
import { useSicko, type Sicko } from './sicko/useSicko.js';
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
      held ? false
      // SICKO MODE moves cards on its own every couple of seconds, and a card
      // that flew while the board was not looking would land without the
      // flight. Kept brisk whatever the cards are doing.
      : q.state.data?.sicko ? 1_000
      : q.state.data?.cards.some((c) => c.activity === 'running' || c.openingPr || c.resolvingConflicts) ? 1_500
      : 5_000,
  });

  // A new card, opened on arrival so the details go straight in. Cleared as
  // soon as that card is no longer the open one — however it closed, Back
  // included — so reopening it later is an ordinary open, not a fresh one.
  const [freshId, setFreshId] = useState<string | null>(null);
  useEffect(() => {
    if (freshId && openCard !== freshId) setFreshId(null);
  }, [openCard, freshId]);

  // Made with a placeholder title and opened, rather than asked for a title
  // first: criteria and context can only hang off a card that exists.
  const create = useMutation({
    mutationFn: (repoId: string | null) => api.createCard({ title: 'Untitled', repoId, stage: 'backlog' }),
    onSuccess: (card) => {
      setFreshId(card.id);
      openAndClose.open(card.id);
      return qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const cards = data?.cards ?? [];
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  // Which cards are on main, as one string so the identity only changes when
  // the set does. The ids and not the count, because two merges landing in one
  // poll should set off one flash, and the stamp has to know which cards to sit
  // on.
  const mergedKey = cards.filter((c) => c.mergedAt != null).map((c) => c.id).sort().join(',');
  const mergedIds = useMemo(() => (mergedKey ? mergedKey.split(',') : []), [mergedKey]);
  const sicko = useSicko(data?.sicko ?? null, mergedIds);

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
    ? (data?.repos ?? []).map((p) => ({ id: p.id as string | null, name: p.name, color: p.laneColor }))
    : [{ id: undefined as unknown as string | null, name: '', color: null }];

  /*
   * In SICKO MODE the whole app is dressed differently, so the frame goes on
   * here rather than in a dozen places: the root carries `.sicko`, which is the
   * only thing every rule in sicko.css hangs off, and the lights go in front of
   * and behind the two shake wrappers.
   *
   * Those wrappers are also why the modals are siblings of the stage rather than
   * inside it: `sk-jolt` puts a transform and a filter on `.sk-stage-in`, and a
   * `position: fixed` modal inside a transformed ancestor stops being fixed to
   * the window.
   */
  const lanesInner = (
    <div className={`flex-1 overflow-auto p-4 ${sicko.sick ? 'pb-20' : ''}`}>
      {lanes.map((lane) => (
        <section key={lane.id ?? 'all'} className="mb-6 last:mb-0">
          {swimlanes && (
            <h2 className="mb-2 flex items-center gap-2 font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted) uppercase">
              <span
                className={`h-2 w-2 rounded-full ${sicko.sick ? 'sk-lane-dot' : ''}`}
                style={{ background: lane.color ?? '#3f4754' }}
              />
              <span className={sicko.sick ? 'sk-lane-name' : ''}>{lane.name}</span>
            </h2>
          )}
          {sicko.sick ?
            <SickoLane
              cards={lane.id === undefined ? cards : cards.filter((c) => c.repoId === lane.id)}
              laneId={lane.id}
              justMerged={sicko.justMerged}
              onOpen={openAndClose.open}
            />
          : <div className="grid grid-cols-5 gap-3 min-w-[920px]">
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
          }
        </section>
      ))}
    </div>
  );

  return (
    <div className={`relative flex h-full flex-col ${sicko.sick ? 'sicko' : ''}`}>
      {sicko.sick && <SickoLightsBehind />}
      {/* Two wrappers, one transform each: the outer jumps when a card lands on
          main, the inner glitches on its own clock. */}
      <div
        className={`sk-stage relative z-10 flex min-h-0 flex-1 flex-col ${
          sicko.live ? (sicko.shake ? 'sk-shake-a' : 'sk-shake-b') : ''
        }`}
      >
        <div className="sk-stage-in flex min-h-0 flex-1 flex-col">
          <Header
            swimlanes={swimlanes}
            onToggle={() => setSwimlanes((s) => !s)}
            repos={data?.repos ?? []}
            onAdd={create.mutate}
            adding={create.isPending}
            addError={create.error}
            onOpenSettings={setSettingsOpen}
            onOpenArchive={() => setArchiveOpen(true)}
            cardCount={cards.length}
            sicko={sicko}
          />
          {sicko.sick && <SickoTicker />}
          {/* Nothing is draggable in SICKO MODE, so the drag machinery is left
              out entirely rather than made inert around an overlay it would
              fight with. */}
          {sicko.sick ?
            lanesInner
          : <DndContext
              sensors={sensors}
              collisionDetection={columnCollisions}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragCancel={onDragCancel}
            >
              {lanesInner}
              <DragOverlay>{dragging ? <CardFace card={dragging} dragging /> : null}</DragOverlay>
            </DndContext>
          }
          {sicko.state && <SickoHud state={sicko.state} pop={sicko.pop} />}
        </div>
      </div>
      {sicko.sick && <SickoLightsOver flash={sicko.flash} />}
      {sicko.phase === 'arming' && <SickoArming />}
      {openCard && <CardModal cardId={openCard} onClose={openAndClose.close} editTitle={openCard === freshId} />}
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

function Header({ swimlanes, onToggle, repos, onAdd, adding, addError, onOpenSettings, onOpenArchive, cardCount, sicko }: {
  swimlanes: boolean;
  onToggle: () => void;
  repos: ApiRepo[];
  onAdd: (repoId: string | null) => void;
  adding: boolean;
  addError: Error | null;
  onOpenSettings: (pane: SettingsPane) => void;
  onOpenArchive: () => void;
  cardCount: number;
  sicko: Sicko;
}) {
  // Filed under the first repo unless told otherwise, because an unfiled
  // card is a dead one: no repo means no worktree, which means no stage can
  // run. The picker sits next to Add rather than hiding the choice, so
  // "the first one" is never a silent answer.
  // `null` is "hasn't said", `''` is "said no repo" — two different things,
  // and collapsing them makes No repo unpickable: the fallback below would
  // read the empty string as untouched and snap the select back to the first.
  const [repoId, setRepoId] = useState<string | null>(null);
  const chosen = repoId === '' || repos.some((p) => p.id === repoId);
  const filedUnder = chosen ? repoId! : (repos[0]?.id ?? '');
  const sick = sicko.sick;
  return (
    <header className="sk-hdr flex items-center gap-3 border-b border-(--color-edge) px-4 py-3">
      <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-[-0.02em]">
        <Glyph />
        <span className={sick ? 'sk-wm' : ''}>Reeve</span>
      </h1>
      <span className="font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted)">
        {cardCount} cards
      </span>
      <div className="ml-auto flex items-center gap-2">
        {addError && <p className="font-mono text-[10px]/4 text-red-300">{addError.message}</p>}
        {repos.length > 0 && (
          <select
            value={filedUnder}
            onChange={(e) => setRepoId(e.target.value)}
            aria-label="Repo for the new card"
            className={`rounded-md border border-(--color-edge) bg-(--color-panel) px-2 py-1.5 font-mono text-[11px]/4 text-(--color-muted) outline-none focus:border-sky-600 ${
              sick ? 'sk-field' : ''
            }`}
          >
            {repos.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
            <option value="">No repo</option>
          </select>
        )}
        {/* Held while the card is being made: a double-click would otherwise
            make two, and open both. */}
        <button
          type="button"
          disabled={adding}
          onClick={() => onAdd(filedUnder || null)}
          className={`rounded-md bg-sky-700 px-3 py-1.5 text-sm font-medium hover:bg-sky-600 disabled:opacity-40 ${
            sick ? 'sk-add' : ''
          }`}
        >
          {/* A card added while this is on does not wait in Backlog for anyone. */}
          {sick ? 'Ship it' : 'Add'}
        </button>
      </div>
      <button
        onClick={() => onOpenSettings(repos.length === 0 ? { kind: 'repo', id: null } : { kind: 'runs' })}
        className={`rounded-md border px-3 py-1.5 text-sm ${
          repos.length === 0 ?
            'border-sky-600 text-sky-300'
          : 'border-(--color-edge) text-(--color-muted) hover:border-slate-600'
        }`}
      >
        {/* Highlighted, and straight to the new-repo form, when there are none:
            an empty board with no repo is a board where nothing can ever run,
            and this is the way out. */}
        {repos.length === 0 ? 'Add a repo' : 'Settings'}
      </button>
      <button
        onClick={onOpenArchive}
        className="rounded-md border border-(--color-edge) px-3 py-1.5 text-sm text-(--color-muted) hover:border-slate-600"
      >
        Archive
      </button>
      {/* What happened while you were not being asked. Said once, on the way
          out, and then gone. */}
      {sicko.toast && <span className="sk-toast" role="status">{sicko.toast}</span>}
      {/* Beside the other view toggles, and quiet until it is hovered: the one
          control here that changes what Reeve IS rather than what it shows. */}
      <SickoSwitch on={sick} onToggle={sicko.toggle} disabled={sicko.pending} />
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
