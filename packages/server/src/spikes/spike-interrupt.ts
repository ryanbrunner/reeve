import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'reeve-spike-'));
const sessionId = crypto.randomUUID();
const MODEL = 'claude-sonnet-5';

/** interrupt() only works with streaming input, so even one message is a generator. */
async function* once(text: string): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } };
}

function toolUses(msg: unknown): string[] {
  const m = msg as { message?: { content?: Array<{ type?: string; name?: string }> } };
  return (m.message?.content ?? []).filter((b) => b.type === 'tool_use').map((b) => b.name ?? '?');
}

let cost = 0;
const note = (label: string, v: string) => console.log(`${label.padEnd(18)}: ${v}`);

// ---------- Phase 1: start work, interrupt partway ----------
console.log('\n--- phase 1: interrupt a running turn ---');
const q1 = query({
  prompt: once(
    'Create files step-1.txt through step-6.txt in the current directory, one at a time, ' +
      'each containing its number spelled out. Write them one at a time.',
  ),
  options: {
    cwd: dir, sessionId, model: MODEL,
    permissionMode: 'acceptEdits', permissionPrompts: 'none',
    allowedTools: ['Write', 'Read'], maxBudgetUsd: 1.0,
  },
});

let writes = 0, interrupted = false, unknownKinds = 0;
for await (const m of q1) {
  if (m.type === 'assistant') {
    const uses = toolUses(m);
    writes += uses.filter((u) => u === 'Write').length;
    if (writes >= 2 && !interrupted) {
      interrupted = true;
      note('interrupting', `after ${writes} Write calls`);
      void q1.interrupt().catch((e: unknown) => note("interrupt raced", String(e).slice(0, 48)));
    }
  } else if (m.type === 'result') {
    cost += (m as { total_cost_usd?: number }).total_cost_usd ?? 0;
    note('phase 1 result', `subtype=${m.subtype} reason=${(m as { terminal_reason?: string }).terminal_reason ?? '-'}`);
  } else if (!['system', 'user', 'stream_event'].includes(m.type)) {
    unknownKinds++;
  }
}
const filesAfter = readdirSync(dir).sort();
note('files on disk', filesAfter.join(', ') || '(none)');
note('session id', `${sessionId.slice(0, 8)} (supplied by us, not scraped)`);

// ---------- Phase 2: resume the SAME session, check context survived ----------
console.log('\n--- phase 2: resume the interrupted session ---');
let answer = '';
for await (const m of query({
  prompt: once('Do not create any more files. Which step-N.txt files did you already create? Reply with just the filenames.'),
  options: { cwd: dir, resume: sessionId, model: MODEL, permissionMode: 'plan', permissionPrompts: 'none', maxBudgetUsd: 0.5 },
})) {
  if (m.type === 'result') {
    cost += (m as { total_cost_usd?: number }).total_cost_usd ?? 0;
    answer = (m as { result?: string }).result ?? '';
    note('resume_reason', (m as { resume_reason?: string }).resume_reason ?? '(none)');
  }
}
note('recalled', answer.replace(/\s+/g, ' ').slice(0, 160));

// ---------- Phase 3: fork — the revision path the design actually uses ----------
console.log('\n--- phase 3: fork for a revision ---');
const forkedId = crypto.randomUUID();
let forkOk = false;
for await (const m of query({
  prompt: once('Reviewer notes: stop at 3 files. Without writing anything, say how many files you would end up with.'),
  options: {
    cwd: dir, resume: sessionId, forkSession: true, sessionId: forkedId,
    model: MODEL, permissionMode: 'plan', permissionPrompts: 'none', maxBudgetUsd: 0.5,
  },
})) {
  if (m.type === 'result') {
    cost += (m as { total_cost_usd?: number }).total_cost_usd ?? 0;
    forkOk = (m as { session_id?: string }).session_id === forkedId;
    note('forked session', `${(m as { session_id?: string }).session_id?.slice(0, 8)} === ours? ${forkOk}`);
  }
}

console.log('\n--- verdict ---');
note('interrupt worked', String(interrupted && filesAfter.length > 0 && filesAfter.length < 6));
note('context survived', String(/step-1/.test(answer)));
note('fork got new id', String(forkOk && forkedId !== sessionId));
note('unhandled kinds', String(unknownKinds));
note('total cost', `$${cost.toFixed(4)}`);
