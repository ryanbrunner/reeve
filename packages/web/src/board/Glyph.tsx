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
