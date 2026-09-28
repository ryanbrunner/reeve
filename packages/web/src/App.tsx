import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
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
import {
  PLACEHOLDER_PROJECT_TITLE,
  PLACEHOLDER_TITLE,
  STAGES,
  blockedMoveRefusal,
  type ApiCard,
  type ApiProject,
  type ApiRepo,
  type BoardResponse,
  type CreateCardBody,
  type MoveCardBody,
  type UsageState,
} from '@reeve/shared';
import { CardFace } from './board/CardFace.js';
import { COLUMN_PREFIX, Column, columnCollisions, parseColumnId } from './board/Column.js';
import { Glyph } from './board/Glyph.js';
import { LaneHeader } from './board/LaneHeader.js';
import { LinksProvider } from './board/links.js';
import { NewCardPicker, RepoSelect } from './board/RepoPicker.js';
import { useCollapsedLanes } from './board/useCollapsedLanes.js';
import { ArchiveModal } from './archive/ArchiveModal.js';
import { CardModal } from './card/CardModal.js';
import { SettingsModal, type SettingsPane } from './settings/SettingsModal.js';
import { VibesArming } from './vibes/Arming.js';
import { VibesHud } from './vibes/Hud.js';
import { VibesLane } from './vibes/Lane.js';
import { VibesLightsBehind, VibesLightsOver } from './vibes/Lights.js';
import { VibesSwitch } from './vibes/Switch.js';
import { VibesTicker } from './vibes/Ticker.js';
import { useVibes, type Vibes } from './vibes/useVibes.js';
import { UsageMeter, UsageWarning } from './usage/UsageMeter.js';
import { api, cardsIn } from './lib/api.js';

