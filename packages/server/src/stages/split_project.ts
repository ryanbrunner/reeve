import { projectSplitOutput, type ProjectSplitOutput } from '@reeve/shared';
import { copyPastedImages } from '../assets/pasted.js';
import type { Db } from '../db/client.js';
import {
  addCriterion,
  addDependency,
  allDependencies,
  createCard,
  listRepos,
  tasksInProject,
  updateCard,
} from '../db/queries.js';
import type { Card } from '../db/schema.js';
import { renderPrompt } from './template.js';
import type { ClaudeTask } from './types.js';

/**
 * A project's brief, broken into cards. The project's own Suggest: started on
 * its own the first time a brief is saved, and again from the brief's Split
 * button.
 *
 * Out of band for the same reasons Suggest is, and read-only for the same
 * reasons Planning is. The cards it makes land in Backlog and start nothing:
 * a person reads them before anything is spent on building one.
 */
export const splitProjectTask: ClaudeTask<ProjectSplitOutput> = {
  id: 'split_project',
  outOfBand: true,
  schema: projectSplitOutput,
  permissionMode: 'plan',
  allowedTools: ['Read', 'Glob', 'Grep'],
  maxBudgetUsd: 2,
  maxTurns: 30,
  effort: 'medium',

  // A project can span every repo, so Claude may read them all, not just the
  // default one it runs in.
  directories: (db) => listRepos(db).map((r) => r.repoPath),

  // The prompt lists what is already under the project and which repos there
  // are, and `buildPrompt` has no database to ask.
  async prepare(db, _writer, ctx) {
    const existing = tasksInProject(db, ctx.card.id);
    return {
      existing: existing.length ? existing.map((t) => `- ${t.title}`).join('\n') : '_None yet._',
      repos: listRepos(db).map((r) => `- **${r.name}**: \`${r.repoPath}\``).join('\n'),
    };
  },

  buildPrompt(ctx, prepared = {}) {
    return renderPrompt('split_project', {
      ...prepared,
      worktreePath: ctx.worktreePath,
      defaultRepo: ctx.repo.name,
      title: ctx.card.title,
      body: ctx.brief,
    });
  },

  // Nothing to write to disk: tasks are cards, and only cards.
  onComplete: () => [],

  /**
   * Added, never replacing, and skipping any title the project already has —
   * archived tasks included, since those were taken off on purpose. So pressing
   * Split again adds what is missing rather than a second copy of everything.
   *
   * A repo is matched by name, not trusted as an id, and one Claude names that
   * does not exist falls back to the project's own, like one it did not name.
   *
   * Every card is made before any link, because a task may depend on one
   * listed after it.
   *
   * A task's pasted images are copied to it once it exists, since the copies
   * live under its id.
   */
  onPersist(db, ctx, output) {
    const repos = new Map(listRepos(db).map((r) => [r.name.toLowerCase(), r.id]));
    const have = new Map(tasksInProject(db, ctx.card.id).map((t) => [t.title.trim().toLowerCase(), t]));
    const made: Array<{ id: string; dependsOn: string[] }> = [];
    for (const task of output.tasks) {
      const key = task.title.trim().toLowerCase();
      if (have.has(key)) continue;
      const created = createCard(db, {
        title: task.title.trim(),
        body: task.body,
        repoId: (task.repo && repos.get(task.repo.trim().toLowerCase())) || ctx.card.repoId,
        stage: 'backlog',
        kind: 'task',
        projectId: ctx.card.id,
        actor: 'claude',
      });
      const body = copyPastedImages(db, created.id, task.body);
      if (body !== task.body) updateCard(db, created.id, { body });
      have.set(key, created);
      made.push({ id: created.id, dependsOn: task.dependsOn });
      for (const text of task.criteria) addCriterion(db, created.id, text, 'claude');
    }
    linkDependencies(db, have, made);
  },

  summarise(output) {
    const n = output.tasks.length;
    return `Split into ${n} task${n === 1 ? '' : 's'}`;
  },
};

/**
 * The links Claude proposed for the cards this split made, by title against
 * everything under the project. A link that cannot stand is dropped rather
 * than failing a run whose cards have already landed: a title that matches
 * nothing, a task naming itself, or one that would close a loop, which no
 * order of work could satisfy. Of two links that loop only together, the one
 * Claude gave first is kept.
 *
 * Only cards made here gain links. One already under the project may be a
 * person's, or already being built, and a split should not hold it back.
 * Links to an archived task are dropped too: it was taken off, merged or not,
 * and either way there is nothing left to wait for.
 */
function linkDependencies(db: Db, byTitle: Map<string, Card>, made: Array<{ id: string; dependsOn: string[] }>) {
  // Every link on the board, since a loop can run through a card outside the
  // project, and each one added here joins it before the next is checked.
  const edges = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    const out = edges.get(from) ?? new Set<string>();
    out.add(to);
    edges.set(from, out);
  };
  for (const d of allDependencies(db)) link(d.cardId, d.dependsOnId);

  const reaches = (from: string, target: string) => {
    const seen = new Set<string>();
    const stack = [from];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      if (at === target) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(edges.get(at) ?? []));
    }
    return false;
  };

  for (const task of made) {
    for (const title of task.dependsOn) {
      const on = byTitle.get(title.trim().toLowerCase());
      if (!on || on.archivedAt || on.id === task.id || reaches(on.id, task.id)) continue;
      addDependency(db, task.id, on.id);
      link(task.id, on.id);
    }
  }
}
