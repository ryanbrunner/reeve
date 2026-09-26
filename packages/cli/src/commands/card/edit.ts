import { parseArgs } from 'node:util';
import { api, type UpdateCardBody } from '../../client.js';
import type { Command } from '../../command.js';
import { BODY_OPTIONS, addRefs, bodyFrom } from '../../input.js';
import { note, parseOrUsage, print, printJson, usageError } from '../../output.js';
import { findRepo, resolveTarget, whereAmI } from '../../resolve.js';
import { runIds } from '../../setOff.js';

/** `default` clears the card's own model or effort, so the stage's setting applies again. */
const orDefault = (value: string | undefined) => (value === undefined ? undefined : value === 'default' ? null : value);

/** Each field as the flag that sets it, to say back what changed. */
const FIELD_NAMES: Record<keyof UpdateCardBody, string> = {
  title: 'title',
  body: 'body',
  repoId: 'repo',
  model: 'model',
  effort: 'effort',
  generateMockups: 'mockups',
};

export const edit: Command = {
  usage: `  reeve card edit <card> [--title T] [--body TEXT | --body-file PATH|-] [--repo <repo> | --no-repo]
                  [--model M] [--effort E] [--mockups | --no-mockups] [--ref PATH|URL]... [--json]
      Change a card, or a project's brief. --model and --effort set this card's own, above the
      stage's default in Settings; \`default\` clears them. --ref pins another file or link to it.
      A project's first brief is split into tasks by Claude as soon as it is saved, as on the board.`,

  async run(args) {
    const { values, positionals } = parseOrUsage(() =>
      parseArgs({
        args,
        allowPositionals: true,
        options: {
          ...BODY_OPTIONS,
          title: { type: 'string' },
          repo: { type: 'string' },
          'no-repo': { type: 'boolean' },
          model: { type: 'string' },
          effort: { type: 'string' },
          mockups: { type: 'boolean' },
          'no-mockups': { type: 'boolean' },
          ref: { type: 'string', multiple: true },
          json: { type: 'boolean' },
        },
      }),
    );
    const [ref, ...extra] = positionals;
    if (ref === undefined || extra.length > 0) throw usageError('card edit needs one card, then what to change');
    if (values.repo !== undefined && values['no-repo']) throw usageError('give --repo or --no-repo, not both');
    if (values.mockups && values['no-mockups']) throw usageError('give --mockups or --no-mockups, not both');
    const body = await bodyFrom(values);

    const board = await api.board();
    const target = resolveTarget(board, ref, whereAmI(board, process.cwd()));
    const patch: UpdateCardBody = {
      title: values.title,
      body,
      repoId: values['no-repo'] ? null : values.repo === undefined ? undefined : findRepo(board, values.repo).id,
      model: orDefault(values.model),
      effort: orDefault(values.effort),
      generateMockups: values.mockups ? true : values['no-mockups'] ? false : undefined,
    };
    const changes = Object.values(patch).some((v) => v !== undefined);
    if (!changes && !values.ref?.length) throw usageError('card edit was given nothing to change');

    // A project's brief can start a split, which the save does not report.
    const before = target.kind === 'project' && body !== undefined ? await runIds(target.id) : null;
    let card = changes ? await api.updateCard(target.id, patch) : null;
    const refs = await addRefs(target.id, values.ref);
    if (before) {
      const split = (await api.runs(target.id)).find((r) => r.task === 'split_project' && !before.has(r.id));
      if (split) note(`A first brief is split into tasks: Claude is splitting ${target.label} now (${split.id}).`);
    }

    // Refs alone change nothing the card itself carries, so read it back for them.
    card ??= (await api.detail(target.id)).card;
    if (values.json) return printJson(card);
    const what = [
      ...(Object.keys(FIELD_NAMES) as Array<keyof UpdateCardBody>)
        .filter((k) => patch[k] !== undefined)
        .map((k) => FIELD_NAMES[k]),
      ...(refs.length ? [`${refs.length} ref${refs.length === 1 ? '' : 's'}`] : []),
    ];
    print(`Updated ${target.label}: ${what.join(', ')}`);
  },
};
