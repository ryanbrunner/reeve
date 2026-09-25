import { useEffect, useMemo, useRef, useState } from 'react';
import { STAGES, type ApiCard, type Stage } from '@reeve/shared';
import { CardFace } from '../board/CardFace.js';

/**
 * The board in SICKO MODE: the columns become empty wells and every card lifts
 * off them into one absolutely-positioned layer, so a card the server moved
 * FLIES to its new column instead of vanishing from one list and appearing in
 * another.
 *
 * Nobody drags anything in here, which is what pays for this: with no sortable
 * cards there is no drag state for an overlay to fight with, and the cost of
 * the effect is a transform per card.
 *
 * Every measurement below is the calm board's own, so the two layouts land in
 * exactly the same places.
 */

/** Column header line, its 8px margin, the column's padding and its border. */
const TOP = 33;

/** Two clamped title lines plus the footer — a calm two-line card, to the pixel. */
const CARD_H = 88;

/** One card below the previous: its height plus the column's 8px card gap. */
const STEP = CARD_H + 8;

/** How much room the stack gets before the cards start overlapping. */
const SPAN = 192;

/**
 * How far apart cards may be squeezed: the card's top padding plus one line of
 * its title, so the deck always reads.
 *
 * A column of four fits inside SPAN by spreading; a column of twenty cannot,
 * and the choice is between a stack nobody can read and a taller lane. The lane
 * grows. What you get is a fanned deck — every card's first title line showing,
 * later cards lying over earlier ones — which is at least a picture of how much
 * is piled up in that column.
 */
const MIN_STEP = 30;

interface Placed {
  card: ApiCard;
  /** Which column, as an index into STAGES. */
  col: number;
  y: number;
  z: number;
  rot: number;
  /** Negative, so no two cards wobble in phase. */
  delay: number;
  /** Alternates on each arrival, which is what restarts the slam. */
  bump: boolean;
  /** On its way off the board. */
  ship: boolean;
}

interface Motion {
  stage: Stage;
  rot: number;
  delay: number;
  bump: boolean;
  /** Last placement, kept so a card that has left the board can fly from it. */
  col: number;
  y: number;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export function useSickoLane(cards: ApiCard[]) {
  // Per-card motion, carried across polls. A ref rather than state because
  // writing it must not itself cause a render: it is derived from `cards` and
  // read in the same pass that computes it.
  const motion = useRef(new Map<string, Motion>());
  const [leaving, setLeaving] = useState<Placed[]>([]);
  const [hot, setHot] = useState<ReadonlySet<number>>(() => new Set());

  const { placed, height, arrivals } = useMemo(() => {
    const byCol = STAGES.map((stage) =>
      cards.filter((c) => c.stage === stage).sort((a, b) => a.position - b.position),
    );
    // Per column, not per lane: a full Done column must not squash a Backlog of
    // three into the same fan.
    const steps = byCol.map((a) => (a.length <= 3 ? STEP : Math.max(MIN_STEP, SPAN / (a.length - 1))));
    // As tall as its deepest column needs, and never shorter than the four-card
    // lane the calm board would have drawn.
    const height = Math.max(
      TOP + CARD_H + SPAN + 9,
      ...byCol.map((a, i) => TOP + CARD_H + Math.max(0, a.length - 1) * steps[i]! + 9),
    );

    const arrivals = new Set<number>();
    const placed: Placed[] = [];
    byCol.forEach((column, col) => {
      column.forEach((card, k) => {
        const y = TOP + k * steps[col]!;
        const prev = motion.current.get(card.id);
        // A card is only re-rotated when it lands somewhere new, so it holds
        // still between polls instead of twitching on every board refresh.
        const moved = prev !== undefined && prev.stage !== card.stage;
        const m: Motion =
          prev === undefined ?
            { stage: card.stage, rot: rnd(-3.5, 3.5), delay: -rnd(0, 2), bump: col % 2 === 0, col, y }
          : moved ? { stage: card.stage, rot: rnd(-4.5, 4.5), delay: prev.delay, bump: !prev.bump, col, y }
          : { ...prev, col, y };
        motion.current.set(card.id, m);
        if (moved) arrivals.add(col);
        placed.push({ card, col, y, z: k + 1, rot: m.rot, delay: m.delay, bump: m.bump, ship: false });
      });
    });

    /*
     * Sorted by id, which is to say in no order at all — and that is the point.
     *
     * Built column by column above, this list reorders the moment a card
     * changes column, and React answers a reordered keyed list by MOVING the
     * DOM node. A move is a removal and an insertion, which throws away the
     * computed style the transition needed as its starting point: the card
     * would arrive in its new column instantly, and the one animation this
     * whole layer exists for would silently never play. An order that does not
     * depend on where a card is means React only ever writes new styles onto
     * nodes that stay put. Painting order is `z` and is unaffected.
     */
    placed.sort((a, b) => (a.card.id < b.card.id ? -1 : 1));

    // Cards that are no longer on the board — archived, or filed under another
    // repo — get one more render on their way out, so they leave by flying off
    // to main rather than by blinking out of existence.
    const live = new Set(cards.map((c) => c.id));
    for (const id of motion.current.keys()) {
      if (!live.has(id)) motion.current.delete(id);
    }

    return { placed, height, arrivals };
  }, [cards]);

  // A column glows for a beat after something lands in it.
  useEffect(() => {
    if (arrivals.size === 0) return;
    setHot(arrivals);
    const t = setTimeout(() => setHot(new Set()), 700);
    return () => clearTimeout(t);
  }, [arrivals]);

  // Held one render behind so a departing card can be handed its last known
  // position; cleared once the flight is over.
  const previous = useRef<Placed[]>([]);
  useEffect(() => {
    const live = new Set(placed.map((p) => p.card.id));
    const gone = previous.current.filter((p) => !live.has(p.card.id) && !p.ship);
    previous.current = placed;
    if (gone.length === 0) return;
    setLeaving(gone.map((p) => ({ ...p, ship: true })));
    const t = setTimeout(() => setLeaving([]), 600);
    return () => clearTimeout(t);
  }, [placed]);

  return { placed: [...placed, ...leaving], height, hot };
}

export function SickoCards({ placed, justMerged, onOpen }: {
  placed: Placed[];
  justMerged: ReadonlySet<string>;
  onOpen?: (id: string) => void;
}) {
  return (
    <div className="sk-cards">
      {placed.map((p) => (
        <div
          key={p.card.id}
          className={`sk-slot${p.ship ? ' sk-ship' : ''}`}
          style={{
            zIndex: p.z,
            '--sk-i': p.col,
            '--sk-y': `${p.y}px`,
            '--sk-rot': `${p.rot.toFixed(2)}deg`,
            '--sk-d': `${p.delay.toFixed(2)}s`,
          } as React.CSSProperties}
        >
          {/* Three nested elements, one transform each: the slot flies, the
              bounce slams on arrival, the wobble idles. Stacking them is the
              only way to have all three at once. */}
          <div className={`sk-bounce ${p.bump ? 'sk-slam-a' : 'sk-slam-b'}`}>
            <div className="sk-wob">
              <CardFace card={p.card} onOpen={onOpen} sicko stamped={justMerged.has(p.card.id)} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
