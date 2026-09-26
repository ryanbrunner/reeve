import { parseArgs } from 'node:util';
import { STAGE_LABELS, type CardDetail } from '@reeve/shared';
import { api, baseUrl } from '../client.js';
import { activityLabel, formatCost, formatTime, parseOrUsage, print, printJson, usageError } from '../output.js';
import { resolveCard } from '../resolve.js';
import { renderRuns, totalCost } from './runs.js';

/** Runs listed before the rest are only counted. `reeve runs` has them all. */
const RUNS_SHOWN = 5;

const indent = (text: string, by = '  ') =>
  text
    .split('\n')
    .map((line) => (line ? `${by}${line}` : line))
    .join('\n');

function render(detail: CardDetail, projectTitle: string | null): string {
  const { card, worktree } = detail;
  const sections: string[] = [];

  const facts: Array<[string, string | null]> = [
    ['Id', card.id],
    // A project sits in no column, whatever its row says, so it has no stage to show.
    card.kind === 'project'
      ? ['Kind', 'project']
      : ['Stage', `${STAGE_LABELS[card.stage]} · ${activityLabel(card.activity)}`],
    ['Repo', card.repoName],
    ['Project', projectTitle],
    ['Archived', card.archivedAt === null ? null : formatTime(card.archivedAt)],
    ['Branch', worktree.branch],
    ['Worktree', worktree.path && (worktree.exists ? worktree.path : `${worktree.path} (removed)`)],
    ['PR', card.prUrl ?? (card.openingPr ? 'opening…' : null)],
    ['Merged', card.mergedAt === null ? null : formatTime(card.mergedAt)],
    ['Link', `${baseUrl()}/?card=${encodeURIComponent(card.id)}`],
  ];
  const shown = facts.filter((f): f is [string, string] => f[1] !== null);
  const width = Math.max(...shown.map(([label]) => label.length));
  sections.push([card.title, ...shown.map(([label, value]) => `${label.padEnd(width)}  ${value}`)].join('\n'));

  if (card.body.trim()) sections.push(indent(card.body.trim()));

  if (detail.criteria.length > 0) {
    const lines = detail.criteria.map((c) => `  [${(c.verdict ?? '').padEnd(4)}] ${c.text}`);
    sections.push(['Criteria', ...lines].join('\n'));
  }

  // Only the open ones: an answered question is history, and the events have it.
  const open = detail.questions.filter((q) => q.answer === null);
  if (open.length > 0) {
    const lines = open.flatMap((q) => [`  ${q.position}. ${q.text}`, ...q.suggestions.map((s) => `     - ${s}`)]);
    sections.push(['Open questions', ...lines].join('\n'));
  }

  if (detail.plan) {
    const { plan } = detail;
    sections.push(`Plan v${plan.version} (${plan.risk} risk, ${plan.steps.length} steps)\n${indent(plan.summary)}`);
  }
  if (detail.implementation) sections.push(`Implementation\n${indent(detail.implementation.summary)}`);
  if (detail.checks) {
    const { checks } = detail;
    const verdict = checks.passed ? 'passed' : 'failed';
    sections.push(
      `Checks ${verdict} (${checks.criteriaVerified}/${checks.criteriaTotal} criteria)\n${indent(checks.summary)}`,
    );
  }

  if (detail.runs.length > 0) {
    const lines = renderRuns(detail.runs.slice(0, RUNS_SHOWN), '  ');
    const more = detail.runs.length - RUNS_SHOWN;
    if (more > 0) lines.push(`  …and ${more} more`);
    sections.push([`Runs (${detail.runs.length} · ${formatCost(totalCost(detail.runs))})`, ...lines].join('\n'));
  }

  return sections.join('\n\n');
}

/** One card in full, by id or a unique prefix of one. `--json` is the detail endpoint's answer as it came. */
async function show(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  if (positionals.length !== 1) throw usageError('card show takes one card');
  const { card, cards } = await resolveCard(positionals[0]!);
  const detail = await api.detail(card.id);
  if (values.json) return printJson(detail);
  const project = detail.card.projectId ? cards.find((c) => c.id === detail.card.projectId) : undefined;
  print(render(detail, project?.title ?? null));
}

/**
 * `reeve card <verb>`. Only reading lives here so far; the verbs that change a
 * card are meant to join it under the same noun.
 */
const VERBS: Record<string, (args: string[]) => Promise<void>> = { show };

export async function card(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === undefined) throw usageError('card needs a verb: show');
  const run = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  if (!run) throw usageError(`unknown card verb '${verb}'`);
  return run(rest);
}
