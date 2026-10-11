import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CardDetail, EffortLevel } from '@reeve/shared';
import { api } from '../lib/api.js';
import { Dropdown } from '../lib/Dropdown.js';
import { modelFamilyColor } from '../lib/modelTint.js';
import {
  effortLevelsFor, keepEffort, modelFamilies, overflowModelOptions, OVERFLOW_DEFAULT, type ModelFamily,
} from '../lib/models.js';

/** Short enough to sit in a 40-ish px segment beside three others. */
const FAMILY_LABEL: Record<ModelFamily, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };

/**
 * The model and effort this card's runs use, stacked above the title's byline
 * at the top right of the header — a preview of what the card looks like
 * while running, since the family toggle wears the same tint the running
 * glow then picks up.
 *
 * Only for a task, outside VIBES MODE: see the `modelEffort` prop on
 * `CardHeader`. The budget field this replaced in the rail stays there, as
 * `Budget` in `Rail.tsx`; this is model and effort alone.
 */
export function ModelEffort({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: Infinity });
  const models = data?.models ?? [];
  const { model, effort } = detail.card;
  const set = useMutation({
    mutationFn: (body: { model?: string | null; effort?: EffortLevel | null }) => api.updateCard(detail.card.id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const families = modelFamilies(models);
  const overflow = overflowModelOptions(models, model);
  const levels = effortLevelsFor(models, model);

  const pickModel = (value: string | null) => set.mutate({ model: value, effort: keepEffort(models, value, effort) });

  return (
    <div className="flex w-[260px] shrink-0 flex-col gap-1">
      <div className="flex items-center justify-end gap-1">
        <div role="group" aria-label="Model family for this card's runs" className="flex overflow-hidden rounded-sm border border-(--color-edge)">
          {(Object.keys(FAMILY_LABEL) as ModelFamily[]).map((family) => {
            const m = families[family];
            const active = Boolean(m && m.value === model);
            const tone = modelFamilyColor(family);
            return (
              <button
                key={family}
                type="button"
                disabled={!m || set.isPending}
                aria-pressed={active}
                title={m?.displayName ?? `No ${FAMILY_LABEL[family]} listed`}
                onClick={() => m && pickModel(active ? null : m.value)}
                style={active ? { background: `${tone}33`, color: tone, borderColor: tone } : undefined}
                className={`border-r border-(--color-edge) px-2 py-1 font-mono text-[11px]/4 whitespace-nowrap last:border-r-0 disabled:opacity-30 ${
                  active ? '' : 'text-(--color-muted) hover:bg-white/4 hover:text-(--color-text)'
                }`}
              >
                {FAMILY_LABEL[family]}
              </button>
            );
          })}
        </div>
        <Dropdown
          variant="chip"
          label="Other model for this card's runs"
          // '' never matches `OVERFLOW_DEFAULT`, so whenever nothing from
          // this list is in effect — nothing pinned at all, or a family the
          // toggle already shows — the trigger falls through to the plain
          // "…" placeholder rather than restating "Settings default".
          value={model && !Object.values(families).some((m) => m?.value === model) ? model : ''}
          disabled={set.isPending}
          placeholder="…"
          options={overflow}
          onChange={(v) => pickModel(v === OVERFLOW_DEFAULT ? null : v)}
          title="Every other model, including one this CLI no longer lists"
          className="block max-w-[64px] truncate rounded-sm border border-(--color-edge) px-1.5 py-1 font-mono text-[11px]/4 text-(--color-muted) hover:text-(--color-text)"
        />
      </div>
      <EffortSlider levels={levels} effort={effort} onChange={(v) => set.mutate({ effort: v })} disabled={set.isPending} />
    </div>
  );
}

const STOP_TONE: Record<EffortLevel, string> = {
  low: 'var(--color-effort-low)',
  medium: 'var(--color-effort-medium)',
  high: 'var(--color-effort-high)',
  xhigh: 'var(--color-effort-xhigh)',
  max: 'var(--color-effort-max)',
};

/**
 * Hand-built rather than a native `<input type="range">`: a range has no way
 * to show its own disabled reason, cannot colour-code its steps, and a drag
 * started on it cannot be told apart from one meant for the card underneath.
 * Stops rather than a continuum, since effort is a small fixed set of levels
 * and the position is the whole UI — "Settings default" plus whatever the
 * current model supports, keyed the same way the old dropdown's options were.
 */
function EffortSlider({ levels, effort, onChange, disabled }: {
  levels: readonly EffortLevel[];
  effort: EffortLevel | null;
  onChange: (v: EffortLevel | null) => void;
  disabled: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const stops: Array<EffortLevel | null> = [null, ...levels];
  const index = Math.max(0, stops.indexOf(effort));
  const last = stops.length - 1;
  const pct = last === 0 ? 0 : (index / last) * 100;
  const label = effort ?? 'Default';
  const tone = effort ? STOP_TONE[effort] : 'var(--color-muted)';

  if (levels.length === 0) {
    return (
      <div className="flex w-full justify-end">
        <span title="This model reports no effort levels of its own" className="font-mono text-[10px]/4 text-(--color-muted)">
          No effort on this model
        </span>
      </div>
    );
  }

  const indexAt = (clientX: number): number => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return index;
    const fraction = (clientX - rect.left) / rect.width;
    return Math.round(Math.max(0, Math.min(1, fraction)) * last);
  };

  const pick = (at: number) => {
    const clamped = Math.max(0, Math.min(last, at));
    if (clamped !== index) onChange(stops[clamped] ?? null);
  };

  // Dragging reads from pointermove on the document rather than the handle,
  // the usual way to keep a drag tracking the pointer once it has left the
  // element that started it — pointer capture would do the same, but this
  // needs no capture id bookkeeping for a track this small.
  const startDrag = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    setDragging(true);
    pick(indexAt(e.clientX));
    const move = (ev: PointerEvent) => pick(indexAt(ev.clientX));
    const up = () => {
      setDragging(false);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  return (
    <div className="flex w-full flex-col">
      <div className="flex w-full items-center gap-2">
        <div
          ref={track}
          role="slider"
          aria-label="Effort for this card's runs"
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={index}
          aria-valuetext={label}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? -1 : 0}
          onPointerDown={startDrag}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); pick(index + 1); }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); pick(index - 1); }
            else if (e.key === 'Home') { e.preventDefault(); pick(0); }
            else if (e.key === 'End') { e.preventDefault(); pick(last); }
          }}
          className={`relative h-4 grow ${disabled ? 'cursor-default opacity-40' : 'cursor-pointer'}`}
        >
          {/* The track itself: a heat ramp from cool to hot, bright only up to
              where the handle sits, dim past it — the same "how far into
              overdrive" the handle's glow says, read at a glance. */}
          <div className="absolute inset-y-0 left-0 right-0 my-auto h-1 rounded-full bg-white/8" />
          <div
            className="absolute inset-y-0 left-0 my-auto h-1 rounded-full"
            style={{
              width: `${pct}%`,
              background: 'linear-gradient(90deg, var(--color-effort-low), var(--color-effort-medium), var(--color-effort-high), var(--color-effort-xhigh), var(--color-effort-max))',
            }}
          />
          {stops.map((s, i) => (
            <span
              key={s ?? 'default'}
              aria-hidden="true"
              className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
              style={{ left: `${last === 0 ? 0 : (i / last) * 100}%`, transform: 'translate(-50%, -50%)', background: i <= index ? 'transparent' : 'rgba(255,255,255,0.18)' }}
            />
          ))}
          <span
            aria-hidden="true"
            className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 -translate-x-1/2 rounded-full border border-black/30 transition-[left] ${
              dragging ? '' : 'duration-150'
            } ${effort === 'max' ? 'effort-overdrive' : ''}`}
            style={{ left: `${pct}%`, background: tone }}
          />
        </div>
        <span
          className="w-12 shrink-0 text-right font-mono text-[10px]/4"
          style={{ color: effort ? tone : 'var(--color-muted)' }}
        >
          {effort === 'max' ? 'Max 🔥' : label}
        </span>
      </div>
    </div>
  );
}
