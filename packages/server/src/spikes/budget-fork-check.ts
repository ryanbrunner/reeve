/**
 * Throwaway check on what a forked session's `maxBudgetUsd` is measured
 * against: its own spend, or the whole conversation's, parent included. Every
 * reply to a stage forks its session, so a long conversation could otherwise
 * find each new turn refused before it starts.
 *
 * Standalone, real credit (Sonnet, a few cents):
 *
 *   npx tsx packages/server/src/spikes/budget-fork-check.ts
 */
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'reeve-budget-'));
const sessionId = crypto.randomUUID();

async function once(prompt: string, extra: Record<string, unknown>) {
  let last: Extract<SDKMessage, { type: 'result' }> | null = null;
  for await (const m of query({ prompt, options: { cwd: dir, model: 'sonnet', permissionMode: 'auto', ...extra } })) {
    if (m.type === 'result') last = m;
  }
  return last;
}

const first = await once('Write three short paragraphs about lighthouses. No tools.', { sessionId, maxBudgetUsd: 1 });
const parentCost = first?.total_cost_usd ?? 0;
console.log(`parent: ${first?.subtype} $${parentCost.toFixed(4)}`);

// A budget above this turn's own likely cost but below the parent's.
const budget = Math.max(parentCost / 2, 0.005);
const fork = await once('Say "ok". No tools.', { resume: sessionId, forkSession: true, sessionId: crypto.randomUUID(), maxBudgetUsd: budget });
console.log(`fork with maxBudgetUsd=$${budget.toFixed(4)}: ${fork?.subtype} total=$${(fork?.total_cost_usd ?? 0).toFixed(4)} result=${JSON.stringify((fork as { result?: string } | null)?.result ?? '').slice(0, 60)}`);
console.log(fork?.subtype === 'error_max_budget_usd' ? 'CUMULATIVE: a fork is measured against the whole conversation' : 'OWN: a fork is measured against its own spend');
