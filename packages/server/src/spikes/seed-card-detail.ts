/**
 * Seeds one card in each activity state, carrying every surface the detail
 * modal renders: a brief, criteria with verdicts, questions half answered, a
 * plan with steps, an implementation with commits, checks, a mockup beside the
 * screenshot of it, and a full timeline.
 *
 * The point is to be able to drive the whole modal without spending a penny of
 * API credit. Run it, open the board, click the cards.
 *
 *   REEVE_DB=data/reeve.db npx tsx packages/server/src/spikes/seed-card-detail.ts
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relativeAssetPath, writeAsset } from '../assets/store.js';
import { captureTargets } from '../capture/screenshot.js';
import { createApp } from '../index.js';
import {
  addCriterion,
  addRef,
  createCard,
  createRepo,
  insertAsset,
  insertCardEvent,
  insertRun,
  listRepos,
  moveCard,
  recordVerdicts,
  replaceDifferences,
  replaceQuestions,
  setRunStatus,
} from '../db/queries.js';
import type { CardStage } from '../db/schema.js';

const BEFORE = `import { db } from '../db'

export async function orderSummary(cartId: string) {
  const lines = await db.cartItems.findMany({
    where: { cartId },
  })
  const subtotal = lines.reduce(
    (total, line) => total + line.price * line.quantity,
    0)
  return { lines, subtotal, tax: await taxFor(lines) }
}
`;

const AFTER = `import { db } from '../db'
import { billableLines, sum } from './cart/billableLines'

export async function orderSummary(cartId: string) {
  const lines = await billableLines(cartId)
  const subtotal = sum(lines)
  return { lines, subtotal, tax: await taxFor(lines) }
}
`;

const BILLABLE = `import { db } from '../db'

/** Every cart line that should be charged for: saved items are not. */
export async function billableLines(cartId: string) {
  return db.cartItems.findMany({
    where: { cartId, savedForLater: false },
  })
}

export const sum = (lines: Array<{ price: number; quantity: number }>) =>
  lines.reduce((total, line) => total + line.price * line.quantity, 0)
