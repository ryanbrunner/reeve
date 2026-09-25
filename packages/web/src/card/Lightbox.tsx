import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ApiAsset } from '@reeve/shared';

/**
 * One mockup or screenshot, as large as it will go.
 *
 * Shown at its own width rather than fitted to the screen: these are full-page
 * renders, and a tall page shrunk to fit is a strip too thin to read. The page
 * scrolls instead, the way it would in the browser it was drawn for.
 *
 * It opens over a card, whose modal already answers Escape on the document.
 * Listening there too would close both, so this listens on the window while
 * the key is still on its way down, and the card never hears it.
 */
export function Lightbox({ asset, kind, caption, onClose }: {
  asset: ApiAsset;
  kind: string;
  caption: string;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      restoreFocus.current?.focus?.();
    };
  }, [onClose]);

  // The picture fills the screen, so the dark around it is the scrim: a click
  // that lands on the backdrop itself closes, and one on the picture does not.
  const onBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={`${kind}: ${asset.label}`}
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex flex-col bg-[#0e1116eb] outline-none"
    >
      <header className="flex shrink-0 items-center gap-3 px-5 py-3.5" onClick={onBackdrop}>
        <span className="font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-text) uppercase">
          {kind}
        </span>
        <span className="min-w-0 truncate text-sm text-(--color-text)">{asset.label}</span>
        <span className="min-w-0 truncate font-mono text-[11px]/4 text-(--color-muted)">{caption}</span>
        <div className="grow" onClick={onBackdrop} />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close full screen view"
          className="flex items-center gap-1.5 rounded-sm border border-(--color-edge) py-[3px] pr-1 pl-2 font-mono text-[11px]/4 text-(--color-text) hover:border-slate-600"
        >
          Close
          <kbd className="rounded-[3px] bg-(--color-ink) px-1 font-mono text-[10px]/[14px] text-(--color-muted)">
            esc
          </kbd>
        </button>
      </header>
      <div className="min-h-0 grow overflow-y-auto px-5 pb-5" onClick={onBackdrop}>
        <img
          src={asset.src}
          alt={`${kind}: ${asset.label}`}
          className="mx-auto block h-auto max-w-full rounded-md border border-(--color-edge) bg-(--color-ink)"
        />
      </div>
    </div>,
    document.body,
  );
}
