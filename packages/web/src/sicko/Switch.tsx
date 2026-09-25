/**
 * The switch.
 *
 * Off it is the quietest control in the header — a mono label and a grey
 * diamond, sitting beside Swim lanes as if it were another view toggle. Hover
 * is the only warning: the label takes the rainbow before anything else does.
 * On, it is the loudest thing on the screen, because everything it turns off
 * is a thing that was protecting you.
 *
 * The diamond is deliberate. It is the same mark the board puts in a column
 * header to mean "Claude runs here", and in SICKO MODE that is every column.
 */
export function SickoSwitch({ on, onToggle, disabled }: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`sk-sw${on ? ' sk-on' : ''}`}
      aria-pressed={on}
      disabled={disabled}
      onClick={onToggle}
      title={
        on ?
          'Put the human back in the loop'
        : 'Turn off every guardrail. Claude moves, merges and ships without you'
      }
    >
      <span className="sk-sw-track" aria-hidden="true">
        <span className="sk-sw-knob" />
      </span>
      <span className="sk-sw-label">Sicko mode</span>
    </button>
  );
}