`;

const SAVED_LIST = `export function SavedList({ items }: { items: CartLine[] }) {
  if (items.length === 0) return null
  return (
    <section>
      <h2>Saved for later ({items.length})</h2>
      {items.map((item) => (
        <SavedRow key={item.id} item={item} />
      ))}
    </section>
  )
}
`;

const { db } = createApp();

const storefront =
  listRepos(db).find((p) => p.name === 'storefront') ??
  createRepo(db, {
    name: 'storefront',
    repoPath: '/tmp/reeve-seed-storefront',
    worktreeRoot: '/tmp/reeve-seed-worktrees',
    defaultBranch: 'main',
    setupCommand: 'npm install',
    testCommand: 'npm test',
    serverCommand: 'npm run dev',
    teardownCommand: null,
    finishCommand: null,
    laneColor: '#6b7db3',
  });

const ago = (mins: number) => new Date(Date.now() - mins * 60_000);

/**
 * A real git repo, and a real worktree per card with real changes in it.
 *
 * Faked paths would leave the Diff tab and the Commits rail showing their
 * empty states, which are the two surfaces most worth looking at — and a diff
 * viewer is not verified by a diff nobody produced.
 */
const repo = mkdtempSync(join(tmpdir(), 'reeve-seed-'));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=seed@reeve', '-c', 'user.name=Seed', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

mkdirSync(join(repo, 'src/cart'), { recursive: true });
writeFileSync(join(repo, 'src/checkout-summary.ts'), BEFORE);
writeFileSync(join(repo, 'README.md'), '# storefront\n\nSeeded by reeve.\n');
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'Initial commit');
const baseSha = git(repo, 'rev-parse', 'HEAD');
db.run(`UPDATE repo SET repo_path='${repo}', worktree_root='${repo}/../worktrees' WHERE id='${storefront.id}'` as never);

/** A worktree for a card, with the change the seeded plan describes. */
function worktreeFor(cardId: string, number: number, slug: string, withChanges: boolean): string {
  const path = join(repo, '..', `reeve-seed-wt-${number}`);
  const branch = `reeve/${number}-${slug}`;
  // Re-running the seed is the normal case, and a worktree left by the last
  // run is not an error worth stopping for.
  rmSync(path, { recursive: true, force: true });
  git(repo, 'worktree', 'prune');
  git(repo, 'worktree', 'add', '-q', '-b', branch, path, baseSha);
  if (withChanges) {
    writeFileSync(join(path, 'src/checkout-summary.ts'), AFTER);
    mkdirSync(join(path, 'src/cart'), { recursive: true });
    writeFileSync(join(path, 'src/cart/billableLines.ts'), BILLABLE);
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'Keep saved lines out of totals');
    writeFileSync(join(path, 'src/cart/SavedList.tsx'), SAVED_LIST);
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'SavedList and Save for later action');
  }
  db.run(
    `UPDATE card SET branch_name='${branch}', worktree_path='${path}', base_sha='${baseSha}' WHERE id='${cardId}'` as never,
  );
  return path;
}

/** Where a seeded run's tokens went. Cache reads are there to prove they are left out of the count. */
type Tokens = { input: number; output: number; cacheWrite: number; cacheRead: number };

/** A run that already happened, with its cost, its tokens and its place in the timeline. */
function pastRun(opts: {
  cardId: string;
  stage: CardStage;
  status: 'succeeded' | 'failed' | 'running';
  output?: unknown;
  usd?: number;
  tokens?: Tokens;
  startedMinsAgo: number;
  ranMins: number;
  error?: string;
}) {
  const started = ago(opts.startedMinsAgo);
  const run = insertRun(db, {
    id: crypto.randomUUID(),
    cardId: opts.cardId,
    kind: 'claude',
    stage: opts.stage,
    status: 'running',
    sessionId: crypto.randomUUID(),
    cwd: '/tmp/x',
    createdAt: started,
    startedAt: started,
  });
  insertCardEvent(db, {
    cardId: opts.cardId, actor: 'claude', kind: 'run_started',
    stage: opts.stage, runId: run.id, createdAt: started,
  });
  if (opts.status === 'running') return run;

  const finished = ago(opts.startedMinsAgo - opts.ranMins);
  setRunStatus(db, run.id, {
    status: opts.status,
    stopReason: opts.status === 'succeeded' ? 'completed' : 'sdk_error',
    structuredOutput: opts.output ?? null,
    totalCostUsd: opts.usd ?? null,
    // The SDK's `modelUsage`, keyed by model, which is what the card reads its token count off.
    modelUsageJson: opts.tokens
      ? {
          'claude-opus-5-5': {
            inputTokens: opts.tokens.input,
            outputTokens: opts.tokens.output,
            cacheCreationInputTokens: opts.tokens.cacheWrite,
            cacheReadInputTokens: opts.tokens.cacheRead,
            webSearchRequests: 0,
            costUSD: opts.usd ?? 0,
          },
        }
      : null,
    errorMessage: opts.error ?? null,
    finishedAt: finished,
  });
  insertCardEvent(db, {
    cardId: opts.cardId, actor: 'claude', kind: 'run_finished',
    stage: opts.stage, runId: run.id, body: opts.error ?? null, createdAt: finished,
    meta: { status: opts.status, costUsd: opts.usd ?? null, durationMs: opts.ranMins * 60_000 },
  });
  return run;
}

function card(title: string, body: string, stage: CardStage, minsAgo: number) {
  // Ticked, as every card was before mockups became opt-in, so the ones
  // seeded with drawn mockups sit beside a box that asked for them.
  const c = createCard(db, { title, body, repoId: storefront.id, generateMockups: true });
  if (stage !== 'backlog') {
    for (const s of ['planning', 'in_progress', 'testing', 'done'] as CardStage[]) {
      moveCard(db, c.id, s, 0);
      if (s === stage) break;
    }
  }
  db.run(`UPDATE card SET created_at=${ago(minsAgo).getTime()} WHERE id='${c.id}'` as never);
  // moveCard stamps its events now, which for a card whose life we are
  // inventing puts every move above the runs they happened between. Spread
  // them back across the card's history instead.
  const moves = db
    .values(`SELECT id FROM card_event WHERE card_id = '${c.id}' ORDER BY rowid` as never) as Array<[string]>;
  moves.forEach(([id], i) => {
    db.run(`UPDATE card_event SET created_at=${ago(minsAgo - (i * minsAgo) / (moves.length + 1)).getTime()} WHERE id='${id}'` as never);
  });
  if (stage !== 'backlog') {
    worktreeFor(c.id, c.number, title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24), stage !== 'planning');
  }
  return { ...c, id: c.id };
}

const PLAN = {
  summary: 'A saved flag on cart lines instead of a separate wishlist model.',
  details: [
    {
      heading: 'Approach',
      body: 'Add a saved flag to cart lines rather than a separate wishlist, and route every total through one helper so saved items can never be charged. Guests get the same list in local storage.',
    },
    {
      heading: 'Risks',
      body: 'Checkout reads cart_items in two places. If either misses the filter, saved items get charged.',
    },
  ],
  steps: [
    { title: 'Store saved lines with the cart', detail: 'A saved_for_later flag on cart_items, not a wishlist model.', files: ['db/migrations/0042_saved_for_later.sql'], blocked_on_question: 2 },
    { title: 'Keep saved lines out of totals', detail: 'One billableLines() helper that checkout and tax both call.', files: ['src/api/cart.ts', 'src/checkout/summary.ts'], blocked_on_question: null },
    { title: 'Saved items for guests', detail: 'Mirror saved lines in localStorage.', files: ['src/cart/guestCart.ts'], blocked_on_question: 1 },
    { title: 'Saved for later list and actions', detail: 'SavedList under the cart lines, with Move to cart and Remove.', files: ['src/cart/CartPage.tsx', 'src/cart/SavedList.tsx'], blocked_on_question: null },
    { title: 'Tests', detail: 'Unit tests for totals; e2e for save, restore and persistence.', files: ['tests/cart.spec.ts'], blocked_on_question: null },
  ],
  open_questions: [
    { question: 'Guests keep saved items in this browser only. When a guest signs in, should their saved items move into the account?', suggestions: ['Merge them, dedupe by SKU', 'Discard the guest list', 'Ask the shopper'] },
    { question: 'Carts expire after 30 days today. Should saved items expire too, or stay until the shopper removes them?', suggestions: ['Keep them until removed', 'Expire with the cart after 30 days', 'Expire after 90 days'] },
  ],
  acceptance_criteria: [
    'Each cart line has Save for later, which takes it out of the subtotal',
    'Saved items show under the cart with Move to cart and Remove',
    'Signed-in shoppers keep saved items across sessions and devices',
    'Guests keep saved items in this browser',
    'Cart count and subtotal update without a page reload',
    'When nothing is saved, the saved list is hidden',
  ],
  captures: [{ label: 'Cart with saved items', path: '/cart', viewport: 1280 }],
  files_to_touch: ['src/api/cart.ts', 'src/cart/CartPage.tsx'],
  risk: 'medium' as const,
};

const IMPL = {
  summary: 'Followed the plan with one change: totals now come from a billableLines() helper, so checkout cannot miss the saved filter.',
  commits: ['Add saved_for_later to cart_items', 'Keep saved lines out of totals', 'SavedList and Save for later action', 'Merge guest saved items on sign-in'],
  // The three files worktreeFor actually writes, so Claude's claim and git's
  // truth agree here the way they would in a real run.
  files_changed: ['src/checkout-summary.ts', 'src/cart/billableLines.ts', 'src/cart/SavedList.tsx'],
  deviations_from_plan: ['Totals come from billableLines() rather than a filter at each call site, so checkout cannot miss it.'],
  suggested_tasks: [
    { title: 'Cover guest saved items with an e2e test', body: 'Only the signed-in path has one. Guests keep theirs in localStorage, which no test reaches.' },
  ],
};

// Sized so the board shows each shape the formatter has: "840", "1.4 k", and
// tens and hundreds of k. Cache writes carry most of it, as they do for real.
const ASKED: Tokens = { input: 12, output: 3_100, cacheWrite: 27_400, cacheRead: 184_000 };
const PLANNED: Tokens = { input: 20, output: 4_800, cacheWrite: 33_200, cacheRead: 212_000 };
const BUILT: Tokens = { input: 40, output: 21_600, cacheWrite: 190_400, cacheRead: 2_310_000 };
const TESTED: Tokens = { input: 30, output: 8_200, cacheWrite: 96_000, cacheRead: 880_000 };
const STALLED: Tokens = { input: 24, output: 1_380, cacheWrite: 0, cacheRead: 9_800 };
const BLIP: Tokens = { input: 24, output: 816, cacheWrite: 0, cacheRead: 0 };

// --- the cards ---------------------------------------------------------------

// 1. Backlog: a brief and nothing else.
const idle = card('Gift notes at checkout', 'Shoppers buying presents want to add a short message that prints on the packing slip.', 'backlog', 60 * 26);
addRef(db, idle.id, 'file', 'src/checkout/CheckoutPage.tsx');

// 2. Planning, waiting on answers.
const asking = card('Rate-limit the checkout API', 'Checkout is getting hammered by a scraper. Add per-IP limits without breaking real shoppers.', 'planning', 60 * 5);
const askRun = pastRun({ cardId: asking.id, stage: 'planning', status: 'succeeded', output: PLAN, usd: 0.018, tokens: ASKED, startedMinsAgo: 40, ranMins: 6 });
replaceQuestions(db, asking.id, askRun.id, 'planning', PLAN.open_questions);
for (const t of PLAN.acceptance_criteria.slice(0, 3)) addCriterion(db, asking.id, t, 'claude');

// 3. In Progress, Claude working right now.
const working = card('Email me when it’s back in stock', 'Let shoppers register interest in an out-of-stock variant and get one email when it returns.', 'in_progress', 60 * 9);
pastRun({ cardId: working.id, stage: 'planning', status: 'succeeded', output: PLAN, usd: 0.031, tokens: PLANNED, startedMinsAgo: 200, ranMins: 10 });
pastRun({ cardId: working.id, stage: 'in_progress', status: 'running', startedMinsAgo: 31, ranMins: 0 });
for (const t of PLAN.acceptance_criteria.slice(0, 4)) addCriterion(db, working.id, t, 'claude');

// 4. Testing, stopped on an error. The one that needs its server log read.
const broken = card('Fix tax rounding on refunds', 'Partial refunds are a cent out when the order had a discount.', 'testing', 60 * 30);
pastRun({ cardId: broken.id, stage: 'planning', status: 'succeeded', output: PLAN, usd: 0.031, tokens: PLANNED, startedMinsAgo: 300, ranMins: 9 });
pastRun({ cardId: broken.id, stage: 'in_progress', status: 'succeeded', output: IMPL, usd: 0.094, tokens: BUILT, startedMinsAgo: 240, ranMins: 39 });
// What that run's suggestion became, so the rail has both ends to show.
for (const t of IMPL.suggested_tasks) {
  createCard(db, { title: t.title, body: t.body, repoId: storefront.id, suggestedById: broken.id, actor: 'claude' });
}
pastRun({
  cardId: broken.id, stage: 'testing', status: 'failed', usd: 0.002, tokens: STALLED,
  startedMinsAgo: 14, ranMins: 0.2,
  error: 'Could not start the dev server: port 5174 is in use by the worktree for #3.',
});
const brokenServer = insertRun(db, {
  id: crypto.randomUUID(), cardId: broken.id, kind: 'server', stage: 'testing',
  status: 'running', cwd: '/tmp/x', port: 5174, createdAt: ago(14), startedAt: ago(14),
});
setRunStatus(db, brokenServer.id, {
  status: 'failed', exitCode: 1, finishedAt: ago(14),
  errorMessage: '> storefront@0.4.0 dev\n> vite --port 5174 --strictPort\n\nError: Port 5174 is already in use',
});
for (const t of PLAN.acceptance_criteria.slice(0, 5)) addCriterion(db, broken.id, t, 'claude');
insertCardEvent(db, { cardId: broken.id, actor: 'human', kind: 'note', stage: 'testing', body: 'Use a different port if 5174 is taken.', createdAt: ago(10) });

// 5. Testing, ready for review. The card the whole design is drawn around.
const ready = card('Save items for later from the cart', 'Shoppers who aren’t ready to buy take items out of the cart and lose track of them. Let them move an item to a Saved for later list under the cart, and bring it back with one click.', 'testing', 60 * 29);
for (const [kind, value, label] of [['file', 'src/cart/CartPage.tsx', null], ['file', 'src/api/cart.ts', null], ['card', '97', '#97 Cart page redesign']] as const) {
  addRef(db, ready.id, kind, value, label);
}
for (const t of PLAN.acceptance_criteria) addCriterion(db, ready.id, t, 'claude');

const planRun = pastRun({ cardId: ready.id, stage: 'planning', status: 'succeeded', output: PLAN, usd: 0.031, tokens: PLANNED, startedMinsAgo: 400, ranMins: 10 });
replaceQuestions(db, ready.id, planRun.id, 'planning', PLAN.open_questions);
// Both answered, which is what let it move on.
db.run(`UPDATE question SET answer='Merge them, dedupe by SKU, keep the newer quantity', answered_at=${ago(380).getTime()} WHERE run_id='${planRun.id}' AND position=1` as never);
db.run(`UPDATE question SET answer='Keep them until the shopper removes them', answered_at=${ago(378).getTime()} WHERE run_id='${planRun.id}' AND position=2` as never);
for (const [pos, ans] of [[1, 'Merge them, dedupe by SKU, keep the newer quantity'], [2, 'Keep them until the shopper removes them']] as const) {
  insertCardEvent(db, {
    cardId: ready.id, actor: 'human', kind: 'answered', stage: 'planning', runId: planRun.id,
    body: ans, meta: { position: pos }, createdAt: ago(380 - pos),
  });
}

// Evidence as Claude actually writes it, not the tidy one-word kind: a path too
// long to break at a space, a screenshot named in a sentence, a failure that
// runs to two lines, and output with a newline in it. Short, all-passing
// evidence is how the criteria list once overflowed the modal unnoticed.
const VERDICTS = [
  { verdict: 'pass', evidence: 'tests/e2e/cart/saved-for-later/cart.spec.ts::save_for_later_moves_the_line_out_of_the_subtotal_and_into_the_saved_list' },
  { verdict: 'pass', evidence: 'Screenshot “Cart with saved items” shows Move to cart and Remove on each saved row' },
  { verdict: 'fail', evidence: 'No second session could be signed in: the dev server has no seeded users, so persistence across devices was not observed. saved-items.e2e.ts › survives sign-out was skipped.' },
  { verdict: 'pass', evidence: 'guest.spec.ts › restores saved items from localStorage after reload' },
  { verdict: 'pass', evidence: '52 unit tests pass\ncart-store.test.ts › recomputes subtotal on save (4 ms)' },
  { verdict: 'pass', evidence: 'CartPage.test.tsx › hides Saved for later when empty' },
] as const;
const verdicts = VERDICTS.map((v, i) => ({ index: i + 1, ...v }));

pastRun({ cardId: ready.id, stage: 'in_progress', status: 'succeeded', output: IMPL, usd: 0.094, tokens: BUILT, startedMinsAgo: 300, ranMins: 39 });
pastRun({ cardId: ready.id, stage: 'testing', status: 'failed', usd: 0.002, tokens: BLIP, startedMinsAgo: 40, ranMins: 0.2, error: 'Port 5174 is already in use' });
const testRun = pastRun({
  cardId: ready.id, stage: 'testing', status: 'succeeded', usd: 0.057, tokens: TESTED, startedMinsAgo: 20, ranMins: 8,
  output: {
    passed: true,
    summary: '52 unit tests and 7 e2e tests pass. Typecheck and lint clean.',
    failures: [],
    fixes_applied: [],
    criteria: verdicts,
    differences: [{ capture_label: 'Cart with saved items', claim: 'Save for later is a link here but a button in the mockup.', note: 'Claude matched it to Remove beside it.' }],
  },
});
recordVerdicts(db, ready.id, testRun.id, verdicts);
// Written after the run, so Testing never judged it: the not-checked row.
addCriterion(db, ready.id, 'Saved list shows at most 50 items');
const readyServer = insertRun(db, {
  id: crypto.randomUUID(), cardId: ready.id, kind: 'server', stage: 'testing',
  status: 'running', cwd: '/tmp/x', port: 5174, createdAt: ago(18), startedAt: ago(18),
});

// --- the pictures ------------------------------------------------------------

/**
 * Both images are photographed for real, off a throwaway page served here.
 *
 * A generated placeholder would make the Preview tab look finished without
 * proving anything; going through the actual capture path means the pair on
 * screen is a mockup and a screenshot of the same page at the same width, as it
 * would be in a real run.
 */
const cartPage = (mockup: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>Cart</title>
<style>body{margin:0;background:#fbfaf8;font:16px -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2328}
.bar{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 40px;border-bottom:1px solid #e8e4dc}
.wrap{padding:28px 40px;display:flex;gap:48px}.col{flex-grow:1}
h1,h2{font-family:Georgia,serif;font-weight:400}h1{font-size:30px;margin:0 0 14px}h2{font-size:17px;font-weight:600;margin:28px 0 0}
.line{display:flex;gap:16px;align-items:flex-start;padding:16px 0;border-top:1px solid #e8e4dc}
.img{width:72px;height:72px;border-radius:6px;flex-shrink:0}.sm{width:56px;height:56px}
.meta{flex-grow:1;display:flex;flex-direction:column;gap:4px}.name{font-weight:600}.sub{font-size:13px;color:#6b6f76}
.acts{display:flex;gap:18px;align-items:center;margin-top:8px;font-size:13px}
.btn{border:1.5px solid #1f2328;border-radius:6px;padding:5px 12px;font-weight:600}
.link{text-decoration:underline;text-underline-offset:3px}.muted{color:#6b6f76}
.sum{width:280px;flex-shrink:0;margin-top:58px;border:1px solid #e8e4dc;border-radius:10px;padding:22px;display:flex;flex-direction:column;gap:12px;font-size:14px;background:#fff}
.row{display:flex;justify-content:space-between}.rule{height:1px;background:#e8e4dc}
.pay{margin-top:6px;background:#1f2328;color:#fff;text-align:center;border-radius:8px;padding:12px;font-weight:600}</style></head>
<body><div class="bar"><span style="font-family:Georgia,serif;font-size:21px">Storefront</span>
<div style="display:flex;gap:28px;font-size:14px"><span>Shop</span><span>Journal</span><span>Account</span><span style="font-weight:600">Cart (2)</span></div></div>
<div class="wrap"><div class="col"><h1>Your cart</h1>
${[['Linen overshirt', 'Oat · M', '$98.00', '#d8cfc0'], ['Canvas tote', 'Natural', '$50.00', '#c9d3cc']]
  .map(([n, s, p, c]) => `<div class="line"><div class="img" style="background:${c}"></div>
