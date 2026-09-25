import { STAGES, type ApiCard } from '@reeve/shared';
import { Column } from '../board/Column.js';
import { SickoCards, useSickoLane } from './Cards.js';
import { cardsIn } from '../lib/api.js';

/**
 * One swim lane in SICKO MODE: five wells, and the lane's cards flying over
 * them.
 *
 * A component of its own because the motion bookkeeping is a hook, and the
 * board renders one of these per lane — hooks cannot be called in that loop.
 * The lane grows only when a column is deep enough to need it, so on an
 * ordinary board it is exactly the height the calm one was.
 */
export function SickoLane({ cards, laneId, justMerged, onOpen }: {
  cards: ApiCard[];
  laneId: string | null | undefined;
  justMerged: ReadonlySet<string>;
  onOpen?: (id: string) => void;
}) {
  const { placed, height, hot } = useSickoLane(cards);
  return (
    <div className="sk-lane-body" style={{ height }}>
      <div className="sk-cols grid w-full grid-cols-5 gap-3">
        {STAGES.map((stage, i) => (
          <Column
            key={stage}
            stage={stage}
            laneId={laneId}
            cards={cardsIn(cards, stage)}
            onOpen={onOpen}
            sicko
            hot={hot.has(i)}
          />
        ))}
      </div>
      <SickoCards placed={placed} justMerged={justMerged} onOpen={onOpen} />
    </div>
  );
}
