import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * The one list-picker in the app: model, effort, repo, and the card to depend
 * on.
 *
 * Hand-built rather than a native select because a native one cannot carry a
 * lane's colour dot, a stage beside a card's title or a filter box, and
 * rather than a library because every other overlay here is a `createPortal`
 * and a few dozen lines too.
 *
 * String-valued like the element it replaces, so a call site's
 * `e.target.value || null` becomes `v || null` and nothing else changes. `''`
 * is an ordinary option — "No repo", "Settings default" — not a special case.
 */
export type DropdownOption = { value: string; label: string; hint?: string; color?: string };
export type DropdownGroup = { group: string; options: DropdownOption[] };

type Row = { kind: 'group'; label: string; id: string } | { kind: 'option'; option: DropdownOption; index: number };

// Above the modals (50) and the Lightbox (60), below the toast (70): a list
// opened in the card must draw over the card, and a "Copied" line over both.
const LAYER = 'z-[65]';
const MAX_HEIGHT = 288;
const GAP = 4;
const MARGIN = 8;
const TYPEAHEAD_MS = 500;

export function Dropdown({
  label,
  value,
  options,
  onChange,
  placeholder = '',
  variant = 'field',
  searchable = false,
  disabled = false,
  title,
  className = '',
  style,
}: {
  /** The accessible name. What is picked is the trigger's text. */
  label: string;
  value: string;
  options: Array<DropdownOption | DropdownGroup>;
  onChange: (value: string) => void;
  /** Shown when no option has `value`, as the dependency picker's always is. */
  placeholder?: string;
  /** A bordered field, sized by the caller, or the card header's tinted chip. */
  variant?: 'field' | 'chip';
  /** A filter box at the top of the list, for lists too long to scan. */
  searchable?: boolean;
  /** Shut and unopenable, but still hoverable; see the trigger below. */
  disabled?: boolean;
  title?: string;
  /** On the trigger only. The list lives on the body and keeps its own look. */
  className?: string;
  style?: CSSProperties;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: '', at: 0 });

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<CSSProperties | null>(null);

  const all = useMemo(
    () => options.flatMap((o) => ('group' in o ? o.options : [o])),
    [options],
  );
  const selected = all.find((o) => o.value === value);

  // What the list shows, headings and all, and the options alone in the same
  // order: the active index counts options only, so the arrows never land on
  // a heading. A group the filter has emptied loses its heading too.
  const { rows, shown } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (o: DropdownOption, group?: string) =>
      !needle || [o.label, o.hint, group].some((s) => s?.toLowerCase().includes(needle));
    const rows: Row[] = [];
    const shown: DropdownOption[] = [];
    options.forEach((o, g) => {
      const group = 'group' in o ? o.group : undefined;
      const kept = ('group' in o ? o.options : [o]).filter((opt) => matches(opt, group));
      if (kept.length === 0) return;
      if (group !== undefined) rows.push({ kind: 'group', label: group, id: `${id}-group-${g}` });
      for (const option of kept) rows.push({ kind: 'option', option, index: shown.push(option) - 1 });
    });
    return { rows, shown };
  }, [options, query, id]);

  const show = (at?: number) => {
    if (disabled) return;
    setQuery('');
    setActive(at ?? Math.max(0, all.findIndex((o) => o.value === value)));
    setPos(null);
    setOpen(true);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const pick = (option: DropdownOption | undefined) => {
    if (!option) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  };

  // A picker that locks while its change saves shuts with it.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Focus goes where the keys are read: the filter when there is one, the
  // trigger otherwise. Safari does not focus a clicked button, so the trigger
  // is focused on purpose rather than assumed.
  useEffect(() => {
    if (!open) return;
    if (searchable) filter.current?.focus();
    else trigger.current?.focus();
  }, [open, searchable]);

  // Placed before paint, so the list never flashes at the top-left corner.
  // Below the trigger unless it would not fit there and fits better above,
  // and never taller than the room it has, so a picker at the foot of the rail
  // opens upward rather than off the bottom of the window.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = trigger.current?.getBoundingClientRect();
      const l = list.current;
      const s = scroller.current;
      if (!t || !l || !s) return;
      const natural = Math.min(MAX_HEIGHT, l.offsetHeight - s.clientHeight + s.scrollHeight);
      const below = window.innerHeight - t.bottom - GAP - MARGIN;
      const above = t.top - GAP - MARGIN;
      const up = natural > below && above > below;
      const width = Math.min(Math.max(t.width, l.offsetWidth), window.innerWidth - 2 * MARGIN);
      setPos({
        left: Math.max(MARGIN, Math.min(t.left, window.innerWidth - MARGIN - width)),
        minWidth: t.width,
        maxHeight: Math.min(MAX_HEIGHT, up ? above : below),
        ...(up ? { bottom: window.innerHeight - t.top + GAP } : { top: t.bottom + GAP }),
      });
    };
    place();
    // Capture, because the thing that scrolls is usually the rail or the
    // modal, and a scroll does not bubble.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, rows.length]);

  // Pointerdown rather than click, so a drag that starts outside still shuts
  // it. The trigger counts as inside: its own click toggles the list, and
  // closing here first would have that click open it again.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (trigger.current?.contains(target) || list.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const move = (to: number) => setActive(Math.max(0, Math.min(shown.length - 1, to)));

  // Jump to the next option starting with what has been typed in the last
  // half second, as a native select does.
  const typeahead = (key: string) => {
    const now = Date.now();
    const text = (now - typed.current.at > TYPEAHEAD_MS ? '' : typed.current.text) + key.toLowerCase();
    typed.current = { text, at: now };
    const from = text.length === 1 ? active + 1 : active;
    const order = [...shown.slice(from), ...shown.slice(0, from)];
    const hit = order.find((o) => o.label.toLowerCase().startsWith(text));
    if (!hit) return;
    const at = shown.indexOf(hit);
    if (open) setActive(at);
    else show(at);
  };

  // Shared by the trigger and the filter. Every key handled is prevented, and
  // Escape stopped as well: the card and Settings both close on an Escape
  // that reaches `document`, and with the list open it is the list's alone.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      } else if (!searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        typeahead(e.key);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        return move(active + 1);
      case 'ArrowUp':
        e.preventDefault();
        return move(active - 1);
      case 'Home':
      case 'End':
        // In the filter these move the caret, as they do in any text field.
        if (searchable) return;
        e.preventDefault();
        return move(e.key === 'Home' ? 0 : shown.length - 1);
      case 'Enter':
        e.preventDefault();
        return pick(shown[active]);
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        return close(true);
      case 'Tab':
        // Not prevented: from the trigger, Tab carries on to whatever follows
        // it rather than from the end of the body, where the list is.
        return close(true);
      case ' ':
        if (searchable) return;
        e.preventDefault();
        return pick(shown[active]);
      default:
        if (!searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) typeahead(e.key);
    }
  };

  const look =
    variant === 'chip' ?
      'rounded-sm px-1.5 py-0.5 font-mono text-[10px]/4 outline-none focus-visible:ring-1 focus-visible:ring-sky-600'
    : `flex min-w-0 items-center gap-1.5 border font-mono text-[11px]/[18px] outline-none focus-visible:border-sky-600 ${
        open ? 'border-sky-600' : 'border-(--color-edge)'
      } ${disabled ? 'opacity-50' : ''}`;

  return (
    <>
      {/* Locked through aria-disabled rather than the attribute: a disabled
          button shows no tooltip in some browsers, and the repo chip's title
          is the only place that says why it is locked. */}
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !searchable && shown[active] ? optionId(active) : undefined}
        aria-disabled={disabled || undefined}
        title={title}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={onKeyDown}
        // Space activates a button on keyup, after keydown has already opened
        // or picked; without this the click would undo it.
        onKeyUp={(e) => e.key === ' ' && e.preventDefault()}
        className={`text-left ${disabled ? 'cursor-default' : 'cursor-pointer'} ${look} ${className}`}
        style={style}
      >
        {variant === 'chip' ?
          (selected?.label ?? placeholder)
        : <>
            <span className="min-w-0 grow">{selected?.label ?? placeholder}</span>
            <svg aria-hidden="true" viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0 text-(--color-muted)">
              <path d="M2.5 4 5 6.5 7.5 4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </>
        }
      </button>
      {open &&
        // On the body, like every modal: VIBES MODE transforms the stage, and
        // a fixed element inside a transformed ancestor is fixed to that
        // instead of the window. Which also means the list is outside `.vibes`
        // and keeps the calm palette, as a passing overlay can.
        createPortal(
          <div
            ref={list}
            className={`fixed ${LAYER} flex max-w-[min(28rem,calc(100vw-16px))] flex-col overflow-hidden rounded-md border border-(--color-edge) bg-(--color-panel) shadow-[0_8px_24px_-6px_#000c]`}
            style={pos ?? { top: 0, left: 0, visibility: 'hidden' }}
          >
            {searchable && (
              <input
                ref={filter}
                type="text"
                role="combobox"
                aria-label={`Filter: ${label}`}
                aria-expanded
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={shown[active] ? optionId(active) : undefined}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Filter…"
                className="shrink-0 border-b border-(--color-edge) bg-transparent px-2 py-1.5 font-mono text-[11px]/[18px] text-(--color-text) outline-none placeholder:text-(--color-muted)"
              />
            )}
            <div ref={scroller} id={listId} role="listbox" aria-label={label} className="min-h-0 overflow-y-auto py-1">
              {shown.length === 0 && (
                <p className="px-2 py-1 font-mono text-[11px]/[18px] text-(--color-muted)">Nothing matches</p>
              )}
              {rows.map((row) =>
                row.kind === 'group' ?
                  <div
                    key={row.id}
                    id={row.id}
                    role="presentation"
                    className="px-2 pt-2 pb-1 font-mono text-[11px]/4 font-medium tracking-[0.06em] whitespace-nowrap text-(--color-muted) uppercase"
                  >
                    {row.label}
                  </div>
                : <Option
                    key={`${row.index}-${row.option.value}`}
                    id={optionId(row.index)}
                    index={row.index}
                    option={row.option}
                    active={row.index === active}
                    selected={row.option.value === value}
                    onHover={() => setActive(row.index)}
                    onPick={() => pick(row.option)}
                  />,
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function Option({ id, index, option, active, selected, onHover, onPick }: {
  id: string;
  index: number;
  option: DropdownOption;
  active: boolean;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-index={index}
      onPointerMove={onHover}
      // Keep focus on the trigger or the filter: an option is not focusable,
      // so a mousedown here would otherwise hand focus to the body.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className={`flex cursor-pointer items-center gap-2 px-2 py-1 font-mono text-[11px]/[18px] whitespace-nowrap ${
        active ? 'bg-white/4' : ''
      } ${selected ? 'text-(--color-text)' : 'text-(--color-text)/85'}`}
    >
      {option.color !== undefined && (
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: option.color }} />
      )}
      <span className="min-w-0 grow truncate">{option.label}</span>
      {option.hint && <span className="shrink-0 text-(--color-muted)">{option.hint}</span>}
      <span aria-hidden="true" className="w-3 shrink-0 text-right text-sky-400">
        {selected ? '✓' : ''}
      </span>
    </div>
  );
}
