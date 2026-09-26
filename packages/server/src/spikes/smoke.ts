import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '../db/client.js';
import { boardCards, eventsSince, insertEvents, insertRun, nextSeq, reapOrphanedRuns } from '../db/queries.js';
import { card, repo } from '../db/schema.js';

const db = openDatabase(process.env.REEVE_DB ?? '../../data/reeve.db');
migrate(db, { migrationsFolder: './drizzle' });

db.insert(repo).values({
  id: 'p1', name: 'reeve', repoPath: '/Users/ryan/code/reeve',
  worktreeRoot: '/Users/ryan/code/.reeve-worktrees', setupCommand: 'npm install',
  serverCommand: 'npm run dev', teardownCommand: 'rm -rf node_modules', laneColor: '#6b7db3',
  allowedTools: ['Read', 'Edit', 'Bash(git *)'],
}).onConflictDoNothing().run();

db.insert(card).values({
  id: 'c1', repoId: 'p1', title: 'Wire the Planning stage',
  body: 'First stage end to end.', stage: 'planning', position: 1000,
}).onConflictDoNothing().run();

const sessionId = crypto.randomUUID();
const created = insertRun(db, {
  id: 'r1', cardId: 'c1', kind: 'claude', stage: 'planning', status: 'running',
  sessionId, model: 'claude-opus-5', effort: 'high', permissionMode: 'plan', cwd: '/tmp/worktree', startedAt: new Date(),
});
console.log('run inserted   :', created.id, created.status, created.sessionId === sessionId ? '(session id round-tripped)' : '(MISMATCH)');

const seq = nextSeq(db, 'r1');
insertEvents(db, [
  { runId: 'r1', seq, kind: 'system:init', payload: JSON.stringify({ type: 'system', subtype: 'init' }) },
  { runId: 'r1', seq: seq + 1, kind: 'assistant', payload: JSON.stringify({ type: 'assistant' }) },
  // An unknown message type must persist, not throw.
  { runId: 'r1', seq: seq + 2, kind: 'unknown:some_future_type', payload: JSON.stringify({ type: 'some_future_type' }) },
]);

const replay = eventsSince(db, 'r1', 0);
console.log('events replayed:', replay.length, '->', replay.map((e) => e.kind).join(', '));
console.log('resume from 1  :', eventsSince(db, 'r1', 1).map((e) => e.seq).join(', '), '(Last-Event-ID semantics)');

const board = boardCards(db);
console.log('board row      :', board[0]?.card.title, '| repo:', board[0]?.repoName, '| lane:', board[0]?.laneColor);
console.log('json column    :', JSON.stringify(db.select().from(repo).get()?.allowedTools));

const reaped = reapOrphanedRuns(db, new Date());
console.log('reaper         :', reaped.length, 'orphan(s) ->', reaped.map((r) => `${r.id}:${r.sessionId?.slice(0, 8)}`).join(', '), '(resumable)');
