import { closestCenter, pointerWithin, rectIntersection, useDroppable, type CollisionDetection } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { STAGE_LABELS, isRunnable, type ApiCard, type Stage } from '@reeve/shared';
import { CardFace } from './CardFace.js';

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
  adding = false,
}: {
  stage: Stage;
  laneId: string | null;
  cards: ApiCard[];
  onOpen?: (id: string) => void;
  /** Offered as a ghost card at the foot of the column. Backlog is where new work goes, so only it has one. */
  onAdd?: () => void;
  adding?: boolean;
}) {
  const id = columnId(stage, laneId);
  const { setNodeRef, isOver, over, active } = useDroppable({ id });
  // Over one of its cards is over the column too; that is where the card lands.
  const lit = isOver || cards.some((c) => c.id === over?.id);
  return (
    <div
      ref={setNodeRef}
      className={`group flex min-h-32 flex-col rounded-lg border p-2 transition-colors ${
        lit ? 'border-sky-600 bg-sky-950/20' : 'border-(--color-edge) bg-(--color-panel)/40'
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
      {/* Named after the column so columnCollisions can find its cards. */}
      <SortableContext id={id} items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2">
          {cards.map((c) => <SortableCard key={c.id} card={c} onOpen={onOpen} />)}
        </div>
      </SortableContext>
      {/* Outside the SortableContext, so columnCollisions never counts it as a
          card, and gone while anything is dragged: a drop here is a drop on
          the column. Faded in rather than mounted on hover, so it keeps its
          place in the tab order. Held while a card is being made, since a
          double-click would otherwise make two and open both. */}
      {onAdd && !active && (
        <button
          type="button"
          onClick={onAdd}
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
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'opacity-30' : ''}
      {...attributes}
      {...listeners}
    >
      <CardFace card={card} onOpen={onOpen} />
    </div>
  );
}
