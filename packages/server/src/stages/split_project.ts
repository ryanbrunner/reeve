import { projectSplitOutput, type ProjectSplitOutput } from '@reeve/shared';
import { addCriterion, createCard, listRepos, tasksInProject } from '../db/queries.js';
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
      body: ctx.card.body.trim() || '_No further detail was given._',
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
   */
  onPersist(db, ctx, output) {
    const repos = new Map(listRepos(db).map((r) => [r.name.toLowerCase(), r.id]));
    const have = new Set(tasksInProject(db, ctx.card.id).map((t) => t.title.trim().toLowerCase()));
    for (const task of output.tasks) {
      const key = task.title.trim().toLowerCase();
      if (have.has(key)) continue;
      have.add(key);
      const created = createCard(db, {
        title: task.title.trim(),
        body: task.body,
        repoId: (task.repo && repos.get(task.repo.trim().toLowerCase())) || ctx.card.repoId,
        stage: 'backlog',
        kind: 'task',
        projectId: ctx.card.id,
        actor: 'claude',
      });
      for (const text of task.criteria) addCriterion(db, created.id, text, 'claude');
    }
  },

  summarise(output) {
    const n = output.tasks.length;
    return `Split into ${n} task${n === 1 ? '' : 's'}`;
  },
};