export function App() {
  const qc = useQueryClient();
  const [archiveOpen, showArchive] = useArchiveParam();
  // The lane whose Backlog is asking a new card for its repo, by lane key.
  const [newCardLane, setNewCardLane] = useNewCardParam();
  // Which pane Settings opens on, or null while it is shut.
  const [settingsOpen, setSettingsOpen] = useState<SettingsPane | null>(null);
  // Stable, because the modal's focus effect depends on it and the board
  // re-renders this component on every poll: a fresh arrow each time would
  // re-run that effect and yank focus out of whichever field was being typed in.
  const closeSettings = useCallback(() => setSettingsOpen(null), []);
  // Stable for the same reason: the Archive's focus effect depends on it too.
  const closeArchive = useCallback(() => showArchive(false), [showArchive]);
  const [dragging, setDragging] = useState<ApiCard | null>(null);
  // A drop refused here, before anything was sent: a card waiting on another
  // may only go back to Backlog. Said where the server's refusals are.
  const [refusedDrag, setRefusedDrag] = useState<string | null>(null);
  const [openCard, openAndClose] = useOpenCard();
  const collapsedLanes = useCollapsedLanes();

  const move = useMutation({
    mutationFn: ({ id, ...body }: MoveCardBody & { id: string }) => api.moveCard(id, body),
    // Optimistic: the card must land under the cursor immediately, not after a round trip.
    onMutate: async ({ id, stage, index, projectId }) => {
      // A move that went through makes the last refusal old news.
      setRefusedDrag(null);
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
            cards: prev.cards.map((c) =>
              c.id === id ? {
                ...c, stage, position, ...(projectId !== undefined ? { projectId } : {}),
                // Leaving Backlog takes a suggestion on, as the server records it;
                // left pink until the refetch, it would glow in the wrong column.
                pendingSuggestion: c.pendingSuggestion && stage === 'backlog',
              } : c,
            ),
          });
        }
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(['board'], ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ['board'] }),
  });

  // A refused drag snaps back, and on its own that looks like a drop that
  // missed. The server's reason — most often the cards this one is waiting on
  // — is said in the header long enough to read, then goes: it is about one
  // drag, not about the board.
  const { error: moveError, reset: resetMove } = move;
  useEffect(() => {
    if (!moveError) return;
    const t = setTimeout(resetMove, 8_000);
    return () => clearTimeout(t);
  }, [moveError, resetMove]);
  useEffect(() => {
    if (!refusedDrag) return;
    const t = setTimeout(() => setRefusedDrag(null), 8_000);
    return () => clearTimeout(t);
  }, [refusedDrag]);

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
      // VIBES MODE moves cards on its own every couple of seconds, and a card
      // that flew while the board was not looking would land without the
      // flight. Kept brisk whatever the cards are doing.
      : q.state.data?.vibes ? 1_000
      // A card in VIBES MODE on its own moves with nobody touching it too, and
      // at the idle rate it would jump a column without anyone seeing it go.
      // So does every task in a project in VIBES MODE, whose flag is the
      // project's and not on the card.
      : q.state.data?.cards.some(
          (c) =>
            c.activity === 'running' || c.startingStage || c.openingPr || c.resolvingConflicts || c.mergingPr ||
            ((c.vibes || q.state.data?.projects.some((p) => p.vibes && p.id === c.projectId)) && c.mergedAt == null),
        ) ? 1_500
      : 5_000,
  });

  // A new card, opened on arrival so the details go straight in. Cleared as
  // soon as that card is no longer the open one — however it closed, Back
  // included — so reopening it later is an ordinary open, not a fresh one.
  const [freshId, setFreshId] = useState<string | null>(null);
  useEffect(() => {
    if (freshId && openCard !== freshId) setFreshId(null);
  }, [openCard, freshId]);

  // A card closed with nothing said about it is thrown away, so a new card
  // opened and shut again leaves no "Untitled" behind. Every card is offered
  // up, not just a fresh one, and the server keeps anything that is not blank.
  // This watches the open card changing rather than hooking `close`, so it
  // also catches Back, which never calls it, and opening a different card.
  //
  // It waits for every save in flight first. The title and the brief save on
  // blur, and a click on the scrim or the close button blurs the field on
  // mousedown, before the click that closes the modal. The rename is already
  // on its way by the time this runs. Asking straight away would race it, and
  // a card named a moment ago could lose. Mutations outlive the modal that
  // started them, so they are still counted once it is gone.
  const openNow = useRef(openCard);
  const lastOpen = useRef(openCard);
  useEffect(() => {
    openNow.current = openCard;
    const left = lastOpen.current;
    lastOpen.current = openCard;
    if (!left || left === openCard) return;
    void whenSaved(qc)
      .then(async () => {
        // Back, then Forward before the saves landed: it is open again.
        if (openNow.current === left) return;
        const { deleted } = await api.discardCard(left);
        if (deleted) await qc.invalidateQueries({ queryKey: ['board'] });
      })
      // Nothing to show for it. At worst a blank card stays on the board.
      .catch(() => {});
  }, [openCard, qc]);

  /**
   * The ghost card makes a card and opens it, because criteria and context can
   * only hang off a card that exists, and a card needs a title typed into it.
   * Add Project the same way, since a project's brief is what it is for.
   *
   * Ship it, in VIBES MODE, does not open anything: the title came with the
   * request and the card is already on its way, so putting a modal over the
   * board would hide the one thing worth watching.
   */
  const create = useMutation({
    mutationFn: (body: CreateCardBody) => api.createCard(body),
    onSuccess: (card, { title, kind }) => {
      if (title === PLACEHOLDER_TITLE || kind === 'project') {
        // Shut first, as the Archive is: `open` pushes the URL as it finds
        // it, and the card's entry must not carry `?new` with it.
        setNewCardLane(null);
        setFreshId(card.id);
        openAndClose.open(card.id);
      }
      return qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const repos = data?.repos ?? [];
  const projects = data?.projects ?? [];
  // A card whose project is no longer on the board — archived, most likely —
  // is drawn under No project rather than in a lane that is not there. A task
  // in a project in VIBES MODE is drawn as in VIBES MODE itself, because it
  // goes on its own just the same; on the wire `vibes` is only its own flag.
  const cards = useMemo(() => {
    const live = new Set((data?.projects ?? []).map((p) => p.id));
    const lanesInVibes = new Set((data?.projects ?? []).filter((p) => p.vibes).map((p) => p.id));
    return (data?.cards ?? []).map((c) =>
      c.projectId && !live.has(c.projectId) ? { ...c, projectId: null }
      : c.projectId && lanesInVibes.has(c.projectId) && !c.vibes ? { ...c, vibes: true }
      : c,
    );
  }, [data]);
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  // Filed under the lane's project and a repo, because an unfiled card is a
  // dead one: no repo means no worktree and no stage can run. When the repo is
  // obvious the card is made at once; otherwise the lane's Backlog asks first,
  // rather than filing it under whichever repo happens to be first. The
  // header's chip changes it after either way.
  const makeCard = (projectId: string | null, repoId: string) =>
    create.mutate({ title: PLACEHOLDER_TITLE, stage: 'backlog', projectId, repoId });
  const addCard = (projectId: string | null) => {
    const repoId = obviousRepo(repos, projects, projectId);
    if (repoId) makeCard(projectId, repoId);
    else setNewCardLane(projectId ?? NO_PROJECT_LANE);
  };
  const addProject = () =>
    create.mutate({ title: PLACEHOLDER_PROJECT_TITLE, kind: 'project', repoId: repos[0]?.id ?? null });
  // VIBES MODE's Ship it: named already, so it is not opened, and under no
  // project, since the header has no lane to file it in.
  const shipIt = ({ repoId, title }: { repoId: string; title: string }) =>
    create.mutate({ title, repoId, stage: 'backlog' });

  // Which cards are on main, as one string so the identity only changes when
  // the set does. The ids and not the count, because two merges landing in one
  // poll should set off one flash, and the stamp has to know which cards to sit
  // on.
  const mergedKey = cards.filter((c) => c.mergedAt != null).map((c) => c.id).sort().join(',');
  const mergedIds = useMemo(() => (mergedKey ? mergedKey.split(',') : []), [mergedKey]);
  const vibes = useVibes(data?.vibes ?? null, mergedIds, data !== undefined);

  // `?new` asks, and never makes anything: opening a link must not create a
  // card. So it is dropped wherever + would not have asked — a lane with an
  // obvious repo, a lane no longer on the board — and in VIBES MODE, whose
  // lanes have no Backlog to ask in. Only once the board has loaded, since
  // until then there are no repos, and a link to the picker would lose it.
  const vibesOn = vibes.on;
  useEffect(() => {
    if (!data || newCardLane === null) return;
    const laneId = newCardLane === NO_PROJECT_LANE ? null : newCardLane;
    const gone = laneId !== null && !data.projects.some((p) => p.id === laneId);
    if (vibesOn || gone || obviousRepo(data.repos, data.projects, laneId)) setNewCardLane(null);
  }, [data, newCardLane, vibesOn, setNewCardLane]);

  function onDragStart(e: DragStartEvent) {
    setNewCardLane(null);
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

    // Dropped on empty column space, or onto another card. Either way the lane
    // is the column's, whose id a card carries as its sortable container.
    const column = parseColumnId(overId) ?? parseColumnId(String(over.data.current?.sortable?.containerId ?? ''));
    if (!column) return;
    const { stage } = column;
    // Refused before the optimistic move rather than after the server's 409,
    // so a blocked card never shows in a column it cannot go to. The server
    // still checks; this reads its answer off the card's links.
    const blocked = blockedMoveRefusal(card.stage, stage, card.dependsOn);
    if (blocked) {
      resetMove();
      setRefusedDrag(`Could not move “${card.title}” — ${blocked}`);
      return;
    }
    // Counted through the whole column, every lane at once: positions are
    // shared across lanes, and that is what the server counts through too.
    let index: number;
    if (overId.startsWith(COLUMN_PREFIX)) {
      index = cardsIn(cards, stage).filter((c) => c.id !== id).length;
    } else {
      // The slot is the target's index in the column as it stands, dragged card
      // included — the index `arrayMove` takes, and the one the server reads by
      // dropping the card out of the column before counting off to it. Filtering
      // the card out here first made a nudge one slot down a no-op: its own
      // removal pulled the target up into the slot the card had just left.
      index = cardsIn(cards, stage).findIndex((c) => c.id === overId);
      if (index < 0) return;
    }
    // Sent only when the lane changed, so a card whose project was archived is
    // not quietly cut loose from it by a reorder under No project.
    const projectId = column.laneId !== card.projectId ? column.laneId : undefined;
    move.mutate({ id, stage, index, projectId });
  }

  // Named, because the card has already snapped back to where it was and the
  // sentence has to say which one it means.
  const refused = moveError ? byId.get(move.variables?.id ?? '') : undefined;
  const refusal =
    refusedDrag ?? (moveError ? `Could not move “${refused?.title ?? 'the card'}” — ${moveError.message}` : null);

  if (isLoading) return <Centered>Loading board…</Centered>;
  if (error) return <Centered>Could not reach the server. Is <code className="mx-1 text-sky-300">npm run dev</code> running?</Centered>;

  // A lane per project, oldest first, then everything that belongs to none.
  const lanes = [
    ...projects.map((p) => ({
      id: p.id as string | null,
      name: p.title,
      color: p.laneColor,
      solo: p.vibes,
      archivedDone: p.archivedDoneCount,
    })),
    { id: null, name: 'No project', color: null, solo: false, archivedDone: 0 },
  ];

  /*
   * In VIBES MODE the whole app is dressed differently, so the frame goes on
   * here rather than in a dozen places: the root carries `.vibes`, which is the
   * only thing every rule in vibes.css hangs off, and the lights go in front of
   * and behind the two shake wrappers.
   *
   * Those wrappers are also why the modals are siblings of the stage rather than
   * inside it: `sk-jolt` puts a transform and a filter on `.sk-stage-in`, and a
   * `position: fixed` modal inside a transformed ancestor stops being fixed to
   * the window.
   */
  const lanesInner = (
    <div className={`flex-1 overflow-auto p-4 ${vibes.on ? 'pb-20' : ''}`}>
      {lanes.map((lane) => {
        const key = lane.id ?? NO_PROJECT_LANE;
        const bodyId = `lane-${key}`;
        const collapsed = collapsedLanes.isCollapsed(key);
        const laneCards = cards.filter((c) => c.projectId === lane.id);
        return (
          <section key={key} className="mb-6 last:mb-0">
            <LaneHeader
              laneId={lane.id}
              name={lane.name}
              color={lane.color}
              cards={laneCards}
              archivedDone={lane.archivedDone}
              collapsed={collapsed}
              onToggle={() => collapsedLanes.toggle(key)}
              onOpen={openAndClose.open}
              bodyId={bodyId}
              vibes={vibes.on}
              solo={lane.solo}
            />
            {/* Always there, so the chevron's aria-controls has something to
                point at. What is inside is unmounted when the lane is shut,
                not hidden: a hidden grid would leave zero-size droppables for
                columnCollisions to match, and a drag cannot land in a lane
                nobody can see. onDragEnd still counts through every lane's
                cards, shut ones included, because positions are shared. */}
            <div id={bodyId}>
              {collapsed ?
                null
              : vibes.on ?
                <VibesLane
                  cards={laneCards}
                  laneId={lane.id}
                  justMerged={vibes.justMerged}
                  onOpen={openAndClose.open}
                />
              : <div className="grid grid-cols-5 gap-3 min-w-[920px]">
                  {STAGES.map((stage) => (
                    <Column
                      key={stage}
                      stage={stage}
                      laneId={lane.id}
                      cards={cardsIn(cards, stage, lane.id)}
                      refuses={dragging !== null && blockedMoveRefusal(dragging.stage, stage, dragging.dependsOn) !== null}
                      onOpen={openAndClose.open}
                      onAdd={stage === 'backlog' ? () => addCard(lane.id) : undefined}
                      adding={create.isPending}
                      adder={
                        stage === 'backlog' && newCardLane === key ?
                          <NewCardPicker
                            repos={repos}
                            busy={create.isPending}
                            onPick={(repoId) => makeCard(lane.id, repoId)}
                            onCancel={() => setNewCardLane(null)}
                            // Shut as Settings opens, or the first press in
                            // it would shut it anyway, as a press elsewhere.
                            onAddRepo={() => {
                              setNewCardLane(null);
                              setSettingsOpen({ kind: 'repo', id: null });
                            }}
                          />
                        : undefined
                      }
                    />
                  ))}
                </div>
              }
            </div>
          </section>
        );
      })}
    </div>
  );
  // Around every lane at once, because a dependency does not keep to its own.
  const board = (
    <LinksProvider cards={cards} paused={dragging !== null}>
      {lanesInner}
    </LinksProvider>
  );

  return (
    <div className={`relative flex h-full flex-col ${vibes.on ? 'vibes' : ''}`}>
      {vibes.on && <VibesLightsBehind />}
      {/* Two wrappers, one transform each: the outer jumps when a card lands on
          main, the inner glitches on its own clock. */}
      <div
        className={`sk-stage relative z-10 flex min-h-0 flex-1 flex-col ${
          vibes.live ? (vibes.shake ? 'sk-shake-a' : 'sk-shake-b') : ''
        }`}
      >
        <div className="sk-stage-in flex min-h-0 flex-1 flex-col">
          <Header
            repos={repos}
            onAddProject={addProject}
            onShip={shipIt}
            adding={create.isPending}
            addError={create.error}
            moveError={refusal}
            onOpenSettings={setSettingsOpen}
            onOpenArchive={() => showArchive(true)}
            usage={data?.usage ?? null}
            vibes={vibes}
          />
          {/* Above the ticker, which is decoration: this is not. VIBES MODE does
              not stop at the limit, so in it this is the only thing that says. */}
          <UsageWarning usage={data?.usage ?? null} />
          {vibes.on && <VibesTicker />}
          {/* Nothing is draggable in VIBES MODE, so the drag machinery is left
              out entirely rather than made inert around an overlay it would
              fight with. */}
          {vibes.on ?
            board
          : <DndContext
              sensors={sensors}
              collisionDetection={columnCollisions}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragCancel={onDragCancel}
            >
              {board}
              <DragOverlay>{dragging ? <CardFace card={dragging} dragging /> : null}</DragOverlay>
            </DndContext>
          }
          {vibes.state && <VibesHud state={vibes.state} pop={vibes.pop} />}
        </div>
      </div>
      {vibes.on && <VibesLightsOver flash={vibes.flash} />}
      {vibes.phase === 'arming' && <VibesArming />}
      {/* Keyed, so opening a task from its project's modal starts it afresh on
          its own tabs rather than on whichever tab the project was showing. */}
      {openCard && (
        <CardModal
          key={openCard}
          cardId={openCard}
          onClose={openAndClose.close}
          onOpen={openAndClose.open}
          editTitle={openCard === freshId}
          vibes={vibes.on}
        />
      )}
      {settingsOpen && <SettingsModal initial={settingsOpen} onClose={closeSettings} />}
      {archiveOpen && (
        <ArchiveModal
          onClose={closeArchive}
          onOpen={(id) => {
            // Shut first: `open` pushes the URL as it finds it, and the card's
            // entry must not carry `?archive` with it.
            showArchive(false);
            openAndClose.open(id);
          }}
        />
      )}
    </div>
  );
}

/**
 * Resolves once no mutation is in flight. A plain promise, not a mutation, so
 * a discard waiting here is never itself what another one waits on.
 */
function whenSaved(qc: QueryClient): Promise<void> {
  return new Promise((resolve) => {
    if (qc.isMutating() === 0) return resolve();
    const stop = qc.getMutationCache().subscribe(() => {
      if (qc.isMutating() > 0) return;
      stop();
      resolve();
    });
  });
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

/**
 * Whether the Archive is open, kept in the URL as `?archive` so it can be
 * linked to and a reload lands back on it. Replaced rather than pushed, unlike
 * `?card=`: Back from the Archive leaving the board would be a surprise, and
 * nobody navigates within it.
 */
function useArchiveParam() {
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).has('archive'));
  const show = useCallback((next: boolean) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('archive', '1');
    else url.searchParams.delete('archive');
    window.history.replaceState(null, '', url);
    setOpen(next);
  }, []);
  return [open, show] as const;
}

