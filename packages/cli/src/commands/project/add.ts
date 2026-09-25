import { parseArgs } from 'node:util';
import { api, cardUrl } from '../../client.js';
import type { Command } from '../../command.js';
import { BODY_OPTIONS, bodyFrom } from '../../input.js';
import { CliError, note, parseOrUsage, print, printJson, usageError } from '../../output.js';
import { findRepo, repoForNew, whereAmI } from '../../resolve.js';

export const add: Command = {
  usage: `  reeve project add <title> [--body TEXT | --body-file PATH|-] [--repo R] [--split] [--json | --quiet]
      A new project: a lane on the board that tasks are filed under with \`card add --project\`.
      It sits in no column and nothing runs a stage on it. --repo is the repo its split reads and
      its tasks fall back to: the repo you are in unless it says otherwise.
      --split has Claude break the brief into Backlog tasks straight away, which is a run and costs
      what one does. Without it the brief waits for Split on the board — though a first brief
      written later, with \`card edit --body\`, is split as soon as it is saved, as on the board.
      Prints the new project's id: --quiet prints the id and nothing else, --json the whole card.`,

  async run(args) {
    const { values, positionals } = parseOrUsage(() =>
      parseArgs({
        args,
        allowPositionals: true,
        options: {
          ...BODY_OPTIONS,
          repo: { type: 'string' },
          split: { type: 'boolean' },
          json: { type: 'boolean' },
          quiet: { type: 'boolean' },
        },
      }),
    );
    const title = positionals.join(' ').trim();
    if (!title) throw usageError('project add needs a title');
    if (values.json && values.quiet) throw usageError('give --json or --quiet, not both');
    const body = await bodyFrom(values);

    const board = await api.board();
    const repo =
      values.repo === undefined ? repoForNew(board, whereAmI(board, process.cwd()), null) : findRepo(board, values.repo);
    if (!repo) note('No repo for the project, so it cannot be split. Pass --repo to choose one.');

    const project = await api.createCard({ title, body, repoId: repo?.id ?? null, kind: 'project' });
    if (values.split) {
      try {
        const { runId } = await api.splitProject(project.id);
        note(`Splitting "${project.title}" into tasks: ${runId}`);
      } catch (e) {
        if (e instanceof CliError) throw new CliError(`created project "${project.title}" (${project.id}), but ${e.message}`);
        throw e;
      }
    }

    if (values.quiet) return print(project.id);
    if (values.json) return printJson(project);
    print(`Created project "${project.title}"${repo ? ` in ${repo.name}` : ''}`);
    print(`  id   ${project.id}`);
    print(`  url  ${cardUrl(project.id)}`);
  },
};
