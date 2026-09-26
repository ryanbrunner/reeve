import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'reeve-abort-'));
const sessionId = crypto.randomUUID();
const note = (l: string, v: string) => console.log(`${l.padEnd(17)}: ${v}`);
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function* once(text: string): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } };
}

const ac = new AbortController();
const q = query({
  prompt: once('Run this single Bash command and wait for it: `sleep 90 && echo done`. Report the output when it finishes.'),
  options: {
    cwd: dir, sessionId, model: 'claude-sonnet-5', abortController: ac,
    permissionMode: 'acceptEdits', permissionPrompts: 'none',
    allowedTools: ['Bash'],
  },
});

setTimeout(() => { note('abort() fired', el()); ac.abort(); }, 10_000);

let sawBash = false, ended = 'normally', result = '';
try {
  for await (const m of q) {
    if (m.type === 'assistant') {
      const blocks = (m as { message?: { content?: Array<{ type?: string; name?: string }> } }).message?.content ?? [];
      if (blocks.some((b) => b.type === 'tool_use') && !sawBash) { sawBash = true; note('bash started', el()); }
    } else if (m.type === 'result') {
      const r = m as { subtype?: string; terminal_reason?: string; total_cost_usd?: number };
      result = `subtype=${r.subtype} terminal_reason=${r.terminal_reason ?? '-'} cost=$${(r.total_cost_usd ?? 0).toFixed(4)}`;
    }
  }
} catch (e) {
  ended = `threw: ${String(e).slice(0, 60)}`;
}
note('loop ended', `${el()} (${ended})`);
if (result) note('result msg', result);

// The decisive question: is an aborted session still resumable?
let recalled = '';
try {
  for await (const m of query({
    prompt: once('Do not run commands. In one short sentence: did your sleep command finish?'),
    options: { cwd: dir, resume: sessionId, model: 'claude-sonnet-5', permissionMode: 'plan', permissionPrompts: 'none',},
  })) {
    if (m.type === 'result') recalled = ((m as { result?: string }).result ?? '').replace(/\s+/g, ' ').slice(0, 130);
  }
} catch (e) { recalled = `RESUME FAILED: ${String(e).slice(0, 70)}`; }

console.log('\n--- verdict ---');
note('aborted early', String(Date.now() - t0 < 60_000));
note('resumable', String(!!recalled && !recalled.startsWith('RESUME FAILED')));
note('recalled', recalled);
