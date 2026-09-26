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
  sicko = false,
  hot = false,
  skipped = false,
  children,
}: {
  stage: Stage;
  /** The lane's project; null is No project. */
  laneId: string | null | undefined;
  cards: ApiCard[];
  onOpen?: (id: string) => void;
  /** Offered as a ghost card at the foot of the column. Backlog is where new work goes, so only it has one. */
  onAdd?: () => void;
  adding?: boolean;
  /**
   * The column as a well: its cards have lifted off it into the flying layer,
   * so it keeps its header and its count and holds nothing. Not a droppable
   * either, because nobody drags anything in SICKO MODE.
   */
  sicko?: boolean;
  /** Something just landed here. Only SICKO MODE says so; a drag lights it itself. */
  hot?: boolean;
  /** SICKO MODE goes straight past this column: struck out, and closed. */
  skipped?: boolean;
  /** Drawn inside the well. Only a SICKO well has room for anything but cards. */
  children?: React.ReactNode;
}) {
  const id = columnId(stage, laneId ?? null);
  const { setNodeRef, isOver, over, active } = useDroppable({ id, disabled: sicko });
  // Over one of its cards is over the column too; that is where the card lands.
  const lit = isOver || cards.some((c) => c.id === over?.id);
  return (
    <div
      ref={setNodeRef}
      className={`group flex min-h-32 flex-col rounded-lg border p-2 transition-colors ${
        lit ? 'border-sky-600 bg-sky-950/20' : 'border-(--color-edge) bg-(--color-panel)/40'
      } ${sicko ? `sk-col${hot ? ' sk-hot' : ''}${skipped ? ' sk-col-closed' : ''}` : ''}`}
    >
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h3
          className={`font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted) uppercase ${
            sicko ? `sk-col-t${skipped ? ' sk-col-skip' : ''}` : ''
          }`}
        >
          {STAGE_LABELS[stage]}
        </h3>
        <span
          className={`font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted)/60 ${
            sicko ? 'sk-cnt' : ''
          }`}
        >
          {cards.length}
        </span>
        {/* Claude runs in three columns on the calm board. In SICKO MODE it runs
            in every one it has not skipped, so those headers get the diamond. */}
        {sicko && skipped ? (
          <span className="sk-skip ml-auto">Skipped</span>
        ) : (
          (sicko || isRunnable(stage)) && (
            <span title="Claude runs here" className={`ml-auto text-xs text-sky-500 ${sicko ? 'sk-runs' : ''}`}>
              ◆
            </span>
          )
        )}
      </div>
      {sicko && children}
      {/* Named after the column so columnCollisions can find its cards. */}
      {!sicko && (
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
          double-click would otherwise make two and open both. Never in SICKO
          MODE, whose well holds nothing and whose cards come from Ship it. */}
      {onAdd && !active && !sicko && (
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
