import type { ApiModel } from '@reeve/shared';
import { findModel, MODEL_FAMILIES, type ModelFamily } from './models.js';

/**
 * Which family a model belongs to. Falls back to the raw value or id itself
 * when `models` has not loaded yet, or does not list it — a board poll can
 * arrive before `['models']` has, and a card running an id the CLI has since
 * retired still ran some family's model. A full id is rarely the bare family
 * name (`claude-opus-4-8`, not `opus-4-8`), so this looks for the family
 * anywhere in the name rather than only at the front, unlike `modelFamilies`'
 * own prefix match against a `displayName` it controls the shape of.
 */
export function familyOf(modelValue: string | null | undefined, models: ApiModel[]): ModelFamily | undefined {
  if (!modelValue) return undefined;
  const name = findModel(models, modelValue)?.displayName ?? modelValue;
  return MODEL_FAMILIES.find((family) => name.toLowerCase().includes(family));
}

/**
 * The custom properties `.card-glow-running`/`.modal-glow-running` read,
 * recomputed for one family's tone — the same `99`/`1f`/`59`/`66`/`8c`/`40`
 * alpha suffixes `index.css` already builds the plain running glow from,
 * applied to that family's hue instead of the default's.
 */
export interface RunningTint {
  '--color-activity-running-border': string;
  '--color-activity-running-fill': string;
  '--shadow-card-glow-running': string;
  '--shadow-modal-bloom-running': string;
}

// Each family's base hex is also `--color-model-<family>` in index.css: the
// running glow's own #00a6f4, hue-rotated a small step per family and nothing
// else. Sonnet's hex is #00a6f4 itself — the same running blue, unrotated —
// so a Sonnet-tagged card renders exactly as the plain running glow always
// has.
function variant(hex: string): RunningTint {
  return {
    '--color-activity-running-border': `${hex}99`,
    '--color-activity-running-fill': `${hex}1f`,
    '--shadow-card-glow-running': `inset 0 0 18px 0 ${hex}59, inset 0 0 4px 0 ${hex}66, 0 0 18px -8px ${hex}8c`,
    '--shadow-modal-bloom-running': `0 0 60px -20px ${hex}40`,
  };
}

const HEX: Record<ModelFamily, string> = {
  haiku: '#00e3f4',
  sonnet: '#00a6f4',
  opus: '#0069f4',
  fable: '#0040f4',
};

export const MODEL_TINT: Record<ModelFamily, RunningTint> = {
  haiku: variant(HEX.haiku),
  sonnet: variant(HEX.sonnet),
  opus: variant(HEX.opus),
  fable: variant(HEX.fable),
};

/** The plain CSS colour a family's toggle segment or swatch wears — `HEX` itself. */
export function modelFamilyColor(family: ModelFamily): string {
  return HEX[family];
}
