/**
 * The strip under the header: what VIBE MODE is doing, and what it has
 * crossed out.
 *
 * The struck-through entries are the point of it. A list of things that are ON
 * would read as a feature list; a list with "planning", "code review",
 * "guardrails" and "staging" scored out in magenta reads as what it is.
 */
const WORDS: ReadonlyArray<readonly [string, boolean]> = [
  ['No human in the loop', false],
  ['Auto-merging to main', false],
  ['Planning', true],
  ['Plan: none. Vibes: immaculate', false],
  ['Code review', true],
  ['Tests: vibes', false],
  ['Backlog → Done, no stops', false],
  ['Claude answered its own question', false],
  ['Guardrails', true],
  ['You are a spectator now', false],
  ['Staging', true],
  ['Ship it ship it ship it', false],
];

export function VibeTicker() {
  return (
    <div className="sk-ticker" aria-hidden="true">
      {/* Twice, because the marquee scrolls by exactly half its own width: at
          the wrap the second copy is where the first one was and the loop is
          invisible. */}
      <div className="sk-ticker-run">
        {[0, 1].map((half) =>
          WORDS.map(([text, gone]) => (
            <span key={`${half}-${text}`} className={`sk-tk${gone ? ' sk-tk-gone' : ''}`}>
              <span className="sk-tk-d">◆</span>
              <span className="sk-tk-t">{text}</span>
            </span>
          )),
        )}
      </div>
    </div>
  );
}
