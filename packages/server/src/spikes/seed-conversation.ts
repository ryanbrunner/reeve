/**
 * Seeds five cards whose stage is a conversation in each state the composer
 * and the thread render — waiting on a reply, parked on a permission, parked
 * on a question, working with a message just interjected, and a Release that
 * has written its pull request — so the card modal's conversation can be
 * looked at without spending API credit.
 *
 * Into a server that is ALREADY RUNNING on the same scratch database. Opening
 * it here does not reap, so the two live cards stay live; a server started
 * after this would reap them to interrupted on boot. Their asks have no run
 * process behind them, so the buttons answer 409 — this is for looking.
 *
 *   REEVE_DB=/tmp/conv-ui.db REEVE_PORT=4411 npm start            # one shell
 *   REEVE_DB=/tmp/conv-ui.db npx tsx packages/server/src/spikes/seed-conversation.ts
 *
 * Then open http://127.0.0.1:4411 and click the cards in the "conversations" lane.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createCard, createRepo, insertEvents, insertRun, listRepos, moveCard, nextSeq } from '../db/queries.js';
import { eq } from 'drizzle-orm';
import { card as cardTable, type CardStage } from '../db/schema.js';
import { config } from '../config.js';

if (!process.env.REEVE_DB) throw new Error('give this the scratch REEVE_DB the running server uses');
const db = openDatabase(config.dbFile);
runMigrations(db);

const repo = listRepos(db).find((r) => r.name === 'conversations') ?? createRepo(db, {
  name: 'conversations',
  repoPath: mkdtempSync(join(tmpdir(), 'reeve-conv-ui-')),
  worktreeRoot: mkdtempSync(join(tmpdir(), 'reeve-conv-ui-wt-')),
  defaultBranch: 'main',
  laneColor: '#a78bfa',
});

const now = Date.now();
const ago = (mins: number) => new Date(now - mins * 60_000);
let toolN = 0;

const assistant = (...content: unknown[]) => ({ kind: 'assistant', payload: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content } } });
const text = (t: string) => ({ type: 'text', text: t });
const thinking = (t: string) => ({ type: 'thinking', thinking: t });
const use = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `toolu_seed_${++toolN}`, name, input });
const result = (id: string, content: string, isError = false) => ({
  kind: 'tool_result',
  payload: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } },
});
const user = (t: string, extra: Record<string, unknown> = {}) => ({ kind: 'user_message', payload: { text: t, actor: 'human', source: 'chat', at: now - 60_000, ...extra } });

function card(title: string, stage: CardStage, status: 'awaiting_reply' | 'asking' | 'running' | 'succeeded', events: Array<{ kind: string; payload: unknown }>, prompt: string, resultText: string | null = null, output: unknown = null) {
  const c = createCard(db, { repoId: repo.id, title, body: 'Seeded by seed-conversation.ts.', stage: 'backlog' });
  moveCard(db, c.id, stage, 0, 'human');
  const run = insertRun(db, {
    id: crypto.randomUUID(), cardId: c.id, kind: 'claude', stage, status,
    sessionId: crypto.randomUUID(), model: 'opus-5-5', effort: 'high', permissionMode: 'auto',
    prompt, cwd: repo.worktreeRoot, startedAt: ago(6), createdAt: ago(6),
    lastActivity: status === 'running' ? 'editing a file' : null,
    finishedAt: status === 'awaiting_reply' || status === 'succeeded' ? ago(2) : null,
    stopReason: status === 'awaiting_reply' || status === 'succeeded' ? 'completed' : null,
    resultText,
    structuredOutput: output,
  });
  const first = nextSeq(db, run.id);
  insertEvents(db, events.map((e, i) => ({
    runId: run.id, seq: first + i, kind: e.kind, sdkUuid: null, payload: JSON.stringify(e.payload), at: new Date(now - (events.length - i) * 20_000),
  })));
  return c;
}

const PROMPT = 'You are planning a single piece of work in the repository…\n\n(the whole stage prompt, collapsed by default)';

// 1. Waiting on a reply: Claude asked in plain text and ended its turn.
{
  const read = use('Read', { file_path: 'packages/server/src/search.ts' });
  const grep = use('Grep', { pattern: 'fts5', path: 'packages/server' });
  card('Search across every card\'s conversations', 'planning', 'awaiting_reply', [
    assistant(thinking('There is no search today. SQLite has FTS5; run_event payloads are JSON, so I would index projected text, not raw payloads.')),
    assistant(read, grep),
    result(read.id, '1  // nothing here yet\n'),
    result(grep.id, 'No matches'),
    assistant(text('I can index what you and I wrote, or everything including tool output. Tool output makes the index about ten times larger and most hits would be file contents.\n\n**Should search include tool output, or only what you and I wrote?**')),
  ], PROMPT, 'I can index what you and I wrote, or everything including tool output.\n\n**Should search include tool output, or only what you and I wrote?**');
}

// 2. Parked on a permission: auto mode escalated a command.
{
  const ls = use('Bash', { command: 'ls ~/.reeve/cache', description: 'See what is cached' });
  const rm = use('Bash', { command: 'rm -rf ~/.reeve/cache', description: 'Clear the stale model cache before rebuilding it' });
  const c = card('Cache model listing between boots', 'in_progress', 'asking', [
    user('Make sure an upgrade does not keep a stale model list.'),
    assistant(text('The cache lives outside the worktree. I will clear it once so the new format is written fresh.')),
    assistant(ls),
    result(ls.id, 'models.json\nmodels.json.bak'),
    assistant(rm),
    { kind: 'ask', payload: { id: 'seed-ask-permission', kind: 'permission', toolName: 'Bash', input: rm.input, runId: '', cardId: '', createdAt: now, toolUseId: rm.id } },
  ], PROMPT);
  void c;
}

// 3. Parked on a question: AskUserQuestion.
card('Pick a default for new cards\' model', 'in_progress', 'asking', [
  assistant(text('Two reasonable defaults here, and it is a product call.')),
  { kind: 'ask', payload: {
    id: 'seed-ask-question', kind: 'question', runId: '', cardId: '', createdAt: now,
    questions: [{ question: 'Which model should a new card default to?', header: 'Model', options: [
      { label: 'The CLI default', description: 'Whatever Claude Code picks' },
      { label: 'Opus', description: 'Best results, slower' },
      { label: 'Sonnet', description: 'Faster and cheaper' },
    ] }],
  } },
], PROMPT);

// 4. Working, with a message interjected while it worked.
{
  const edit = use('Edit', { file_path: 'packages/web/src/card/conversation/Composer.tsx', old_string: 'a', new_string: 'b' });
  const tc = use('Bash', { command: 'npm run typecheck', description: 'Typecheck' });
  const edit2 = use('Edit', { file_path: 'packages/web/src/card/AttentionBand.tsx', old_string: 'c', new_string: 'd' });
  card('Make each stage a conversation with Claude', 'in_progress', 'running', [
    assistant(text('Starting with the run loop, since everything else depends on it.')),
    assistant(edit, tc),
    result(edit.id, 'The file has been updated.'),
    result(tc.id, "packages/web/src/card/AttentionBand.tsx(298,7): error TS2322: Type '\"awaiting_reply\"' is not assignable…", true),
    user("Don't patch AttentionBand — the composer replaces it.", { live: true }),
    assistant(text('Got it — I will fold its states into the composer instead.')),
    assistant(edit2),
  ], PROMPT);
}

// 5. Release, with the pull request written and waiting to be merged.
{
  const log = use('Bash', { command: 'git log main..HEAD --oneline', description: 'The branch’s commits' });
  const fin = use('Bash', { command: 'npm run typecheck && npm test', description: 'The repo’s finish command' });
  const submit = use('mcp__reeve__submit_release', { pr_title: 'Rename Done to Release' });
  const output = {
    summary: 'Renames the last column and makes it a conversation; finish command passes.',
    pr_title: 'Rename Done to Release',
    pr_body: 'The last column is now **Release**: a stage where Claude prepares the pull request with the person.\n\n- `0026_rename_done_to_release` renames the stage in every table\n- `done` still works as a stage name in the CLI and the move route\n\nVerified with the finish command and the release spike.',
    release_notes: 'The last column is now Release. Claude writes the pull request and its notes there; you merge when you are happy.',
    finish: { ran: true, passed: true, notes: 'typecheck and the CLI tests pass.' },
    ready: true,
    concerns: ['The migration renames rows in place; a board on an older Reeve would not read them.'],
    suggested_tasks: [],
  };
  const c = card('Rename Done to Release', 'release', 'succeeded', [
    assistant(text('Reading the branch the way a reviewer would.')),
    assistant(log, fin),
    result(log.id, 'a41e2c9 Rename the stage\n7b0d11f Add the Release stage'),
    result(fin.id, '✓ 4 workspaces typecheck\n✓ cli: 19 tests passed'),
    assistant(text('The finish command passes. I have written the description and release notes.'), submit),
    result(submit.id, 'Recorded. Reeve writes the documents from this.'),
    { kind: 'submitted', payload: { tool: 'submit_release', summary: 'Ready to merge. Renames the last column and makes it a conversation; finish command passes.' } },
  ], PROMPT, null, output);
  db.update(cardTable).set({ prUrl: 'https://github.com/example/reeve/pull/151', prNumber: 151, prOpenedAt: ago(5) }).where(eq(cardTable.id, c.id)).run();
}

console.log(`seeded 5 conversation cards into ${config.dbFile}`);