<div class="meta"><span class="name">${n}</span><span class="sub">${s}</span>
<div class="acts"><span class="${mockup ? 'btn' : 'link'}">Save for later</span><span class="link muted">Remove</span></div></div><span>${p}</span></div>`)
  .join('')}
<h2>Saved for later (1)</h2>
<div class="line"><div class="img sm" style="background:#b9b4ad"></div>
<div class="meta"><span class="name">Wool beanie</span><span class="sub">Charcoal</span>
<div class="acts"><span class="${mockup ? 'btn' : 'link'}">Move to cart</span><span class="link muted">Remove</span></div></div><span>$32.00</span></div>
</div><div class="sum"><div class="row"><span>Subtotal</span><span>$148.00</span></div>
<div class="row muted"><span>Shipping</span><span>Free</span></div><div class="rule"></div>
<div class="row" style="font-weight:600;font-size:16px"><span>Total</span><span>$148.00</span></div>
<div class="pay">Checkout</div></div></div></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(cartPage(req.url === '/mockup'));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address() as { port: number };

const shot = await captureTargets({
  baseUrl: `http://127.0.0.1:${port}`,
  targets: [
    { label: 'Cart with saved items', path: '/mockup', viewport: 1280 },
    { label: 'Cart with saved items', path: '/build', viewport: 1280 },
    { label: 'Cart on mobile', path: '/build', viewport: 390 },
  ],
});
server.close();

