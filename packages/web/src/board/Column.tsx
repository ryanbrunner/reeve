import { closestCenter, pointerWithin, rectIntersection, useDroppable, type CollisionDetection } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { STAGE_LABELS, isRunnable, type ApiCard, type Stage } from '@reeve/shared';
import { CardFace } from './CardFace.js';

export const COLUMN_PREFIX = 'col:';

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
  sicko = false,
  hot = false,
  skipped = false,
  children,
}: {
  stage: Stage;
  laneId: string | null | undefined;
  cards: ApiCard[];
  onOpen?: (id: string) => void;
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
  const id = `${COLUMN_PREFIX}${stage}|${laneId ?? 'all'}`;
  const { setNodeRef, isOver, over } = useDroppable({ id, disabled: sicko });
  // Over one of its cards is over the column too; that is where the card lands.
  const lit = isOver || cards.some((c) => c.id === over?.id);
  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-32 flex-col rounded-lg border p-2 transition-colors ${
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
