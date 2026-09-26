import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A line at the bottom of the window that says something small just happened
 * — "Copied branch reeve/12-some-slug" — and then goes away.
 *
 * Not SICKO MODE's `sk-toast`. That one is inline in the header, lasts seven
 * seconds and reports what the sweep did while you were away. This one only
 * confirms the thing you just did, so it is brief and does not stack. A second
 * message replaces the first and restarts the clock, because two "Copied"
 * lines in a column tell you nothing the newer one does not.
 */
type Tone = 'ok' | 'error';
type Toast = { id: number; message: ReactNode; tone: Tone };
type Show = (message: ReactNode, tone?: Tone) => void;

const LASTS_MS = 2_000;

// Only `show` goes in the context, and it never changes. Putting the message
// there too would re-render every caller each time a toast came or went.
const ShowToast = createContext<Show | null>(null);

export function useToast(): Show {
  const show = useContext(ShowToast);
  if (!show) throw new Error('useToast needs a ToastProvider above it');
  return show;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const next = useRef(0);

  const show = useCallback<Show>((message, tone = 'ok') => {
    clearTimeout(timer.current);
    setToast({ id: ++next.current, message, tone });
    timer.current = setTimeout(() => setToast(null), LASTS_MS);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <ShowToast.Provider value={show}>
      {children}
      {/* On the body, like every modal, and for the same reason: SICKO MODE
          transforms the stage, and a fixed element inside a transformed
          ancestor is no longer fixed to the window. z-[70] clears the card
          modal (50) and the Lightbox over it (60).

          The live region is always there and only its contents change. A
          region that mounts with its first message is one many screen
          readers never announce. */}
      {createPortal(
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-6 z-[70] flex justify-center px-6"
        >
          {toast && (
            // Keyed on the message, so a replacement fades in again rather
            // than swapping its text in place.
            <div
              key={toast.id}
              className={`toast-in flex max-w-[420px] items-baseline gap-1.5 rounded-md border border-(--color-edge) bg-(--color-panel) px-3 py-2 font-mono text-[11px]/4 shadow-lg shadow-black/40 ${
                toast.tone === 'error' ? 'text-red-300' : 'text-(--color-muted)'
              }`}
            >
              {toast.message}
            </div>
          )}
        </div>,
        document.body,
      )}
    </ShowToast.Provider>
  );
}