if (shot.unavailable) {
  console.log(`\n  no pictures: ${shot.unavailable}`);
  console.log('  everything else is seeded; the Preview tab will show its empty state.');
} else {
  const store = (label: string, kind: 'mockup' | 'screenshot', i: number, viewport: number) => {
    const c = shot.captures[i];
    if (!c) return null;
    const id = crypto.randomUUID();
    const rel = relativeAssetPath(ready.id, id, 'image/png');
    writeAsset(rel, c.bytes);
    return insertAsset(db, {
      cardId: ready.id, runId: kind === 'screenshot' ? testRun.id : null, kind, label,
      url: '/cart', viewport, path: rel, contentType: 'image/png', width: c.width, height: c.height,
    });
  };
  const mockup = store('Cart with saved items', 'mockup', 0, 1280);
  const build = store('Cart with saved items', 'screenshot', 1, 1280);
  store('Cart on mobile', 'screenshot', 2, 390);
  if (mockup && build) {
    replaceDifferences(db, ready.id, testRun.id, [
      {
        claim: 'Save for later is a link here but a button in the mockup.',
        note: 'Claude matched it to Remove beside it.',
        mockupAssetId: mockup.id,
        screenshotAssetId: build.id,
      },
    ]);
  }
}

console.log(`\n  seeded ${storefront.name}: 5 cards, one per activity state`);
console.log('  idle · needs_input · running · error · needs_review');
console.log(`  repo at ${repo}`);
console.log('\n  npm run dev, then click them.');
process.exit(0);
