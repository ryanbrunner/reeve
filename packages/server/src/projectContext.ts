import { STAGE_LABELS, type Stage } from '@reeve/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { artifactsForCard, dependenciesOf, getCard, tasksInProject } from './db/queries.js';
import { cardDependency, type Card } from './db/schema.js';
import { stackParent, stackedOn } from './stacks.js';

/**
 * What the rest of a project has done, for a stage run on one of its tasks.
 *
 * A project is split into tasks that build on each other, and each task's
 * runs used to start knowing nothing of the others: a later task re-derived
 * what an earlier one had decided, or contradicted it, and found out about
 * code that had already landed only by tripping over it. So each run on a
 * task is told where every other task stands, and what the ones that have
 * been built did — in full for the tasks this one waits on, in a line for
 * the rest. Read from the cards and their stage documents, which Reeve
 * writes; nothing is asked of Claude to keep it.
 *
 * Bounded, so a project of thirty tasks does not crowd out the card's own
 * brief: the tasks this one waits on come first and keep their detail, and
 * past the budget the rest are named and nothing more.
 */
const BUDGET = 9_000;
/** How much of one dependency's implementation notes is carried. */
const DEPENDENCY_NOTES = 2_000;
/** How much of the project's own brief opens the section. */
const PROJECT_BRIEF = 1_200;

export function projectContextFor(db: Db, task: Card): string {
  if (!task.projectId) return '';
  const project = getCard(db, task.projectId);
  if (!project) return '';
  const siblings = tasksInProject(db, project.id).filter((c) => c.id !== task.id);
  if (siblings.length === 0) return '';

  const waitsOn = new Set(dependenciesOf(db, task.id).map((c) => c.id));
  const waitedOnBy = new Set(
    db.select({ id: cardDependency.cardId }).from(cardDependency).where(eq(cardDependency.dependsOnId, task.id)).all().map((r) => r.id),
  );

  const out: string[] = [
    '## The rest of this project',
    '',
    `This card is one task of the project **${project.title}**, split into ${siblings.length + 1} tasks that build on each other. ` +
      'What the others have done is below: build on it rather than around it, and do not redo or contradict what has landed. ' +
      'Merged work is already on the base branch your worktree came from.',
    '',
  ];
  const parent = stackedOn(db, task) ?? stackParent(db, task);
  if (parent) {
    out.push(
      `This card builds on **#${parent.number} ${parent.title}**, which has not merged yet: its branch is this card's base, ` +
        'so its work is already in your worktree. Use it as it is; a change it needs belongs on that card, not this one.',
      '',
    );
  }
  const brief = project.body.trim();
  if (brief) out.push('The project brief opens:', '', quote(clip(brief, PROJECT_BRIEF)), '');

  // The ones this card waits on first, then in the order they were made.
  const ordered = [...siblings].sort((a, b) => Number(waitsOn.has(b.id)) - Number(waitsOn.has(a.id)));
  let used = out.join('\n').length;
  let named = 0;
  const lines: string[] = [];
  for (const sibling of ordered) {
    const relation = waitsOn.has(sibling.id) ? ' — **this card waits on it**' : waitedOnBy.has(sibling.id) ? ' — waits on this card' : '';
    const head = `- **#${sibling.number} ${sibling.title}**: ${standing(sibling)}${relation}`;
    const detail = detailFor(db, sibling, waitsOn.has(sibling.id));
    const entry = detail ? `${head}\n${detail}` : head;
    if (used + entry.length > BUDGET && !waitsOn.has(sibling.id)) {
      lines.push(head);
      named++;
      used += head.length;
      continue;
    }
    lines.push(entry);
    used += entry.length;
  }
  out.push('### The other tasks', '', ...lines, '');
  if (named) out.push(`_${named} of these are named only, to keep this short: their documents are on their cards._`, '');
  return out.join('\n');
}

/** Where a task stands, in the words a person would use. */
function standing(c: Card): string {
  if (c.mergedAt) return 'merged';
  if (c.archivedAt) return 'archived without merging';
  if (c.prUrl) return `pull request open (${c.prUrl})`;
  return c.stage === 'backlog' ? 'in Backlog, not started' : `in ${STAGE_LABELS[c.stage as Stage] ?? c.stage}`;
}

/**
 * What a task has to show: what its build did, or failing that what its plan
 * means to do. A dependency gets its implementation notes whole, near enough;
 * anything else gets its one-line summary.
 */
function detailFor(db: Db, c: Card, full: boolean): string {
  const current = artifactsForCard(db, c.id).filter((a) => a.supersededBy === null);
  const built = current.find((a) => a.kind === 'summary');
  const planned = current.find((a) => a.kind === 'plan');
  const branch = c.branchName && !c.mergedAt ? `  Branch \`${c.branchName}\`.` : '';
  if (built) {
    if (full) return `${indent(clip(demote(built.content.trim()), DEPENDENCY_NOTES))}${branch ? `\n${branch}` : ''}`;
    return `  Built: ${firstLine(built.content)}${branch}`;
  }
  if (planned) return `  Planned: ${firstLine(planned.content)}`;
  return '';
}

/** A stage document's opening line: its `> summary`. */
function firstLine(markdown: string): string {
  const line = markdown.split('\n').map((l) => l.replace(/^>\s?/, '').trim()).find(Boolean) ?? '';
  return clip(line, 240);
}

/** A document's own headings, as bold labels: here they sit inside a list item, under this section's. */
function demote(markdown: string): string {
  return markdown.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function quote(text: string): string {
  return text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
}

function indent(text: string): string {
  return text.split('\n').map((l) => (l ? `  ${l}` : '')).join('\n');
}
