import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';

/**
 * A list to pick one thing from, drawn in the board's own colours rather than
 * handed to the OS, whose menu is a light grey sheet on a dark board and cannot
 * show a repo's colour or path beside its name.
 *
 * Focus stays on the list and `aria-activedescendant` says which row the arrows
 * are on, so a screen reader follows along without focus hopping from row to
 * row. Nothing is active when it opens: Enter picks only a row somebody moved
 * to, so a list that opened under a stray keystroke cannot choose for them.
 */

export interface ListboxOption {
  value: string;
  /** What the row shows. */
  content: ReactNode;
  /** Ruled off from the rows above it: a choice of a different kind, like No repo. */
  apart?: boolean;
}

export function Listbox({
  options,
  selected,
  onPick,
  onEscape,
  label,
  disabled = false,
  autoFocus = false,
  className = '',
}: {
  options: ListboxOption[];
  /** Marked with a check. Nothing is, when there is no current choice. */
  selected?: string;
  onPick: (value: string) => void;
  onEscape: () => void;
  label: string;
  /** Shown but not pickable: a pick is already on its way. */
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(-1);
  const rowId = (i: number) => `${id}-${i}`;

  useEffect(() => {
    if (autoFocus) list.current?.focus();
  }, [autoFocus]);

  // Kept in view as the arrows walk past the bottom of a list that scrolls.
  useEffect(() => {
    if (active >= 0) document.getElementById(rowId(active))?.scrollIntoView({ block: 'nearest' });
  });

  const last = options.length - 1;
  const onKeyDown = (e: React.KeyboardEvent) => {
    const to =
      e.key === 'ArrowDown' ? (active < 0 ? 0 : Math.min(active + 1, last))
      : e.key === 'ArrowUp' ? (active < 0 ? last : Math.max(active - 1, 0))
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (to !== null) {
      e.preventDefault();
      setActive(to);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const option = options[active];
      if (option && !disabled) onPick(option.value);
      return;
    }
    if (e.key === 'Escape') {
      // Both, because the card modal closes on an Escape reaching the document:
      // stopped here, and marked as handled for any listener that sees it anyway.
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    }
  };

  return (
    <ul
      ref={list}
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={active >= 0 ? rowId(active) : undefined}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={`flex flex-col outline-none ${className}`}
    >
      {options.map((o, i) => (
        <li
          key={o.value}
          id={rowId(i)}
          role="option"
          aria-selected={o.value === selected}
          onMouseMove={() => active !== i && setActive(i)}
          onClick={() => !disabled && onPick(o.value)}
          className={o.apart ? 'mt-1 border-t border-(--color-edge) pt-1' : undefined}
        >
          <div
            className={`flex items-center gap-2 rounded-sm px-2 py-1.5 ${
              disabled ? 'cursor-wait opacity-40' : 'cursor-pointer'
            } ${i === active ? 'bg-slate-500/15' : ''}`}
          >
            <div className="min-w-0 grow">{o.content}</div>
            {o.value === selected && (
              <span aria-hidden="true" className="shrink-0 text-[11px] text-sky-400">✓</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Calls `onDismiss` when a press lands outside `ref`, or focus moves somewhere
 * outside it. Focus going nowhere is left alone: that is the window losing
 * focus to another app, and coming back should find the list still open.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, onDismiss: () => void, active = true) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    const outside = (t: EventTarget | null) => t instanceof Node && !el?.contains(t);
    const onDown = (e: MouseEvent) => outside(e.target) && dismiss.current();
    const onFocusOut = (e: FocusEvent) => outside(e.relatedTarget) && dismiss.current();
    document.addEventListener('mousedown', onDown);
    el?.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('mousedown', onDown);
      el?.removeEventListener('focusout', onFocusOut);
    };
  }, [ref, active]);
}

/**
 * A button that opens a Listbox under it: the custom stand-in for a `<select>`.
 *
 * The list opens downward and inside its trigger's box, not portaled, so it
 * needs room below and a stacking order above whatever it covers. The card
 * modal is `overflow-hidden`, which is why nothing here opens upward.
 */
export function Dropdown({
  children,
  options,
  selected,
  onPick,
  label,
  triggerLabel,
  disabled = false,
  title,
  className = '',
  style,
  panelClassName = '',
}: {
  /** What the trigger shows. */
  children: ReactNode;
  options: ListboxOption[];
  selected?: string;
  onPick: (value: string) => void;
  /** The list's name. */
  label: string;
  /** The trigger's name, when its text alone does not say what it picks. */
  triggerLabel?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(root, () => setOpen(false), open);
  // Back to the trigger after a pick or Escape, so the keyboard carries on
  // from where it was. Not after a click elsewhere, which put focus there.
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        title={title}
        aria-label={triggerLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          setOpen(true);
        }}
        className={`flex cursor-pointer items-center gap-1 whitespace-nowrap disabled:cursor-default ${className}`}
        style={style}
      >
        {children}
      </button>
      {open && (
        <div
          className={`absolute top-full left-0 z-30 mt-1 max-h-64 w-72 overflow-y-auto rounded-md border border-(--color-edge) bg-(--color-panel) p-1 shadow-lg shadow-black/40 ${panelClassName}`}
        >
          <Listbox
            options={options}
            selected={selected}
            label={label}
            autoFocus
            onPick={(v) => {
              close();
              onPick(v);
            }}
            onEscape={close}
          />
        </div>
      )}
    </div>
  );
}

/** The trigger's chevron. Left off a locked trigger, which opens nothing. */
export function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 10 10" className="size-2.5 shrink-0 opacity-70">
      <path d="M2.5 4 5 6.5 7.5 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