/** No project's lane key: in `?new=`, and where the lanes are keyed. */
const NO_PROJECT_LANE = 'none';

/**
 * The repo a new card in this lane goes under without asking, or null when
 * there is a choice to make. The lane's project's repo if it still has one on
 * the board, and otherwise the only repo, if there is only one. Never the
 * first of several: that was a guess, and a card filed by a guess sat under
 * the wrong repo until somebody noticed.
 */
function obviousRepo(repos: ApiRepo[], projects: ApiProject[], laneId: string | null): string | null {
  const projectRepo = projects.find((p) => p.id === laneId)?.repoId;
  if (projectRepo && repos.some((r) => r.id === projectRepo)) return projectRepo;
  return repos.length === 1 ? (repos[0]?.id ?? null) : null;
}

/**
 * Which lane is picking a new card's repo, kept in the URL as `?new=<project
 * id>`, or `?new=none` for No project, so a reload lands back on the question.
 * Replaced rather than pushed, as `?archive` is: Back undoing an open picker
 * would be a surprise.
 */
function useNewCardParam() {
  const [lane, setLane] = useState(() => new URLSearchParams(window.location.search).get('new'));
  const set = useCallback((next: string | null) => {
    const url = new URL(window.location.href);
    if (next === null) url.searchParams.delete('new');
    else url.searchParams.set('new', next);
    window.history.replaceState(null, '', url);
    setLane(next);
  }, []);
  return [lane, set] as const;
}

