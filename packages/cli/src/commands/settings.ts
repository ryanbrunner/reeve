import { parseArgs } from 'node:util';
import {
  EFFORT_LEVELS,
  isRunnable,
  RUNNABLE_STAGES,
  STAGE_LABELS,
  type ApiSettings,
  type EffortLevel,
  type ModelsResponse,
  type RunnableStage,
  type StageRunDefaults,
  type UpdateSettingsBody,
} from '@reeve/shared';
import { api } from '../client.js';
import { formatTime, note, parseCount, parseOrUsage, print, printJson, usageError } from '../output.js';
import { parseStage } from '../resolve.js';

/**
 * `reeve settings`: what the Settings screen shows and saves. VIBE MODE is
 * in there on the wire, but not here — see ./vibe.ts for why.
 */

const KEYS = 'max-concurrent-runs, or <stage>.model or <stage>.effort for planning, in-progress or testing';

type Key = { kind: 'maxConcurrentRuns' } | { kind: 'stage'; stage: RunnableStage; field: 'model' | 'effort' };

/** `max-concurrent-runs` and `maxConcurrentRuns` alike; `in-progress.model` and `In Progress.model` alike. */
function parseKey(input: string): Key {
  const kebab = (s: string) => s.trim().replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace(/[\s_]+/g, '-');
  if (kebab(input) === 'max-concurrent-runs') return { kind: 'maxConcurrentRuns' };
  if (kebab(input) === 'vibe' || kebab(input) === 'vibe-mode') {
    throw usageError('VIBE MODE is not a setting to set in passing. Use `reeve vibe on` or `reeve vibe off`');
  }
  const dot = input.lastIndexOf('.');
  const stage = dot > 0 ? parseStage(input.slice(0, dot)) : null;
  const field = kebab(input.slice(dot + 1));
  if (stage && isRunnable(stage) && (field === 'model' || field === 'effort')) return { kind: 'stage', stage, field };
  if (stage && !isRunnable(stage)) throw usageError(`${STAGE_LABELS[stage]} runs no Claude, so it has no model or effort`);
  throw usageError(`'${input}' is not a setting. Settings: ${KEYS}`);
}

function requireEffort(value: string): EffortLevel {
  const effort = EFFORT_LEVELS.find((e) => e === value.trim().toLowerCase());
  if (!effort) throw usageError(`'${value}' is not an effort. Efforts: ${EFFORT_LEVELS.join(', ')}`);
  return effort;
}

/**
 * The body that changes one key. A stage's model and effort are saved as a
 * pair — the server replaces the stage's whole entry — so the one not being
 * set is carried over from what is stored, or it would be wiped.
 */
function patchFor(key: Key, value: string | null, current: ApiSettings): UpdateSettingsBody {
  if (key.kind === 'maxConcurrentRuns') {
    if (value === null) throw usageError('max-concurrent-runs cannot be unset; set it to a number of runs');
    const n = parseCount('max-concurrent-runs', value);
    // A cap of zero refuses every run, which the server calls a switch rather than a limit.
    if (n < 1) throw usageError('max-concurrent-runs must be at least 1');
    return { maxConcurrentRuns: n };
  }
  const next = { ...current.stageDefaults[key.stage] };
  if (key.field === 'effort') next.effort = value === null ? null : requireEffort(value);
  else next.model = value;
  const stageDefaults: Partial<StageRunDefaults> = {};
  stageDefaults[key.stage] = next;
  return { stageDefaults };
}

/** A null falls through to what the stage's own module asks for, and that to Claude's own default. */
function layered(value: string | null, builtIn: string | null | undefined): string {
  if (value !== null) return value;
  return `${builtIn ?? "Claude's default"} (default)`;
}

function render(settings: ApiSettings, models: ModelsResponse | null): string {
  const rows: Array<[string, string]> = [
    ['Max concurrent runs', String(settings.maxConcurrentRuns)],
    ['VIBE MODE', settings.vibeSince === null ? 'off' : `ON since ${formatTime(settings.vibeSince)}`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  const stageWidth = Math.max(...RUNNABLE_STAGES.map((s) => STAGE_LABELS[s].length));
  const stages = RUNNABLE_STAGES.map((s) => {
    const own = settings.stageDefaults[s];
    const builtIn = models?.builtIn[s];
    const model = layered(own.model, builtIn?.model);
    const effort = layered(own.effort, builtIn?.effort);
    return `  ${STAGE_LABELS[s].padEnd(stageWidth)}  model ${model.padEnd(24)}  effort ${effort}`;
  });
  return [...rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`), '', 'Stage runs', ...stages].join('\n');
}

/** Says so, and carries on: the server stores any model name, since the list can be out of date or unreachable. */
function warnIfUnlisted(model: string, models: ModelsResponse): void {
  if (models.models.length === 0) return;
  if (models.models.some((m) => m.value === model || m.resolvedModel === model)) return;
  note(`'${model}' is not one of the models the Claude CLI lists (see \`reeve models\`). Saving it anyway.`);
}

async function set(args: string[], unset: boolean): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  const [keyArg, ...rest] = positionals;
  const verb = unset ? 'unset' : 'set';
  if (keyArg === undefined) throw usageError(`settings ${verb} needs a setting. Settings: ${KEYS}`);
  if (unset && rest.length > 0) throw usageError('settings unset takes a setting and no value');
  const value = unset ? null : (rest[0]?.trim() ?? '');
  if (value === '' || rest.length > 1) {
    throw usageError(`settings set needs one value, as in: reeve settings set ${keyArg} <value>`);
  }

  const key = parseKey(keyArg);
  const current = await api.settings();
  const body = patchFor(key, value, current);
  if (key.kind === 'stage' && key.field === 'model' && value !== null) warnIfUnlisted(value, await api.models());

  const saved = await api.updateSettings(body);
  if (values.json) return printJson(saved);
  if (key.kind === 'maxConcurrentRuns') {
    return print(`Max concurrent runs: ${saved.maxConcurrentRuns}`);
  }
  const stored = saved.stageDefaults[key.stage][key.field];
  print(`${STAGE_LABELS[key.stage]} ${key.field}: ${stored ?? 'back to the default'}`);
}

export async function settings(args: string[]): Promise<void> {
  const [sub] = args;
  if (sub === 'set') return set(args.slice(1), false);
  if (sub === 'unset') return set(args.slice(1), true);

  const { values } = parseOrUsage(() => parseArgs({ args, options: { json: { type: 'boolean' } } }));
  // The built-in layer only makes the defaults readable, so a CLI that cannot
  // be asked costs the display a word, not the command its answer.
  const [current, models] = await Promise.all([api.settings(), api.models().catch(() => null)]);
  if (values.json) return printJson(current);
  print(render(current, models));
}

/** What `<stage>.model` can be set to, as the Claude CLI reports it. */
export async function models(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() => parseArgs({ args, options: { json: { type: 'boolean' } } }));
  const catalogue = await api.models();
  if (values.json) return printJson(catalogue);
  if (catalogue.models.length === 0) {
    note('The Claude CLI could not be asked for its models, offline or not logged in. Any model name can still be set.');
    return;
  }
  const width = Math.max(...catalogue.models.map((m) => m.value.length));
  print(
    catalogue.models
      .map((m) => {
        const efforts = m.supportsEffort === false ? 'no effort' : (m.supportedEffortLevels ?? EFFORT_LEVELS).join('/');
        return `${m.value.padEnd(width)}  ${m.displayName} — ${m.description} [${efforts}]`;
      })
      .join('\n'),
  );
}
