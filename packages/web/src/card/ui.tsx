import type { ReactNode } from 'react';

/**
 * The small vocabulary the detail view is built from.
 *
 * Machine facts are mono and quiet; the things a person wrote are sans and
 * plain. That split is the whole typographic idea of this design, and it only
 * holds if every section reaches for the same handful of pieces rather than
 * spelling out its own.
 */

/** A section's name. Mono, uppercase, muted — never competes with its content. */
export function Eyebrow({ children, count }: { children: ReactNode; count?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <h3 className="font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted) uppercase">
        {children}
      </h3>
      {count !== undefined && count !== null && (
        <span className="font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted)/60">
          {count}
        </span>
      )}
    </div>
  );
}

/** An eyebrow with something pushed to the right of it — a button, a timestamp. */
export function SectionHead({ children, count, aside }: { children: ReactNode; count?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Eyebrow count={count}>{children}</Eyebrow>
      {aside}
    </div>
  );
}

/** A key and its value, ellipsised. The rail is almost entirely these. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 font-mono text-[11px]/[18px]">
      <span className="shrink-0 text-(--color-muted)">{label}</span>
      <span className="min-w-0 truncate text-right text-(--color-text)">{children}</span>
    </div>
  );
}

export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'lane' }) {
  return (
    <span
      className={`inline-block rounded-sm px-1.5 py-0.5 font-mono text-[10px]/4 whitespace-nowrap ${
        tone === 'lane' ? '' : 'bg-slate-500/15 text-slate-300'
      }`}
    >
      {children}
    </span>
  );
}

/** A file path, a branch, a sha: something the machine owns and a person copies. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-sm border border-(--color-edge) bg-(--color-ink) px-1.5 py-px font-mono text-[11px]/4 whitespace-nowrap text-(--color-text)">
      {children}
    </code>
  );
}

type ButtonTone = 'plain' | 'sky' | 'review' | 'input' | 'error';

const TONES: Record<ButtonTone, string> = {
  plain: 'border-(--color-edge) text-(--color-text) hover:border-slate-600',
  sky: 'border-sky-800 text-sky-300 hover:border-sky-600 hover:bg-sky-500/10',
  // A button on a tinted surface takes that surface's colour, because it
  // belongs to it. Same rule the board's Retry button follows.
  review: 'border-(--color-activity-review-border) bg-(--color-activity-review-fill) text-emerald-200',
  input: 'border-(--color-activity-input-border) bg-(--color-activity-input-fill) text-amber-100',
  error: 'border-(--color-btn-error-border) bg-(--color-btn-error-fill) text-red-200 shadow-(--shadow-btn-error-glow)',
};

/** The mono 11px button the rail and section headers use. */
export function SmallButton({
  children,
  tone = 'plain',
  ...rest
}: { children: ReactNode; tone?: ButtonTone } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`rounded-sm border px-2 py-[3px] font-mono text-[11px]/4 whitespace-nowrap disabled:opacity-40 ${TONES[tone]}`}
    >
      {children}
    </button>
  );
}

/** The sans 14px button the attention band uses, where the stakes are higher. */
export function Button({
  children,
  tone = 'plain',
  ...rest
}: { children: ReactNode; tone?: ButtonTone } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`rounded-md border px-3 py-[5px] text-sm/5 font-medium whitespace-nowrap disabled:opacity-40 ${TONES[tone]}`}
    >
      {children}
    </button>
  );
}

/** What a section says when it has nothing to say. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm/5 text-(--color-muted)">{children}</p>;
}
