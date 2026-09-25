import { query, type ModelInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ApiModel } from '@reeve/shared';
import { config } from '../config.js';

/**
 * Long enough for a cold CLI start. A run with a pinned model waits on this
 * before it starts, so a CLI that never answers must not hold it for longer.
 */
const DISCOVERY_TIMEOUT_MS = 30_000;

let models: Promise<ApiModel[]> | null = null;

function toApiModel(m: ModelInfo): ApiModel {
  return {
    value: m.value,
    resolvedModel: m.resolvedModel ?? null,
    displayName: m.displayName,
    description: m.description,
    supportsEffort: m.supportsEffort,
    supportedEffortLevels: m.supportedEffortLevels,
    supportsAdaptiveThinking: m.supportsAdaptiveThinking,
  };
}

/**
 * Asks the CLI which models it offers, and what each one accepts.
 *
 * `supportedModels()` answers from the initialize handshake, so the query is
 * opened with a prompt that never yields — no turn is taken and nothing is
 * spent — and closed as soon as the answer is in.
 */
async function discover(): Promise<ApiModel[]> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  async function* idle(): AsyncIterable<SDKUserMessage> {
    await held;
  }

  const q = query({ prompt: idle(), options: { cwd: config.root, permissionPrompts: 'none' } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${DISCOVERY_TIMEOUT_MS / 1000}s`)), DISCOVERY_TIMEOUT_MS);
    });
    return (await Promise.race([q.supportedModels(), timeout])).map(toApiModel);
  } finally {
    clearTimeout(timer);
    q.close();
    release();
  }
}

/**
 * Every model the CLI offers. Asked once and kept; a failure — offline, not
 * logged in — answers `[]` and is asked again on the next call rather than
 * remembered, so a CLI that comes good later is noticed without a restart.
 */
export function listModels(): Promise<ApiModel[]> {
  models ??= discover().catch((err: unknown) => {
    console.log(`[reeve] could not list models: ${String(err)}`);
    models = null;
    return [];
  });
  return models;
}

/**
 * What the CLI says about `model`, matched on the alias or the full id it
 * resolves to. Undefined for a model the CLI did not list, which is sent
 * through untouched: an id stored before it was retired should still be tried.
 */
export async function capabilitiesFor(model: string): Promise<ApiModel | undefined> {
  return (await listModels()).find((m) => m.value === model || m.resolvedModel === model);
}
