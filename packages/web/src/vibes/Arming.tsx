import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';

/**
 * Two seconds of arming, spent naming every guardrail that is coming off.
 *
 * This is the only confirmation VIBES MODE has, and it is deliberately not a
 * dialog: there is no Cancel, because the switch is its own undo and a modal
 * asking "are you sure?" would be a safeguard, which is the one thing this
 * feature is against. What it does instead is tell you exactly what you just
 * did, in words, while it is happening.
 */
const OFF = [
  ['Human review', 'off'],
  ['Stage gates', 'off'],
  ['Planning', 'skipped'],
  ['Merge to main', 'automatic'],
  ['New ideas', 'run on arrival'],
] as const;
const WATCHING = ['You', 'watching'] as const;

export function VibesArming() {
  // Up for about two seconds; if this has not answered yet it falls through
  // to the on-by-default reading, which is fine — the server is what actually
  // enforces the setting, this overlay is only naming it.
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const suggestTasks = data?.suggestTasks ?? true;

  return (
    <div className="sk-arm" role="status">
      {/* Three copies, stacked: the white one is the text, the other two are
          the chromatic split coming apart around it. */}
      <div className="sk-arm-title">
        <span className="sk-g sk-g-2" aria-hidden="true">VIBES MODE</span>
        <span className="sk-g sk-g-3" aria-hidden="true">VIBES MODE</span>
        <h2 className="sk-g sk-g-1">VIBES MODE</h2>
      </div>
      <p className="sk-arm-sub">Taking the human out of the loop…</p>
      <div className="sk-arm-list">
        {[
          ...OFF,
          ['What to build', suggestTasks ? 'Claude decides' : 'you decide (suggestions off)'],
          WATCHING,
        ].map(([label, value], i) => (
          <div key={label} className="sk-arm-row" style={{ '--sk-i': i } as React.CSSProperties}>
            <span>{label}</span>
            <span className="sk-lead" aria-hidden="true" />
            <span className="sk-v">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
