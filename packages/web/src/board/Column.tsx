import { closestCenter, pointerWithin, rectIntersection, useDroppable, type CollisionDetection } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { STAGE_LABELS, isRunnable, type ApiCard, type Stage } from '@reeve/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { DropdownOption } from '../lib/Dropdown.js';
import { CardFace } from './CardFace.js';
import { useLinks } from './links.js';

export const COLUMN_PREFIX = 'col:';

/** The lane key a column's id carries for No project. */
const NO_PROJECT = 'all';

/** A column's droppable id: its stage, and the lane it sits in. */
export const columnId = (stage: Stage, laneId: string | null) => `${COLUMN_PREFIX}${stage}|${laneId ?? NO_PROJECT}`;

/** Where a column id says a card dropped on it goes, or null for anything that is not one. */
export function parseColumnId(id: string): { stage: Stage; laneId: string | null } | null {
  if (!id.startsWith(COLUMN_PREFIX)) return null;
  const [stage, lane] = id.slice(COLUMN_PREFIX.length).split('|');
  return { stage: stage as Stage, laneId: !lane || lane === NO_PROJECT ? null : lane };
}

/**
 * What a dragged card is over: the column under the pointer, then the card
 * nearest the pointer inside it.
 *
 * Not `closestCorners`. The grid stretches every column to the height of the
 * tallest, so a column's corners sit far from the pointer and a card in the
 * next column over wins instead — dragging into a sparse column landed the
 * card on its neighbour, or back where it started. Below a column's last card
 * is the column itself, so a drop there appends rather than slotting in above
 * the last card.
 */
export const columnCollisions: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  const hits = within.length > 0 ? within : rectIntersection(args);
  const column = hits.find((h) => String(h.id).startsWith(COLUMN_PREFIX));
  if (!column) return hits;

  const cards = args.droppableContainers.filter((c) => c.data.current?.sortable?.containerId === column.id);
  const bottom = Math.max(...cards.map((c) => args.droppableRects.get(c.id)?.bottom ?? -Infinity));
  const pointer = args.pointerCoordinates;
  if (cards.length === 0 || (pointer && pointer.y > bottom)) return [column];
  return closestCenter({ ...args, droppableContainers: cards });
};

