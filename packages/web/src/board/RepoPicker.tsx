import { useId, useRef, type CSSProperties } from 'react';
import type { ApiRepo } from '@reeve/shared';
import { fromHome } from '../card/format.js';
import { Eyebrow, SmallButton } from '../card/ui.js';
import { Chevron, Dropdown, Listbox, useDismiss, type ListboxOption } from '../ui/Listbox.js';

/**
 * Picking a repo, the three places it happens: a new card's, before there is
 * a card; an open card's, from the chip in its header; and VIBES MODE's Ship
 * it, whose card is never opened.
 */

/** The swatch a card from this repo wears on the board, when it has no project's colour. */
const NO_COLOR = '#3f4754';

/** One repo: its colour, its name, and where it is, which is what tells two checkouts of one repo apart. */
export function RepoRow({ name, color, detail }: { name: string; color: string | null; detail?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-[2px]" style={{ background: color ?? NO_COLOR }} />
      <div className="min-w-0">
        <div className="truncate text-[13px]/[18px] text-(--color-text)">{name}</div>
        {detail && <div className="truncate font-mono text-[10px]/[14px] text-(--color-muted)">{detail}</div>}
      </div>
    </div>
  );
}

const repoOption = (r: ApiRepo): ListboxOption => ({
  value: r.id,
  content: <RepoRow name={r.name} color={r.laneColor} detail={fromHome(r.repoPath)} />,
});

/**
 * Where the ghost card was, when a new card's repo is not obvious: asked
 * first, because a card cannot run anywhere until it has one, and a card made
 * under the first repo in the list was one filed wherever it happened to land.
 *
 * Nothing is made until a row is picked, so walking away from this leaves
 * nothing behind. It goes on Escape, Cancel, or a press anywhere else.
 */
export function NewCardPicker({ repos, onPick, onCancel, onAddRepo, busy = false }: {
  repos: ApiRepo[];
  onPick: (repoId: string) => void;
  onCancel: () => void;
  /** With no repos there is nothing to pick, and this is the way out. */
  onAddRepo: () => void;
  /** A card is being made from a pick already. */
  busy?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const eyebrow = useId();
  useDismiss(panel, onCancel);
  return (
    <div
      ref={panel}
      role="group"
      aria-labelledby={eyebrow}
      // The list stops its own Escape. This catches the one from Cancel or Add
      // a repo, and the empty state, which has no list.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        onCancel();
      }}
      className="rounded-md border border-sky-600 bg-(--color-panel) p-2"
    >
      <div id={eyebrow} className="px-1 pb-1.5">
        <Eyebrow>New card in…</Eyebrow>
      </div>
      {/* Focus goes to the list, or with no repos to the button that fixes that. */}
      {repos.length > 0 ?
        <Listbox
          options={repos.map(repoOption)}
          label="Repo for the new card"
          onPick={onPick}
          onEscape={onCancel}
          disabled={busy}
          autoFocus
        />
      : <div className="flex flex-col items-start gap-2 px-1 pb-1">
          <p className="text-sm/5 text-(--color-muted)">No repos yet. A card needs one to run in.</p>
          <SmallButton tone="sky" autoFocus onClick={onAddRepo}>
            Add a repo
          </SmallButton>
        </div>
      }
      <div className="mt-1.5 flex justify-end border-t border-(--color-edge) pt-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 rounded-sm py-0.5 pr-0.5 pl-1.5 font-mono text-[11px]/4 text-(--color-muted) outline-none hover:text-(--color-text) focus-visible:ring-1 focus-visible:ring-sky-600"
        >
          Cancel
          <kbd className="rounded-[3px] bg-(--color-ink) px-1 font-mono text-[10px]/[14px] text-(--color-muted)">esc</kbd>
        </button>
      </div>
    </div>
  );
}

/**
 * The repo chip that opens a list of repos: the card header's, and Ship it's.
 * The caller dresses the trigger, since one is a lane-coloured chip and the
 * other a form field.
 */
export function RepoSelect({
  repos,
  value,
  onChange,
  label,
  none = false,
  orphan = null,
  placeholder = 'Pick a repo',
  disabled = false,
  title,
  className,
  style,
}: {
  repos: ApiRepo[];
  value: string | null;
  onChange: (repoId: string | null) => void;
  label: string;
  /** Offer No repo, ruled off below the repos. Never for a new card. */
  none?: boolean;
  /** The card's own repo, archived since: still its, so still pickable. */
  orphan?: { id: string; name: string } | null;
  /** What the trigger says while nothing is picked. */
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const options: ListboxOption[] = [
    ...(orphan ? [{ value: orphan.id, content: <RepoRow name={orphan.name} color={null} detail="archived" /> }] : []),
    ...repos.map(repoOption),
    ...(none ? [{ value: '', apart: true, content: <RepoRow name="No repo" color={null} /> }] : []),
  ];
  // A card with no repo reads as asking for one, not as having chosen none:
  // it cannot run until it has one, whatever the list's check says.
  const shown = repos.find((r) => r.id === value)?.name ?? (orphan?.id === value ? orphan.name : placeholder);
  return (
    <Dropdown
      options={options}
      // No repo is a choice like any other in the header, so it takes the check.
      selected={value ?? (none ? '' : undefined)}
      onPick={(v) => {
        const next = v || null;
        if (next !== value) onChange(next);
      }}
      label={label}
      triggerLabel={`${label}: ${shown}`}
      disabled={disabled}
      title={title}
      className={className}
      style={style}
    >
      <span className="truncate">{shown}</span>
      {!disabled && <Chevron />}
    </Dropdown>
  );
}
