import { parseArgs } from 'node:util';
import { STAGE_LABELS, STAGES, type ApiCard, type ApiProject, type Stage } from '@reeve/shared';
import { api } from '../client.js';
import { activityLabel, formatTime, parseOrUsage, print, printJson, shortId, table } from '../output.js';
import { findProject, findRepo, requireStage } from '../resolve.js';

/**
 * What a card is doing, in a word or two: its activity when it has one, and on
 * a Done card the pull request, which is the only thing still moving there.
 */
function status(card: ApiCard): string {
  const parts = card.activity === 'idle' ? [] : [activityLabel(card.activity)];
  if (card.mergedAt !== null) parts.push('merged');
  else if (card.mergingPr) parts.push(`merging PR #${card.prNumber}`);
  else if (card.resolvingConflicts) parts.push('resolving conflicts');
  else if (card.prConflicting) parts.push(`PR #${card.prNumber} conflicts`);
  else if (card.openingPr) parts.push('opening PR');
  else if (card.prNumber !== null) parts.push(`PR #${card.prNumber}`);
  return parts.join(', ') || 'idle';
}

/**
 * The board column by column, or with `--archived` what has been taken off it.
 *
 * `--json` prints what the API answered, narrowed by the filters and nothing
 * else: the `BoardResponse` from the board, the card array from the archive.
 * An agent reading it gets the same fields the web app does.
 */
export async function board(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        repo: { type: 'string' },
        project: { type: 'string' },
        stage: { type: 'string' },
        archived: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    }),
  );
  const stage = values.stage === undefined ? null : requireStage(values.stage);

  const [response, archived] = await Promise.all([
    api.board(),
    values.archived ? api.archived() : Promise.resolve(null),
  ]);
  // An archived project is still a project to filter the archive by: its
  // tasks usually went with it.
  const projects = [...response.projects, ...(archived ?? []).filter((c) => c.kind === 'project').map(asProject)];
  const repo = values.repo === undefined ? null : findRepo(response, values.repo);
  const project = values.project === undefined ? null : findProject(response, values.project);
  const titles = new Map(projects.map((p) => [p.id, p.title]));

  if (archived) {
    // A project's own card is kept by its project filter, and dropped by any
    // stage filter: it sits in no column, whatever its row says.
    const cards = archived.filter(
      (c) =>
        (!repo || c.repoId === repo.id)
        && (!project || c.projectId === project.id || c.id === project.id)
        && (!stage || (c.kind === 'task' && c.stage === stage)),
    );
    if (values.json) return printJson(cards);
    return print(renderArchive(cards, titles));
  }

  const cards = response.cards.filter(
    (c) => (!repo || c.repoId === repo.id) && (!project || c.projectId === project.id) && (!stage || c.stage === stage),
  );
  // A project is a lane, not a card in a column, so the stage filter is no
  // reason to drop one; the repo and project filters are.
  const lanes = response.projects.filter(
    (p) => (!repo || p.repoId === repo.id) && (!project || p.id === project.id),
  );
  if (values.json) return printJson({ ...response, cards, projects: lanes });

  const sections: string[] = [];
  if (response.vibes) sections.push(`VIBES MODE since ${formatTime(response.vibes.since)}`);
  sections.push(renderColumns(cards, stage ? [stage] : STAGES, titles));
  if (!stage && lanes.length > 0) {
    const repoName = (id: string | null) => response.repos.find((r) => r.id === id)?.name ?? '-';
    const rows = lanes.map((p) => [
      shortId(p.id),
      `${p.taskCount} ${p.taskCount === 1 ? 'task' : 'tasks'}`,
      repoName(p.repoId),
      p.title,
    ]);
    sections.push([`Projects (${lanes.length})`, ...table(rows, '  ')].join('\n'));
  }
  print(sections.join('\n\n'));
}

/** Enough of an archived project's card to filter by, the same as a live one. */
const asProject = (c: ApiCard): ApiProject => ({
  id: c.id,
  title: c.title,
  repoId: c.repoId,
  laneColor: c.laneColor,
  taskCount: 0,
  vibes: c.vibes,
});

/**
 * Every column's cards as one table, so the columns line up down the whole
 * board rather than restarting their widths under each heading.
 */
function renderColumns(cards: ApiCard[], stages: readonly Stage[], titles: Map<string, string>): string {
  const row = (c: ApiCard) => [
    shortId(c.id),
    status(c),
    c.repoName ?? '-',
    (c.projectId && titles.get(c.projectId)) || '-',
    c.title,
  ];
  const groups = stages.map((s) => ({ label: STAGE_LABELS[s], cards: cards.filter((c) => c.stage === s) }));
  const lines = table(groups.flatMap((g) => g.cards.map(row)), '  ');
  let next = 0;
  return groups
    .map((g) => [`${g.label} (${g.cards.length})`, ...lines.slice(next, (next += g.cards.length))].join('\n'))
    .join('\n\n');
}

/**
 * One list, most recently archived first as the server sends it. The column a
 * card left from is shown rather than grouped by: what an archive is asked is
 * usually "what went, and when".
 */
function renderArchive(cards: ApiCard[], titles: Map<string, string>): string {
  if (cards.length === 0) return 'Archived (0)';
  const row = (c: ApiCard) => [
    shortId(c.id),
    formatTime(c.archivedAt),
    c.kind === 'project' ? 'project' : STAGE_LABELS[c.stage],
    c.repoName ?? '-',
    c.kind === 'project' ? '-' : (c.projectId && titles.get(c.projectId)) || '-',
    c.title,
  ];
  return [`Archived (${cards.length})`, ...table(cards.map(row), '  ')].join('\n');
}