export function Column({
  stage,
  laneId,
  cards,
  onOpen,
  onAdd,
  addOptions = [],
  adding = false,
  refuses = false,
  vibes = false,
  hot = false,
  skipped = false,
  children,
}: {
  stage: Stage;
  /** The lane's project; null is No project. */
  laneId: string | null | undefined;
  cards: ApiCard[];
  onOpen?: (id: string) => void;
  /**
   * Offered as a ghost card at the foot of the column. Backlog is where new
   * work goes, so only it has one. Called with the repo the card starts in:
   * picked from `addOptions` when there are several, the only one when there
   * is one, and null when there are none.
   */
  onAdd?: (repoId: string | null) => void;
  /** The repos the ghost offers, the lane project's own first. */
  addOptions?: DropdownOption[];
  adding?: boolean;
  /**
   * The card being dragged waits on another and may not come in here. Only a
   * hint, drawn in the dependency colour: the droppable stays enabled, because
   * a drop onto one of its cards would get through a disabled one anyway, and
   * `onDragEnd` is what actually refuses it.
   */
  refuses?: boolean;
  /**
   * The column as a well: its cards have lifted off it into the flying layer,
   * so it keeps its header and its count and holds nothing. Not a droppable
   * either, because nobody drags anything in VIBES MODE.
   */
  vibes?: boolean;
  /** Something just landed here. Only VIBES MODE says so; a drag lights it itself. */
  hot?: boolean;
  /** VIBES MODE goes straight past this column: struck out, and closed. */
  skipped?: boolean;
  /** Drawn inside the well. Only a VIBES well has room for anything but cards. */
  children?: React.ReactNode;
}) {
  const id = columnId(stage, laneId ?? null);
  const { setNodeRef, isOver, over, active } = useDroppable({ id, disabled: vibes });
  // Over one of its cards is over the column too; that is where the card lands.
  const lit = isOver || cards.some((c) => c.id === over?.id);

  const pickerId = useId();
  const ghost = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  // Escape puts focus back on the ghost, but the ghost is only mounted again
  // once the list has gone, so it is asked for here and done after.
  const refocus = useRef(false);

  const close = (toGhost: boolean) => {
    refocus.current = toGhost;
    setPicking(false);
  };

  // With one repo there is nothing to choose, and with none nothing to choose
  // from: the card is made at once, as it always was.
  const add = () => {
    if (addOptions.length < 2) return onAdd?.(addOptions[0]?.value ?? null);
    setPicking(true);
  };

  // Keyed on `picking` alone, never on the options: App builds them afresh on
  // every render, and a board refetch would snap focus back to the first row
  // in the middle of arrowing down.
  useEffect(() => {
    if (picking) list.current?.querySelector('button')?.focus();
    else if (refocus.current) {
      refocus.current = false;
      ghost.current?.focus();
    }
  }, [picking]);

  // A drag unmounts the ghost, list and all; without this the list would be
  // open again under the card when it was put down.
  useEffect(() => {
    if (active) setPicking(false);
  }, [active]);

  // As in Dropdown: pointerdown rather than click, so a drag that starts
  // outside shuts it too, and in the capture phase, so nothing stops it first.
  useEffect(() => {
    if (!picking) return;
    const onDown = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [picking]);

  // The rows are buttons, so Enter and Space pick through their own click;
  // handling them here as well would make two cards from one key. Escape is
  // stopped, as Dropdown's is, because the card and Settings close on one
  // that reaches `document`. Tab shuts the list rather than walking its rows,
  // which would leave it open with nothing in it focused.
  const onPickerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(list.current?.querySelectorAll('button') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1)
      : e.key === 'ArrowUp' ? Math.max(0, at - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? rows.length - 1
      : null;
    if (to !== null) {
      e.preventDefault();
      rows[to]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div
      ref={setNodeRef}
      className={`group flex min-h-32 flex-col rounded-lg border p-2 transition-colors ${
        lit && refuses ? 'cursor-not-allowed border-(--color-dep) bg-(--color-dep-fill)'
        : lit ? 'border-sky-600 bg-sky-950/20'
        : 'border-(--color-edge) bg-(--color-panel)/40'
      } ${vibes ? `sk-col${hot ? ' sk-hot' : ''}${skipped ? ' sk-col-closed' : ''}` : ''}`}
    >
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h3
          className={`font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted) uppercase ${
            vibes ? `sk-col-t${skipped ? ' sk-col-skip' : ''}` : ''
          }`}
        >
          {STAGE_LABELS[stage]}
        </h3>
        <span
          className={`font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted)/60 ${
            vibes ? 'sk-cnt' : ''
          }`}
        >
          {cards.length}
        </span>
        {/* Claude runs in three columns on the calm board. In VIBES MODE it runs
            in every one it has not skipped, so those headers get the diamond. */}
        {vibes && skipped ? (
          <span className="sk-skip ml-auto">Skipped</span>
        ) : (
          (vibes || isRunnable(stage)) && (
            <span title="Claude runs here" className={`ml-auto text-xs text-sky-500 ${vibes ? 'sk-runs' : ''}`}>
              ◆
            </span>
          )
        )}
      </div>
      {vibes && children}
      {/* Named after the column so columnCollisions can find its cards. */}
      {!vibes && (
        <SortableContext id={id} items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-2">
            {cards.map((c) => <SortableCard key={c.id} card={c} onOpen={onOpen} />)}
          </div>
        </SortableContext>
      )}
      {/* Outside the SortableContext, so columnCollisions never counts it as a
          card, and gone while anything is dragged: a drop here is a drop on
          the column. Faded in rather than mounted on hover, so it keeps its
          place in the tab order. Held while a card is being made, since a
          double-click would otherwise make two and open both. Never in VIBES
          MODE, whose well holds nothing and whose cards come from Ship it.
          With two repos or more, its first click turns the same dashed box
          into a list of where the card starts: the lane sets its project,
          but only a person can say which repo, and the first of several,
          picked by nobody, filed cards in the wrong one. The list is held at
          full opacity, so it does not fade under a pointer that has left
          the column. */}
      {onAdd && !active && !vibes && (picking ?
        <div
          ref={list}
          role="group"
          aria-labelledby={`${pickerId}-heading`}
          onKeyDown={onPickerKeyDown}
          className={`${cards.length ? 'mt-2' : ''} flex flex-col rounded-md border border-dashed border-slate-500 py-1`}
        >
          <div
            id={`${pickerId}-heading`}
            className="px-2 pt-1 pb-1 font-mono text-[11px]/4 font-medium tracking-[0.06em] whitespace-nowrap text-(--color-muted) uppercase"
          >
            Start in…
          </div>
          {/* Dropdown's Option, as buttons: focus is the highlight, and a
              pointer moving over a row takes it, so only one is ever lit. */}
          {addOptions.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={adding}
              onPointerMove={(e) => e.currentTarget.focus()}
              onClick={() => {
                close(false);
                onAdd(o.value);
              }}
              className="flex cursor-pointer items-center gap-2 px-2 py-1 text-left font-mono text-[11px]/[18px] whitespace-nowrap text-(--color-text)/85 outline-none focus:bg-white/4 focus:text-(--color-text) disabled:cursor-wait"
            >
              {o.color !== undefined && (
                <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: o.color }} />
              )}
              <span className="min-w-0 grow truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-(--color-muted)">{o.hint}</span>}
            </button>
          ))}
        </div>
      : <button
          ref={ghost}
          type="button"
          onClick={add}
          disabled={adding}
          aria-label="Add a card"
          className={`${cards.length ? 'mt-2' : ''} flex h-[3.75rem] items-center justify-center rounded-md border border-dashed border-(--color-edge) text-lg text-(--color-muted) opacity-0 transition-opacity group-hover:opacity-100 hover:border-slate-500 hover:text-(--color-text) focus-visible:opacity-100 focus-visible:outline-none focus-visible:border-sky-600 disabled:cursor-wait`}
        >
          +
        </button>
      )}
    </div>
  );
}

function SortableCard({ card, onOpen }: { card: ApiCard; onOpen?: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });
  const links = useLinks();
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'opacity-30' : ''}
      // Keyboard focus lands here, on dnd-kit's handle, not on the face inside
      // it — so this is where tabbing to a card traces its chain. React's focus
      // events bubble, which covers the Run button inside too.
      onFocus={() => links.enter(card.id)}
      onBlur={() => links.leave(card.id)}
      {...attributes}
      {...listeners}
    >
      <CardFace card={card} onOpen={onOpen} />
    </div>
  );
}
