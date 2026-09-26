import type { SickoState } from '@reeve/shared';
import { tokens } from '../card/format.js';

/**
 * The scoreboard along the bottom: five numbers and a running log of what
 * Claude has done to your repository since you stopped being asked.
 *
 * Every figure is counted server-side from the moment the switch was flipped,
 * off the cards' own event log, so a reload does not reset the tally and the
 * numbers cannot claim something a card's history denies.
 *
 * Human approvals is the one that matters, and it is the only still number
 * here: a plain white nought while every other figure churns through the
 * rainbow.
 */
export function SickoHud({ state, pop }: { state: SickoState; pop: boolean }) {
  return (
    <div className="sk-hud">
      {/* Only the merge count pops, and it alternates class so two merges in a
          row each restart the animation instead of the second being ignored. */}
      <Stat label="Merged to main" value={state.merged} className={pop ? 'sk-pop-a' : 'sk-pop-b'} />
      <Stat label="Human approvals" value={state.humanApprovals} />
      <Stat label="Reviews skipped" value={state.reviewsSkipped} />
      <Stat label="Questions self-answered" value={state.questionsSelfAnswered} />
      <Stat label="Tokens" value={tokens(state.spendTokens)} zero={state.spendTokens === 0} />
      <div className="sk-log">
        {/* Two deep: the newest in white, the one before it faded out. */}
        {state.log.slice(0, 2).map((line, i) => (
          <p key={`${i}-${line}`} className={`sk-log-line${i ? ' sk-old' : ''}`}>
            <span className="sk-log-d" aria-hidden="true">◆</span> {line}
          </p>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, className, zero }: {
  label: string;
  value: number | string;
  className?: string;
  zero?: boolean;
}) {
  const nothing = zero ?? value === 0;
  return (
    <div className="sk-stat">
      <span className="sk-stat-l">{label}</span>
      <span className={`sk-stat-n${nothing ? ' sk-zero' : ''}${className && !nothing ? ` ${className}` : ''}`}>
        {value}
      </span>
    </div>
  );
}
