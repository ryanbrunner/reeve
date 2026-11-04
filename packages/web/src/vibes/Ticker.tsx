import type { VibesOptions } from '@reeve/shared';
import { useVibesOptions } from './options.js';

/**
 * The strip under the header: what VIBES MODE is doing, and what it has
 * crossed out.
 *
 * The struck-through entries are the point of it. A list of things that are ON
 * would read as a feature list; a list with "planning", "code review",
 * "guardrails" and "staging" scored out in magenta reads as what it is.
 *
 * The ones about planning, testing and merging follow Settings' VIBES MODE
 * options, so the strip never crosses out a column the sweep still stops in.
 */
function words({ skipPlanning, skipTesting, autoMerge }: VibesOptions): ReadonlyArray<readonly [string, boolean]> {
  return [
    ['No human in the loop', false],
    autoMerge ? ['Auto-merging to main', false] : ['Merging', true],
    ...(skipPlanning
      ? [['Planning', true], ['Plan: none. Vibes: immaculate', false]] as const
      : [['Plans approved unread', false]] as const),
    ['Code review', true],
    skipTesting ? ['Testing', true] : ['Tests: vibes', false],
    ['Backlog → Release, no stops', false],
    ['Claude answered its own question', false],
    ['Guardrails', true],
    ['You are a spectator now', false],
    ['Staging', true],
    ['Ship it ship it ship it', false],
  ];
}

export function VibesTicker() {
  const list = words(useVibesOptions());
  return (
    <div className="sk-ticker" aria-hidden="true">
      {/* Twice, because the marquee scrolls by exactly half its own width: at
          the wrap the second copy is where the first one was and the loop is
          invisible. */}
      <div className="sk-ticker-run">
        {[0, 1].map((half) =>
          list.map(([text, gone]) => (
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
