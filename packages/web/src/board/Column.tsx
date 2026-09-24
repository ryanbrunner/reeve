import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { STAGE_LABELS, isRunnable, type ApiCard, type Stage } from '@reeve/shared';
import { CardFace } from './CardFace.js';

export const COLUMN_PREFIX = 'col:';

export function Column({
  stage,
  laneId,
  cards,
  onOpen,
}: {
  stage: Stage;
  laneId: string | null | undefined;
  cards: ApiCard[];
  onOpen?: (id: string) => void;
}) {
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
          {cards.map((c) => <SortableCard key={c.id} card={c} onOpen={onOpen} />)}
        </div>
      </SortableContext>
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
