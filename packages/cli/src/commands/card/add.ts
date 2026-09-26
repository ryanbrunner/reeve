import { parseArgs } from 'node:util';
import { STAGE_LABELS, isRunnable } from '@reeve/shared';
import { api, cardUrl } from '../../client.js';
import type { Command } from '../../command.js';
import { BODY_OPTIONS, addRefs, bodyFrom } from '../../input.js';
import { CliError, cardRef, note, parseOrUsage, print, printJson, usageError } from '../../output.js';
import { findProject, findRepo, repoForNew, requireStage, whereAmI } from '../../resolve.js';
import { watchStart } from '../../setOff.js';

export const add: Command = {
  usage: `  reeve card add <title> [--body TEXT | --body-file PATH|-] [--repo <repo>] [--project <project>]
                 [--stage <stage>] [--ref PATH|URL]... [--no-mockups] [--json | --quiet]
      A new card, in Backlog unless --stage says otherwise. It goes in --repo, else the repo you
      are in, else its project's repo, else the only repo there is. --ref pins a file or a link
      to it, and may be given more than once. Made in Planning, In Progress or Testing, it starts
      a Claude run there at once, as a drag would.
      Prints the new card's id: --quiet prints the id and nothing else, --json the whole card.`,

  async run(args) {
    const { values, positionals } = parseOrUsage(() =>
      parseArgs({
        args,
        allowPositionals: true,
        options: {
          ...BODY_OPTIONS,
          repo: { type: 'string' },
          project: { type: 'string' },
          stage: { type: 'string' },
          ref: { type: 'string', multiple: true },
          'no-mockups': { type: 'boolean' },
          json: { type: 'boolean' },
          quiet: { type: 'boolean' },
        },
      }),
    );
    const title = positionals.join(' ').trim();
    if (!title) throw usageError('card add needs a title');
    if (values.json && values.quiet) throw usageError('give --json or --quiet, not both');
    const stage = values.stage === undefined ? undefined : requireStage(values.stage);
    const body = await bodyFrom(values);

    const board = await api.board();
    const here = whereAmI(board, process.cwd());
    const project = values.project === undefined ? null : findProject(board, values.project);
    const repo = values.repo === undefined ? repoForNew(board, here, project) : findRepo(board, values.repo);
    if (!repo) note('No repo to put the card in, so it has none and nothing can run on it. Pass --repo to choose one.');

    const created = await api.createCard({
      title,
      body,
      repoId: repo?.id ?? null,
      stage,
      projectId: project?.id ?? null,
      ...(values['no-mockups'] ? { generateMockups: false } : {}),
    });
    try {
      await addRefs(created.id, values.ref);
    } catch (e) {
      // The card exists by now, and a script needs its id to finish the job.
      if (e instanceof CliError) throw new CliError(`created ${cardRef(created)} (${created.id}), but ${e.message}`);
      throw e;
    }
    // A new card has no runs, so any it has by now are the ones it set off.
    const card = isRunnable(created.stage) ? await watchStart(created, new Set()) : created;

    if (values.quiet) return print(card.id);
    if (values.json) return printJson(card);
    print(`Created ${cardRef(card)} in ${STAGE_LABELS[card.stage]}: ${card.title}`);
    print(`  id   ${card.id}`);
    print(`  url  ${cardUrl(card.id)}`);
  },
};
