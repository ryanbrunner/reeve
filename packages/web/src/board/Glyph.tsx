/**
 * The Reeve mark: the bar, the bowl and the diamond.
 *
 * Inline rather than an `<img>` because the diamond is the one part of the
 * product that SICKO MODE spins and cycles through the rainbow, and a document
 * cannot reach inside an image to do that.
 */
export function Glyph() {
  return (
    <svg className="h-5 w-auto overflow-visible" viewBox="0 0 34 40" role="img" aria-label="Reeve">
      <rect x="0" y="0" width="11" height="40" rx="3" fill="#e6edf3" />
      <path d="M15 0h8a11 11 0 0 1 0 22h-8z" fill="#e6edf3" />
      <path className="sk-dia" d="M26 24l8 8-8 8-8-8z" fill="#00a6f4" />
    </svg>
  );
}

/**
 * The card-face marks for links, sized to sit inside a 10px mono chip
 * and drawn in `currentColor` so the chip decides what they mean.
 */
function Mini({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="h-2.5 w-2.5 shrink-0"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * A padlock: shut while something this card waits on is unfinished, sprung
 * once it all is. The same shape both ways so the satisfied chip reads as the
 * blocked one having let go, rather than as some other fact about the card.
 */
export function WaitsGlyph({ open = false }: { open?: boolean }) {
  return (
    <Mini>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d={open ? 'M5.5 7V4.5a2.5 2.5 0 0 1 4.9-.7' : 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2'} />
    </Mini>
  );
}

/**
 * A shoot branching off a stem: one card's run put out another. Drawn apart
 * from the fork below, which is dependents, because being suggested by a card
 * does not mean waiting on it.
 */
export function SuggestedGlyph() {
  return (
    <Mini>
      <path d="M5 2.5v11" />
      <path d="M5 10c0-3 2.5-4.5 6-4.5" />
      <circle cx="12" cy="5.5" r="1.5" />
    </Mini>
  );
}

/** A line forking in two: other cards carry on from this one. */
export function NeededByGlyph() {
  return (
    <Mini>
      <path d="M2.5 8H7l4-4.5M7 8l4 4.5" />
      <path d="M11 3.5h2.5M11 12.5h2.5" />
    </Mini>
  );
}
