import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { isRunnable, STAGE_LABELS } from '@reeve/shared';
import { api, cardUrl } from '../client.js';
import { CliError, cardRef, note, parseOrUsage, print, printJson, usageError } from '../output.js';
import { findRepo, requireStage, whereAmI } from '../resolve.js';

async function readBody(path: string): Promise<string> {
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    throw new CliError(`could not read ${path}: ${(e as Error).message}`);
  }
}

/**
 * A new card, in the repo the cwd is in unless `--repo` says otherwise.
 * Made straight into a column Claude works in, it starts a run at once, the
 * same as a drag there — which is worth saying before it happens.
 */
export async function add(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: {
        body: { type: 'string' },
        'body-file': { type: 'string' },
        repo: { type: 'string' },
        stage: { type: 'string' },
        json: { type: 'boolean' },
      },
    }),
  );
  const title = positionals.join(' ').trim();
  if (!title) throw usageError('add needs a title');
  if (values.body !== undefined && values['body-file'] !== undefined) {
    throw usageError('give --body or --body-file, not both');
  }
  const stage = values.stage === undefined ? undefined : requireStage(values.stage);
  const body = values['body-file'] === undefined ? values.body : await readBody(values['body-file']);

  const board = await api.board();
  const repo = values.repo === undefined ? whereAmI(board, process.cwd()).repo : findRepo(board, values.repo);
  if (!repo) note('Not inside a registered repo, so the card has no repo. Pass --repo to choose one.');
  if (repo && stage && isRunnable(stage)) {
    note(`${STAGE_LABELS[stage]} runs Claude: this card starts a run as soon as it is made.`);
  }

  const card = await api.createCard({ title, body, repoId: repo?.id ?? null, stage });
  if (values.json) return printJson(card);
  print(`Created ${cardRef(card)} in ${STAGE_LABELS[card.stage]}: ${card.title}`);
  print(cardUrl(card.id));
}
