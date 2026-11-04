import { EFFORT_LEVELS, type ApiModel, type EffortLevel } from '@reeve/shared';
import type { DropdownOption } from './Dropdown.js';

/**
 * The model the CLI listed under this alias or full id, if it did. The same
 * match the server makes before a run.
 */
export function findModel(models: ApiModel[], model: string | null): ApiModel | undefined {
  return model ? models.find((m) => m.value === model || m.resolvedModel === model) : undefined;
}

/**
 * The effort levels worth offering beside `model`. Reads the CLI's answer the
 * way the server does: a model it did not list, or a capability it did not
 * report, is assumed to take every level. No model at all offers everything
 * too, though a caller that knows what an unpinned run would actually use —
 * see `unpinnedModel` — should resolve that first and pass it in instead.
 */
export function effortLevelsFor(models: ApiModel[], model: string | null): readonly EffortLevel[] {
  const m = findModel(models, model);
  if (!m) return EFFORT_LEVELS;
  if (m.supportsEffort === false) return [];
  return m.supportedEffortLevels ?? EFFORT_LEVELS;
}

/**
 * What a run with no model pinned anywhere actually gets: the CLI lists it
 * among `supportedModels()` as the row whose `value` is literally `'default'`
 * ("Default (recommended)"), resolving the same way `model: null` would. Null
 * only if the CLI could not be asked at all.
 */
export function unpinnedModel(models: ApiModel[]): string | null {
  return models.find((m) => m.value === 'default')?.resolvedModel ?? null;
}

/**
 * The choices for a model select, by display name. A stored model the CLI
 * did not list — it could not be asked, or has retired the id — is kept as a
 * choice of its own, or the select would show one model while holding another.
 *
 * Every run asks for auto mode, and a model whose capabilities did not report
 * `supportsAutoMode: true` runs without it instead, in its own default mode —
 * where every edit and most commands are put to the person, as Claude Code's
 * default mode prompts for them (see `fitToModel` in
 * `packages/server/src/runs/claude.ts`). Such a model works only with someone
 * there to click, and not at all under VIBES MODE, so it is marked rather than
 * hidden. A model a stored choice could not be matched to is left unmarked —
 * nothing is known about it either way.
 */
export function modelOptions(models: ApiModel[], current: string | null): DropdownOption[] {
  const options: DropdownOption[] = models.map((m) => ({
    value: m.value,
    label: m.displayName,
    warn: m.supportsAutoMode === true ? undefined : 'asks to edit',
  }));
  if (current && !findModel(models, current)) options.push({ value: current, label: current });
  return options;
}

/** The four families the header's toggle gives their own segment, in the order it shows them. */
export const MODEL_FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

const FAMILY_NAME: Record<ModelFamily, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };

/**
 * The latest model in each family, for the header's four-segment toggle: the
 * CLI lists its aliases — the ones a card would actually run with — ahead of
 * the pinned ids they resolve to, so the first `displayName` to start with a
 * family's name is that family's current one.
 */
export function modelFamilies(models: ApiModel[]): Partial<Record<ModelFamily, ApiModel>> {
  const picked: Partial<Record<ModelFamily, ApiModel>> = {};
  for (const family of MODEL_FAMILIES) {
    picked[family] = models.find((m) => m.displayName.toLowerCase().startsWith(FAMILY_NAME[family].toLowerCase()));
  }
  return picked;
}

/**
 * The overflow dropdown's own value for "Back to Settings' own choice" —
 * `onChange` reads it back to `null`. Never `''`, which the dropdown already
 * gives its placeholder, so picking this row is never confused with picking
 * nothing. What shows selected afterward is whatever that resolves to, same
 * as before picking it — see `ModelEffort`, which never feeds this value
 * itself back into the trigger.
 */
export const OVERFLOW_DEFAULT = '\u0000default';

/**
 * Everything the toggle's four segments did not pick, for the overflow chip
 * beside them: every other model the CLI lists, a stored model it no longer
 * does, and "Settings default" — the toggle has no segment for leaving the
 * choice to Settings, so that lives here instead.
 */
export function overflowModelOptions(models: ApiModel[], current: string | null): DropdownOption[] {
  const picked = new Set(Object.values(modelFamilies(models)).map((m) => m?.value));
  const rest = models.filter((m) => !picked.has(m.value));
  const options: DropdownOption[] = [
    { value: OVERFLOW_DEFAULT, label: 'Settings default' },
    ...rest.map((m) => ({ value: m.value, label: m.displayName, warn: m.supportsAutoMode === true ? undefined : 'asks to edit' })),
  ];
  if (current && !findModel(models, current) && !picked.has(current)) options.push({ value: current, label: current });
  return options;
}

/**
 * What to keep of an effort when the model beside it changes: itself, if the
 * new model takes it, or nothing — so the form never holds a pair the run
 * would have to quietly correct.
 */
export function keepEffort(models: ApiModel[], model: string | null, effort: EffortLevel | null): EffortLevel | null {
  return effort && effortLevelsFor(models, model).includes(effort) ? effort : null;
}
