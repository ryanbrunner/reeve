import { STAGES, type ApiCard } from '@reeve/shared';
import { Column } from '../board/Column.js';
import { VibeCards, useVibeLane } from './Cards.js';
import { cardsIn } from '../lib/api.js';

/**
 * One swim lane in VIBE MODE: five wells, one of them closed, and the lane's
 * cards flying over them.
 *
 * A component of its own because the motion bookkeeping is a hook, and the
 * board renders one of these per lane — hooks cannot be called in that loop.
 * The lane grows only when a column is deep enough to need it, so on an
 * ordinary board it is exactly the height the calm one was.
 */
export function VibeLane({ cards, laneId, justMerged, onOpen }: {
  cards: ApiCard[];
  laneId: string | null | undefined;
  justMerged: ReadonlySet<string>;
  onOpen?: (id: string) => void;
}) {
  const { placed, height, hot } = useVibeLane(cards);
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
            vibe
            hot={hot.has(i)}
            skipped={stage === 'planning'}
          >
            {stage === 'planning' && <NoPlanning />}
          </Column>
        ))}
      </div>
      <VibeCards placed={placed} justMerged={justMerged} onOpen={onOpen} />
    </div>
  );
}

/**
 * Planning, condemned. The sweep sends every card straight over it, so the
 * well is taped off rather than removed: five columns is what the flying
 * layer's arithmetic is written in, and a card sailing over a closed column
 * says where it did not stop better than a missing one could.
 *
 * The sign hangs at the bottom because a card left over from before the
 * switch still lands at the top, and it must not cover the joke.
 */
function NoPlanning() {
  const tape = 'Do not plan · '.repeat(8);
  return (
    <>
      <span className="sr-only">Planning is skipped in VIBE MODE</span>
      <div className="sk-tape sk-tape-a" aria-hidden="true">
        <span className="sk-tape-run">{tape}{tape}</span>
      </div>
      <div className="sk-tape sk-tape-b" aria-hidden="true">
        <span className="sk-tape-run">{tape}{tape}</span>
      </div>
      <div className="sk-sign" aria-hidden="true">
        <strong className="sk-sign-t">Closed for thinking</strong>
        <span className="sk-sign-s">plans are for people with doubts</span>
        <span className="sk-sign-e">est. 0 thoughts</span>
      </div>
    </>
  );
}
