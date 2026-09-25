import { parseArgs } from 'node:util';
import { STAGE_LABELS, type CardDetail } from '@reeve/shared';
import { api, cardUrl } from '../client.js';
import {
  activityLabel,
  cardRef,
  formatCost,
  formatTime,
  parseOrUsage,
  print,
  printJson,
  usageError,
} from '../output.js';
import { resolveCard, whereAmI } from '../resolve.js';

/** Runs listed before the rest are only counted. */
const RUNS_SHOWN = 5;

const indent = (text: string) =>
  text
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n');

function render(detail: CardDetail): string {
  const { card, worktree } = detail;
  const sections: string[] = [];

  const facts: Array<[string, string | null]> = [
    ['Stage', `${STAGE_LABELS[card.stage]} · ${activityLabel(card.activity)}`],
    ['Branch', worktree.branch],
    ['Worktree', worktree.path && (worktree.exists ? worktree.path : `${worktree.path} (removed)`)],
    ['PR', card.prUrl ?? (card.openingPr ? 'opening…' : null)],
    ['Link', cardUrl(card.id)],
  ];
  const shown = facts.filter((f): f is [string, string] => f[1] !== null);
  const width = Math.max(...shown.map(([label]) => label.length));
  sections.push(
    [`${cardRef(card)}  ${card.title}`, ...shown.map(([label, value]) => `${label.padEnd(width)}  ${value}`)].join('\n'),
  );

  if (card.body.trim()) sections.push(indent(card.body.trim()));

  if (detail.criteria.length > 0) {
    const lines = detail.criteria.map((c) => `  [${c.verdict ?? '    '}] ${c.text}`);
    sections.push(['Criteria', ...lines].join('\n'));
  }

  const open = detail.questions.filter((q) => q.answer === null);
  if (open.length > 0) {
    const lines = open.flatMap((q) => [
      `  ${q.position}. ${q.text}`,
      ...q.suggestions.map((s) => `     - ${s}`),
    ]);
    sections.push(['Open questions', ...lines].join('\n'));
  }

  if (detail.runs.length > 0) {
    const total = detail.runs.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0);
    const lines = detail.runs.slice(0, RUNS_SHOWN).map((r) => {
      const what = r.task ?? r.stage;
      return `  ${formatTime(r.startedAt)}  ${what.padEnd(11)}  ${r.kind.padEnd(6)}  ${r.status.padEnd(11)}  ${formatCost(r.totalCostUsd)}`;
    });
    const more = detail.runs.length - RUNS_SHOWN;
    if (more > 0) lines.push(`  …and ${more} more`);
    sections.push([`Runs (${detail.runs.length} · ${formatCost(total)})`, ...lines].join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * One card in full. With no card named, the card whose worktree the cwd is
 * in — so a Claude session working in a card can ask what it is working on.
 */
export async function show(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  if (positionals.length > 1) throw usageError('show takes at most one card');
  const [ref] = positionals;

  const board = await api.board();
  const here = whereAmI(board, process.cwd());
  const card = ref === undefined ? here.card : resolveCard(board, ref, here);
  if (!card) throw usageError(`no card given, and ${process.cwd()} is not inside a card's worktree`);

  const detail = await api.detail(card.id);
  if (values.json) return printJson(detail);
  print(render(detail));
}