function Header({ repos, onAddProject, onShip, adding, addError, moveError, onOpenSettings, onOpenArchive, usage, vibes }: {
  repos: ApiRepo[];
  onAddProject: () => void;
  /** VIBES MODE's Ship it: a named card, made without opening it. */
  onShip: (v: { repoId: string; title: string }) => void;
  adding: boolean;
  addError: Error | null;
  /** Why the last drag was refused, while it is still worth saying. */
  moveError: string | null;
  onOpenSettings: (pane: SettingsPane) => void;
  onOpenArchive: () => void;
  usage: UsageState | null;
  vibes: Vibes;
}) {
  // Only VIBES MODE's Ship it picks a repo here. On the calm board a card is
  // added from the ghost in its lane, which asks for its repo when it is not
  // obvious, but a shipped card is never opened, so this is its only chance.
  // The same rule as the ghost: the only repo without asking, and otherwise
  // nothing until one is picked, with no No repo, because an unfiled card is
  // a dead one and the sweep would take it nowhere. The pick is kept for the
  // next idea, which usually goes to the same place.
  const [repoId, setRepoId] = useState<string | null>(null);
  const [idea, setIdea] = useState('');
  const filedUnder =
    repos.length === 1 ? (repos[0]?.id ?? null)
    : repos.some((r) => r.id === repoId) ? repoId
    : null;
  const on = vibes.on;
  return (
    <header className="sk-hdr flex items-center gap-3 border-b border-(--color-edge) px-4 py-3">
      <h1 className="flex shrink-0 items-center gap-2.5 text-lg font-semibold tracking-[-0.02em]">
        <Glyph />
        <span className={on ? 'sk-wm' : ''}>Reeve</span>
      </h1>
      {/* By the wordmark rather than by Add, which is about something else;
          and allowed to shrink, since the blocking cards can be a long list. */}
      {moveError && (
        <p role="alert" className="min-w-0 truncate font-mono text-[10px]/4 text-red-300" title={moveError}>
          {moveError}
        </p>
      )}
      <UsageMeter usage={usage} />
      {/* In VIBES MODE the idea is typed here rather than into a modal: the card
          it makes is named, so the sweep can take it immediately, and nothing
          covers the board while it goes. */}
      <form
        className="ml-auto flex shrink-0 items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!on) return onAddProject();
          const title = idea.trim();
          if (!title || !filedUnder) return;
          onShip({ repoId: filedUnder, title });
          setIdea('');
        }}
      >
        {addError && <p className="font-mono text-[10px]/4 text-red-300">{addError.message}</p>}
        {on && repos.length > 0 && (
          <RepoSelect
            repos={repos}
            value={filedUnder}
            onChange={setRepoId}
            label="Repo for the new card"
            className="sk-field rounded-md border border-(--color-edge) bg-(--color-panel) px-2 py-1.5 font-mono text-[11px]/4 text-(--color-muted) outline-none focus:border-sky-600"
          />
        )}
        {on && (
          <>
            <label className="sr-only" htmlFor="new-idea">New idea</label>
            <input
              id="new-idea"
              type="text"
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder="New idea → main"
              className="sk-field w-56 rounded-md border border-(--color-edge) bg-(--color-panel) px-3 py-1.5 text-sm text-(--color-text) outline-none placeholder:text-(--color-muted)"
            />
          </>
        )}
        {/* Held while the card or project is being made: a double-click would
            otherwise make two, and open both. On the calm board this makes a
            project; cards are added from the ghost at the foot of each Backlog
            column, in the lane they belong to. */}
        <button
          type="submit"
          disabled={adding || (on && (idea.trim() === '' || !filedUnder))}
          title={
            on && !filedUnder ? (repos.length === 0 ? 'Add a repo to ship ideas into' : 'Pick a repo for the idea')
            : undefined
          }
          className={`rounded-md bg-sky-700 px-3 py-1.5 text-sm font-medium whitespace-nowrap hover:bg-sky-600 disabled:opacity-40 ${
            on ? 'sk-add' : ''
          }`}
        >
          {/* A card added while this is on does not wait in Backlog for anyone. */}
          {on ? 'Ship it' : 'Add Project'}
        </button>
      </form>
      <button
        onClick={() => onOpenSettings(repos.length === 0 ? { kind: 'repo', id: null } : { kind: 'runs' })}
        className={`shrink-0 rounded-md border px-3 py-1.5 text-sm whitespace-nowrap ${
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
        className="shrink-0 rounded-md border border-(--color-edge) px-3 py-1.5 text-sm whitespace-nowrap text-(--color-muted) hover:border-slate-600"
      >
        Archive
      </button>
      {/* What happened while you were not being asked. Said once, on the way
          out, and then gone. */}
      {vibes.toast && <span className="sk-toast" role="status">{vibes.toast}</span>}
      {/* Quiet until it is hovered: the one control here that changes what
          Reeve IS rather than what it shows. */}
      <VibesSwitch on={on} onToggle={vibes.toggle} disabled={vibes.pending} />
    </header>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-(--color-muted)">{children}</div>;
}
