import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'reeve-stop-'));
const sessionId = crypto.randomUUID();
const note = (l: string, v: string) => console.log(`${l.padEnd(18)}: ${v}`);

async function* once(text: string): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } };
}

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const q = query({
  prompt: once(
    'Using the Bash tool, run exactly these three commands ONE AT A TIME, waiting for each to finish ' +
      'before starting the next: `sleep 25 && echo one`, then `sleep 25 && echo two`, then `sleep 25 && echo three`. ' +
      'Do not run them in parallel or in the background. Say which finished after each.',
  ),
  options: {
    cwd: dir, sessionId, model: 'claude-sonnet-5',
    permissionMode: 'acceptEdits', permissionPrompts: 'none',
    allowedTools: ['Bash'], maxBudgetUsd: 1.0,
  },
});

// Fire from outside the consuming loop — exactly how an HTTP Stop handler would.
const stopAt = 12_000;
setTimeout(() => {
  note('stop fired', `at ${el()} (from outside the loop)`);
  void q.interrupt()
    .then(() => note('interrupt()', `resolved at ${el()}`))
    .catch((e: unknown) => note('interrupt()', `rejected: ${String(e).slice(0, 44)}`));
}, stopAt);

let bashCalls = 0;
let resultLine = '';
for await (const m of q) {
  if (m.type === 'assistant') {
    const blocks = (m as { message?: { content?: Array<{ type?: string; name?: string }> } }).message?.content ?? [];
    for (const b of blocks) if (b.type === 'tool_use' && b.name === 'Bash') note('bash call', `#${++bashCalls} at ${el()}`);
  } else if (m.type === 'result') {
    const r = m as { subtype?: string; terminal_reason?: string; total_cost_usd?: number; num_turns?: number };
    resultLine = `subtype=${r.subtype} terminal_reason=${r.terminal_reason ?? '-'} turns=${r.num_turns} cost=$${(r.total_cost_usd ?? 0).toFixed(4)}`;
  }
}
note('loop ended', el());
note('result', resultLine);

// Does the interrupted session still resume?
let recalled = '';
for await (const m of query({
  prompt: once('Do not run any commands. Which of the three sleep commands did you actually finish? One short sentence.'),
  options: { cwd: dir, resume: sessionId, model: 'claude-sonnet-5', permissionMode: 'plan', permissionPrompts: 'none', maxBudgetUsd: 0.5 },
})) {
  if (m.type === 'result') {
    recalled = ((m as { result?: string }).result ?? '').replace(/\s+/g, ' ').slice(0, 150);
    note('resume_reason', (m as { resume_reason?: string }).resume_reason ?? '(none)');
  }
}

console.log('\n--- verdict ---');
note('stopped early', String(bashCalls < 3 && Date.now() - t0 < 70_000));
note('bash calls made', `${bashCalls} of 3`);
note('resumable after', recalled ? 'yes' : 'no');
note('recalled', recalled);
