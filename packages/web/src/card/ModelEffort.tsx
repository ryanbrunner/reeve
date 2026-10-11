import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isRunnable, type CardDetail, type EffortLevel, type RunnableStage } from '@reeve/shared';
import { api } from '../lib/api.js';
import { Dropdown } from '../lib/Dropdown.js';
import { modelFamilyColor } from '../lib/modelTint.js';
import {
  effortLevelsFor, findModel, keepEffort, modelFamilies, overflowModelOptions, OVERFLOW_DEFAULT, unpinnedModel,
  type ModelFamily,
} from '../lib/models.js';

/** Short enough to sit in a 40-ish px segment beside three others. */
const FAMILY_LABEL: Record<ModelFamily, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };

/**
 * The model and effort this card's runs use, stacked above the title's byline
 * at the top right of the header — a preview of what the card looks like
 * while running, since the family toggle wears the same tint the running
 * glow then picks up.
 *
 * Neither picker marks "nothing pinned here" on its own: a card with no
 * explicit model or effort runs with whatever it resolves to —
 * `card.model ?? stageDefaults[stage].model ?? stage.model ?? the CLI's own
 * default`, the same order `modelAndEffortFor` builds on the server — and that
 * resolved value is what shows selected instead. No stage module sets its
 * own model, so a card not pinned by Settings either falls to the CLI's own
 * default (`unpinnedModel` in `models.ts`); every stage module does set an
 * effort, so the slider almost always has a non-default fallback beneath
 * Settings too.
 *
 * Only for a task, outside VIBES MODE: see the `modelEffort` prop on
 * `CardHeader`. The budget field this replaced in the rail stays there, as
 * `Budget` in `Rail.tsx`; this is model and effort alone.
 */
export function ModelEffort({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: Infinity });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const models = data?.models ?? [];
  const { model, effort } = detail.card;
  const set = useMutation({
    mutationFn: (body: { model?: string | null; effort?: EffortLevel | null }) => api.updateCard(detail.card.id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  // Backlog has no stage defaults of its own — Planning is what starting it runs next.
  const runStage: RunnableStage = isRunnable(detail.card.stage) ? detail.card.stage : 'planning';
  const defaultModel =
    settings?.stageDefaults[runStage]?.model ?? data?.builtIn[runStage]?.model ?? unpinnedModel(models);
  const defaultEffort = settings?.stageDefaults[runStage]?.effort ?? data?.builtIn[runStage]?.effort ?? null;
  const effectiveModel = model ?? defaultModel;

  const families = modelFamilies(models);
  const overflow = overflowModelOptions(models, effectiveModel);
  const levels = effortLevelsFor(models, effectiveModel);
  // Matched by alias or resolved id, so a default stored as either still
  // lights up the family it belongs to rather than the plain "default" row.
  const matchedFamily = Object.values(families).find(
    (m) => m && effectiveModel != null && (m.value === effectiveModel || m.resolvedModel === effectiveModel),
  );
  const overflowModel = matchedFamily ? null : (findModel(models, effectiveModel)?.value ?? effectiveModel);

  const pickModel = (value: string | null) =>
    set.mutate({ model: value, effort: keepEffort(models, value ?? defaultModel, effort) });

  return (
    <div className="flex w-[260px] shrink-0 flex-col gap-2.5">
      <div className="flex flex-col items-end gap-1">
        <span className="font-mono text-[10px]/4 font-medium tracking-[0.06em] text-(--color-muted) uppercase">
          Model
        </span>
        <div className="flex items-center gap-1">
          <div role="group" aria-label="Model family for this card's runs" className="flex overflow-hidden rounded-sm border border-(--color-edge)">
            {(Object.keys(FAMILY_LABEL) as ModelFamily[]).map((family) => {
              const m = families[family];
              const active = Boolean(m && matchedFamily && m.value === matchedFamily.value);
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
            // The resolved model — the card's own pin, or whatever stands in
            // for it — unless the toggle already shows it: `null` when a
            // family matched, so this falls through to the plain "…"
            // placeholder rather than restating what the toggle already said.
            value={overflowModel ?? ''}
            disabled={set.isPending}
            placeholder="…"
            options={overflow}
            onChange={(v) => pickModel(v === OVERFLOW_DEFAULT ? null : v)}
            title="Every other model, including one this CLI no longer lists"
            className="block max-w-[64px] truncate rounded-sm border border-(--color-edge) px-1.5 py-1 font-mono text-[11px]/4 text-(--color-muted) hover:text-(--color-text)"
          />
        </div>
      </div>
      <EffortSlider
        levels={levels}
        effort={effort}
        defaultEffort={defaultEffort}
        onChange={(v) => set.mutate({ effort: v })}
        disabled={set.isPending}
      />
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
 * Stops rather than a continuum, since effort is a small fixed set of levels,
 * keyed the same way the old dropdown's options were.
 *
 * No stop of its own for "nothing pinned": the handle sits on `defaultEffort`
 * — the stage default this card falls back to — so an untouched card reads
 * exactly like one explicitly set to that level. Picking that same stop is
 * `onChange(null)`, so the card reverts to following Settings rather than
 * pinning the level it happened to already show.
 */
function EffortSlider({ levels, effort, defaultEffort, onChange, disabled }: {
  levels: readonly EffortLevel[];
  effort: EffortLevel | null;
  defaultEffort: EffortLevel | null;
  onChange: (v: EffortLevel | null) => void;
  disabled: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const stops = levels;
  const last = stops.length - 1;
  const effective = effort ?? defaultEffort;
  // -1 while settings are still loading, or if a model switch left the
  // default on a level this one doesn't support — nothing claims a stop
  // rather than guessing the lowest one.
  const rawIndex = effective ? stops.indexOf(effective) : -1;
  const known = rawIndex !== -1;
  const index = known ? rawIndex : 0;
  const current = known ? stops[index] : undefined;
  const pct = known && last > 0 ? (index / last) * 100 : 0;
  const label = current ?? '…';
  const tone = current ? STOP_TONE[current] : 'var(--color-muted)';

  if (levels.length === 0) {
    return (
      <div className="flex w-full flex-col items-end gap-1">
        <span className="font-mono text-[10px]/4 font-medium tracking-[0.06em] text-(--color-muted) uppercase">
          Effort
        </span>
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
    if (clamped === index) return;
    const picked = stops[clamped] ?? null;
    onChange(picked === defaultEffort ? null : picked);
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
    <div className="flex w-full flex-col gap-1">
      <span className="text-right font-mono text-[10px]/4 font-medium tracking-[0.06em] text-(--color-muted) uppercase">
        Effort
      </span>
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
              key={s}
              aria-hidden="true"
              className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
              style={{ left: `${last === 0 ? 0 : (i / last) * 100}%`, transform: 'translate(-50%, -50%)', background: known && i <= index ? 'transparent' : 'rgba(255,255,255,0.18)' }}
            />
          ))}
          <span
            aria-hidden="true"
            className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 -translate-x-1/2 rounded-full border border-black/30 transition-[left] ${
              dragging ? '' : 'duration-150'
            } ${current === 'max' ? 'effort-overdrive' : ''} ${known ? '' : 'opacity-0'}`}
            style={{ left: `${pct}%`, background: tone }}
          />
        </div>
        <span className="w-12 shrink-0 text-right font-mono text-[10px]/4" style={{ color: tone }}>
          {current === 'max' ? 'Max 🔥' : label}
        </span>
      </div>
    </div>
  );
}
