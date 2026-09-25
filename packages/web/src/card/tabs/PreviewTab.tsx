import { useCallback, useState } from 'react';
import type { ApiAsset, CardDetail } from '@reeve/shared';
import { when } from '../format.js';
import { Lightbox } from '../Lightbox.js';
import { Empty, SectionHead } from '../ui.js';

type View = 'mockup' | 'build' | 'both';

/**
 * The build, beside the drawing of it.
 *
 * A screenshot pairs with a mockup by having the same label, which is not an
 * accident of naming: the mockup's own page and width are what told the
 * capturer where to go, so the pair exists because one caused the other.
 */
export function PreviewTab({ detail }: { detail: CardDetail }) {
  const shots = detail.assets.filter((a) => a.kind === 'screenshot');
  const mockups = detail.assets.filter((a) => a.kind === 'mockup');
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>('both');

  const shot = shots.find((s) => s.id === selected) ?? shots[0] ?? null;
  // A person's mockup over one Claude drew, as Testing compares them.
  const paired = shot ? mockups.filter((m) => m.label === shot.label) : [];
  const mockup = shot ? (paired.find((m) => m.runId === null) ?? paired[0] ?? null) : (mockups[0] ?? null);
  const differences = detail.differences.filter(
    (d) => !shot || d.screenshotAssetId === shot.id || d.screenshotAssetId === null,
  );

  if (shots.length === 0 && mockups.length === 0) {
    return (
      <Empty>
        Nothing to show yet. Attach a mockup in the Plan tab, or leave Generate mockups ticked for
        Claude to draw them while planning, and Testing will photograph the same page to sit beside
        it.
      </Empty>
    );
  }

  if (shots.length === 0) {
    return (
      <>
        <SectionHead count={mockups.length}>Mockups</SectionHead>
        <Empty>
          No screenshots yet — run Testing and Claude will photograph these pages in the build.
        </Empty>
        <div className="grid grid-cols-2 gap-3">
          {mockups.map((m) => (
            <Figure key={m.id} asset={m} kind={mockupKind(m)} caption={`${m.url ?? ''} · ${m.viewport ?? '?'}px`} />
          ))}
        </div>
      </>
    );
  }

  const pair = mockup && shot;
  return (
    <>
      <section className="flex flex-col gap-3">
        <SectionHead
          aside={
            pair ? (
              <div role="group" aria-label="Compare view" className="flex overflow-hidden rounded-md border border-(--color-edge)">
                {(['mockup', 'build', 'both'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                    className={`px-2.5 py-1 font-mono text-[11px]/4 not-first:border-l not-first:border-(--color-edge) ${
                      view === v ? 'bg-white/8 text-(--color-text)' : 'text-(--color-muted) hover:text-(--color-text)'
                    }`}
                  >
                    {v === 'both' ? 'Side by side' : v === 'mockup' ? 'Mockup' : 'Build'}
                  </button>
                ))}
              </div>
            ) : null
          }
        >
          {pair ? 'Compare with mockup' : 'Build'}
        </SectionHead>

        <div className={pair && view === 'both' ? 'grid grid-cols-2 gap-3' : ''}>
          {pair && view !== 'build' && (
            <Figure asset={mockup} kind={mockupKind(mockup)} caption={`${mockup.url ?? ''} · ${mockup.viewport ?? '?'}px`} />
          )}
          {(!pair || view !== 'mockup') && shot && (
            <Figure
              asset={shot}
              kind="Build"
              caption={`${shot.url ?? ''} · ${shot.viewport ?? '?'}px · ${when(shot.createdAt)}`}
            />
          )}
        </div>

        {differences.map((d) => (
          <div key={d.id} className="flex items-start gap-2.5">
            <span className="box-border h-5 w-5 shrink-0 rounded-sm border border-sky-800 text-center font-mono text-[11px]/[18px] text-sky-300">
              {d.position}
            </span>
            <p className="text-sm/5 text-(--color-text)">
              <strong className="font-medium">{d.claim}</strong>
              {d.note && <span className="text-(--color-muted)"> {d.note}</span>}
            </p>
          </div>
        ))}
      </section>

      {shots.length > 1 && (
        <section className="flex flex-col gap-2.5">
          <SectionHead
            count={shots.length}
            aside={
              <span className="font-mono text-[11px]/4 text-(--color-muted)">
                Captured by Claude in run {detail.checks ? runLabel(detail, detail.checks.runId) : '—'}
              </span>
            }
          >
            Screenshots
          </SectionHead>
          <div className="grid grid-cols-4 gap-3">
            {shots.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={s.id === shot?.id}
                onClick={() => setSelected(s.id)}
                className="flex flex-col gap-1.5 text-left"
              >
                <span
                  className={`block overflow-hidden rounded-md border ${
                    s.id === shot?.id ? 'border-sky-600' : 'border-(--color-edge)'
                  }`}
                >
                  <img src={s.src} alt={s.label} className="block aspect-[16/10] w-full bg-(--color-ink) object-cover object-top" />
                </span>
                <span className="truncate font-mono text-[10px]/[14px] text-(--color-muted)">{s.label}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** Clipped to its top here, so a click opens the whole page. */
function Figure({ asset, kind, caption }: { asset: ApiAsset; kind: string; caption: string }) {
  const [open, setOpen] = useState(false);
  // Stable, or every poll of the card would re-run the lightbox's effect.
  const close = useCallback(() => setOpen(false), []);
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <figcaption className="flex justify-between gap-2 font-mono text-[10px]/4">
        <span className="font-medium tracking-[0.06em] text-(--color-text) uppercase">{kind}</span>
        <span className="truncate text-(--color-muted)">{caption}</span>
      </figcaption>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View ${kind} full screen`}
        className="block cursor-zoom-in overflow-hidden rounded-md border border-(--color-edge) hover:border-slate-600"
      >
        <img
          src={asset.src}
          alt={`${kind}: ${asset.label}`}
          className="block max-h-[21rem] w-full bg-(--color-ink) object-cover object-top"
        />
      </button>
      {open && <Lightbox asset={asset} kind={kind} caption={caption} onClose={close} />}
    </figure>
  );
}

/** A mockup Planning drew carries its run; a person's carries none. */
function mockupKind(mockup: ApiAsset): string {
  return mockup.runId ? 'Mockup by Claude' : 'Mockup';
}

/** Runs are numbered as a person counts them: oldest is 1. */
function runLabel(detail: CardDetail, runId: string): number {
  const claude = detail.runs.filter((r) => r.kind === 'claude');
  return claude.length - claude.findIndex((r) => r.id === runId);
}
