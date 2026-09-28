import { query, type AccountInfo, type ModelInfo, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
 * Asks the CLI something it answers from the initialize handshake.
 *
 * The query is opened with a prompt that never yields — no turn is taken and
 * nothing is spent — and closed as soon as the answer is in. It says nothing
 * itself, because `reeve doctor --json` asks through here and owns its stdout.
 */
async function askIdle<T>(ask: (q: Query) => Promise<T>, env?: NodeJS.ProcessEnv): Promise<T> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  async function* idle(): AsyncIterable<SDKUserMessage> {
    await held;
  }

  const q = query({ prompt: idle(), options: { cwd: config.root, permissionPrompts: 'none', ...(env ? { env } : {}) } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${DISCOVERY_TIMEOUT_MS / 1000}s`)), DISCOVERY_TIMEOUT_MS);
    });
    return await Promise.race([ask(q), timeout]);
  } finally {
    clearTimeout(timer);
    q.close();
    release();
  }
}

/** Asks the CLI which models it offers, and what each one accepts. */
async function discover(): Promise<ApiModel[]> {
  return (await askIdle((q) => q.supportedModels())).map(toApiModel);
}

export interface ProbeResult {
  ok: boolean;
  /** What was found, or what went wrong, as a sentence. */
  detail: string;
}

/**
 * Whether the CLI has credentials a run could use, as `reeve doctor` reports
 * it. Asked of the CLI rather than read from `~/.claude`, because where a login
 * is kept differs by platform — the macOS keychain, for one — and the CLI's
 * answer is the one a run will get.
 *
 * What `accountInfo()` answered when this was written, and so what the rule
 * below is shaped by:
 *
 *   logged in       { email, organization, subscriptionType, apiProvider: 'firstParty' }
 *   logged out      { tokenSource: 'none', apiProvider: 'firstParty' }
 *   only a key      { tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }
 *
 * A login carries no `tokenSource` at all, so its absence is not a failure:
 * an email is what says someone is logged in. A key is reported as found and
 * never tried, because trying it would spend credit. `env` is only for the
 * spike, which asks as someone who is logged out.
 */
export async function accountProbe(env?: NodeJS.ProcessEnv): Promise<ProbeResult> {
  let info: AccountInfo;
  try {
    info = await askIdle((q) => q.accountInfo(), env);
  } catch (err) {
    return { ok: false, detail: `the Claude CLI could not be asked: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Bedrock, Vertex and the rest authenticate outside the CLI, with their own
  // credentials, which only a run would find out about.
  if (info.apiProvider && info.apiProvider !== 'firstParty') {
    return { ok: true, detail: `set up for ${info.apiProvider}, whose credentials are checked when a run starts` };
  }
  const present = (s: string | undefined) => !!s && s !== 'none';
  if (info.email || present(info.tokenSource)) {
    const who = [info.email, info.subscriptionType].filter(Boolean).join(', ');
    return { ok: true, detail: `a Claude login${who ? ` (${who})` : ` (${info.tokenSource})`}` };
  }
  if (present(info.apiKeySource)) {
    return { ok: true, detail: `an API key from ${info.apiKeySource}, found but not tried` };
  }
  return { ok: false, detail: 'no Claude login and no ANTHROPIC_API_KEY' };
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
