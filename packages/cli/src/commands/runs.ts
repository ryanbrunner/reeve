import { parseArgs } from 'node:util';
import { STAGE_LABELS, type ApiRunSummary } from '@reeve/shared';
import { api } from '../client.js';
import { formatCost, formatTime, parseOrUsage, print, printJson, shortId, table, usageError } from '../output.js';
import { resolveCard } from '../resolve.js';

/**
 * A dev server's error is the tail of its output, npm's banner and all, and
 * the line that says what went wrong is the last one. `--json` has the rest.
 */
const lastLine = (text: string) => text.trim().split('\n').at(-1)!.trim();

/**
 * Runs as aligned rows, newest first as the server sends them. A run that
 * failed, or was refused a tool, gets the reason on the line under it: those
 * are the runs somebody is reading this list to find.
 */
export function renderRuns(runs: ApiRunSummary[], indent = ''): string[] {
  const rows = runs.map((r) => [
    shortId(r.id),
    formatTime(r.startedAt),
    r.task ?? STAGE_LABELS[r.stage],
    r.kind,
    r.status,
    [r.model, r.effort].filter(Boolean).join(' ') || '-',
    formatCost(r.totalCostUsd),
  ]);
  const lines = table(rows, indent);
  return runs.flatMap((r, i) => [
    lines[i]!,
    ...(r.errorMessage ? [`${indent}    ${lastLine(r.errorMessage)}`] : []),
    ...r.deniedToolUses.map((d) => `${indent}    denied ${d.tool}${d.detail ? `: ${d.detail}` : ''}`),
  ]);
}

export const totalCost = (runs: ApiRunSummary[]) => runs.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0);

/** Every run a card has had, of every kind. `--json` is the endpoint's array as it came. */
export async function runs(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  if (positionals.length !== 1) throw usageError('runs takes one card');
  const { card } = await resolveCard(positionals[0]!);
  const list = await api.runs(card.id);
  if (values.json) return printJson(list);

  const heading = `${shortId(card.id)}  ${card.title}`;
  if (list.length === 0) return print(`${heading}\n\nNo runs yet.`);
  print([heading, '', `Runs (${list.length} · ${formatCost(totalCost(list))})`, ...renderRuns(list, '  ')].join('\n'));
}
