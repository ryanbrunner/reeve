import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isTerminal, type ApiAsset, type ApiCriterion, type CardDetail } from '@reeve/shared';
import { api } from '../../lib/api.js';
import { VibesSwitch } from '../../vibes/Switch.js';
import { when } from '../format.js';
import { Lightbox } from '../Lightbox.js';
import { Markdown } from '../Markdown.js';
import { RichText } from '../RichText.js';
import { Code, Empty, SectionHead, SmallButton } from '../ui.js';

/**
 * What this card is for, and what would make it done.
 *
 * The one tab that is mostly a person's own writing rather than a report, so
 * it is the only one that is editable throughout.
 */
export function BriefTab({ detail }: { detail: CardDetail }) {
  // A project is done when its tasks are, so it has no criteria of its own:
  // its brief is what they are split from.
  return (
    <>
      <Purpose detail={detail} />
      {detail.card.kind === 'project' ? <Split detail={detail} /> : <Criteria detail={detail} />}
      <Context detail={detail} />
    </>
  );
}

/**
 * The empty box standing in for the editor when nothing is written yet, in the
 * editor's own look, so clicking one doesn't change the shape of the other.
 */
const FIELD =
  'max-w-[40rem] rounded-md border border-(--color-edge) bg-(--color-ink) p-3 text-sm/5 outline-none focus:border-sky-600';

function Purpose({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const noun = detail.card.kind === 'project' ? 'project' : 'card';
  const prompt = `What is this ${noun} for?`;
  const save = useMutation({
    mutationFn: (body: string) => api.updateCard(detail.card.id, { body }),
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: ['board'] });
      await qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      setEditing(false);
    },
  });

  const start = () => {
    setPasteError(null);
    setEditing(true);
  };
  // Clicking the text is what edits it, except where the click meant something
  // else: following a link, or finishing a selection to copy.
  const edit = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a')) return;
    if (window.getSelection()?.toString()) return;
    start();
  };
  // Enter on the field itself, not on a link inside it.
  const open = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) start();
  };

  // Blur is the save — and Escape blurs (see CardModal), so it saves too. The
  // editor stays up until the save lands, rather than flashing the old body.
  const done = (markdown: string | null) => {
    if (markdown === null || markdown === detail.card.body.trim()) setEditing(false);
    else save.mutate(markdown);
  };

  return (
    <section className="flex flex-col gap-2">
      {editing ? (
        <RichText
          initial={detail.card.body}
          disabled={save.isPending}
          placeholder={prompt}
          // The heading used to name this field. Nothing else does now, and a
          // placeholder stops naming it the moment there is something in it.
          label={`What this ${noun} is for`}
          upload={(file) => api.uploadPasted(detail.card.id, file).then((a) => a.src)}
          onDone={done}
          onError={setPasteError}
        />
      ) : detail.card.body.trim() ? (
        // No role: the brief is a passage with links in it, and calling that a
        // button would hand a screen reader the whole thing as one label.
        <div
          tabIndex={0}
          title="Click to edit"
          onClick={edit}
          onKeyDown={open}
          className="-m-2 max-w-[41rem] cursor-text rounded-md border border-transparent p-2 hover:border-(--color-edge) focus:border-sky-600 focus:outline-none"
        >
          <Markdown>{detail.card.body}</Markdown>
        </div>
      ) : (
        // Nothing written: the field itself, waiting, rather than a note saying
        // it is empty — there is nothing here to read, only somewhere to write.
        <div
          tabIndex={0}
          title="Click to write"
          onClick={edit}
          onKeyDown={open}
          // 6.625rem is the editor's four rows, padding and border, so opening
          // it adds the toolbar and nothing else.
          className={`${FIELD} min-h-[6.625rem] cursor-text text-(--color-muted) hover:border-slate-600`}
        >
          {prompt}
        </div>
      )}
      {save.error && <p className="text-sm/5 text-red-300">{save.error.message}</p>}
      {pasteError && <p className="text-sm/5 text-red-300">{pasteError}</p>}
      {/* A project is never planned, so it has no mockups to draw. */}
      {detail.card.kind === 'task' && <GenerateMockups detail={detail} />}
      {/* Nor is a project ever swept, so it has no switch: the sweep moves tasks. */}
      {detail.card.kind === 'task' && <CardVibes detail={detail} />}
    </section>
  );
}

/**
 * A project's brief, broken into cards. The first split starts on its own when
 * the brief is first saved; this is how to ask again, after the brief has grown.
 * Wired as Suggest is, and busy and failed off the latest run for the same reason.
 */
function Split({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const split = useMutation({
    mutationFn: () => api.splitProject(detail.card.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['card', detail.card.id] }),
  });

  const last = detail.runs.find((r) => r.task === 'split_project');
  const splitting = split.isPending || (last !== undefined && !isTerminal(last.status));
  const failure =
    split.error?.message ??
    (!splitting && (last?.status === 'failed' || last?.status === 'interrupted')
      ? `Split failed: ${last.errorMessage ?? 'the run was interrupted'}`
      : null);

  // The cards it made are the board's, which polls lazily when nothing on it
  // is running — and nothing on it is: the split is the project's.
  const landed = last?.status === 'succeeded' ? last.id : null;
  useEffect(() => {
    if (landed) void qc.invalidateQueries({ queryKey: ['board'] });
  }, [landed, qc]);

  return (
    <section className="flex flex-col gap-2">
      <SectionHead
        aside={
          <SmallButton
            tone="sky"
            busy={splitting}
            disabled={!detail.card.body.trim()}
            title={detail.card.body.trim() ? undefined : 'Write the brief first'}
            onClick={() => split.mutate()}
          >
            {splitting ? 'Splitting…' : 'Split into tasks'}
          </SmallButton>
        }
      >
        Tasks
      </SectionHead>
      <span className="font-mono text-[10px]/4 text-(--color-muted)">
        Claude breaks the brief into Backlog cards under this project, skipping any it already has
      </span>
      {failure && <p className="text-sm/5 text-red-300">{failure}</p>}
    </section>
  );
}

/**
 * Whether Planning draws its own mockups. Here, under the description, because
 * this is where a new card opens: the choice is made while the card is being
 * written, and can be changed any time before Planning runs.
 */
function GenerateMockups({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (generateMockups: boolean) => api.updateCard(detail.card.id, { generateMockups }),
    // The card's refetch is returned rather than fired, so the mutation stays
    // pending until the new value is in `detail` and the box cannot flick back.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['board'] });
      return qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
    },
  });
  // The box follows the click at once rather than waiting on the round trip.
  const checked = (set.isPending ? set.variables : undefined) ?? detail.card.generateMockups;

  return (
    <div className="flex flex-col gap-1">
      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm/5 text-(--color-text)">
        <input
          type="checkbox"
          checked={checked}
          disabled={set.isPending}
          onChange={(e) => set.mutate(e.target.checked)}
          className="accent-sky-600"
        />
        Generate mockups
      </label>
      <span className="font-mono text-[10px]/4 text-(--color-muted)">
        Claude draws the screens this changes while planning, for Testing to compare the build against
      </span>
      {set.error && <p className="text-sm/5 text-red-300">{set.error.message}</p>}
    </div>
  );
}

/**
 * VIBES MODE for this card alone. The header's switch, worn by one card: the
 * same control, so it reads as the same promise, and the only rainbow the calm
 * board lets through besides the header.
 *
 * Shown on and left alone while the board's own switch is on, because then
 * this card goes whatever it says here.
 */
function CardVibes({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const { data: board } = useQuery({ queryKey: ['board'], queryFn: api.board });
  const set = useMutation({
    mutationFn: (vibes: boolean) => api.updateCard(detail.card.id, { vibes }),
    // Returned rather than fired, as in GenerateMockups above.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['board'] });
      return qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
    },
  });
  const everyone = board?.vibes != null;
  const on = everyone || ((set.isPending ? set.variables : undefined) ?? detail.card.vibes);

  return (
    <div className="flex flex-col gap-1">
      <VibesSwitch
        on={on}
        onToggle={() => set.mutate(!on)}
        disabled={everyone || set.isPending}
        className="self-start"
        title={
          everyone ? 'Every card goes while the board is in VIBES MODE'
          : on ?
            'Put the human back in the loop for this card'
          : 'Claude approves, answers and merges this card to main, with nobody reviewing it'
        }
      />
      <span className="font-mono text-[10px]/4 text-(--color-muted)">
        {everyone ?
          'The whole board is in VIBES MODE already'
        : detail.card.repoId === null ?
          'Nothing happens until the card has a repo to run in'
        : 'Only this card moves on its own, all the way to a merged pull request'}
      </span>
      {set.error && <p className="text-sm/5 text-red-300">{set.error.message}</p>}
    </div>
  );
}

function Criteria({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<string | null>(null);
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });

  const add = useMutation({
    mutationFn: (text: string) => api.addCriterion(detail.card.id, text),
    onSuccess: () => { setAdding(null); invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteCriterion(detail.card.id, id),
    onSuccess: invalidate,
  });
  // A real run, but not the card's: the board never shows it, so only the card
  // is refetched. Returned rather than fired, so the button stays pending until
  // the refetch has the new run in it and `suggesting` below takes over —
  // otherwise it would flicker back on for the length of one request.
  const suggest = useMutation({
    mutationFn: () => api.suggestCriteria(detail.card.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['card', detail.card.id] }),
  });

  // Read off the card's runs, newest first, rather than the mutation alone, so
  // closing the modal and opening it again finds the button still busy.
  const last = detail.runs.find((r) => r.task === 'suggest_criteria');
  const suggesting = suggest.isPending || (last !== undefined && !isTerminal(last.status));
  const failure =
    suggest.error?.message ??
    (!suggesting && (last?.status === 'failed' || last?.status === 'interrupted')
      ? `Suggest failed: ${last.errorMessage ?? 'the run was interrupted'}`
      : null);

  // Until Testing has judged something, the list stays as it was drawn before
  // there were verdicts: no mark column, and the footnote saying what's to come.
  // That covers a new card, and a Testing run in progress, which clears them.
  const judged = detail.criteria.some((c) => c.verdict);

  // Evidence often names a screenshot ("Screenshot 'Cart with saved items'
  // shows…"), so it links to it. Only this run's pictures: a failed capture
  // leaves the last run's in place, and they may show something since fixed.
  const shots = detail.assets.filter((a) => a.kind === 'screenshot' && a.label.trim());
  const shotFor = (c: ApiCriterion) => {
    const evidence = c.evidence?.toLowerCase();
    if (!evidence || !c.verifiedRunId) return null;
    // The longest label that fits, so "Cart" never claims "Cart on mobile".
    return (
      shots
        .filter((s) => s.runId === c.verifiedRunId && evidence.includes(s.label.toLowerCase()))
        .sort((a, b) => b.label.length - a.label.length)[0] ?? null
    );
  };
  // An id rather than the asset, so each poll of the card shows the fresh row.
  const [viewing, setViewing] = useState<string | null>(null);
  // Stable, or every poll of the card would re-run the lightbox's effect.
  const close = useCallback(() => setViewing(null), []);
  const shown = detail.assets.find((a) => a.id === viewing) ?? null;

  return (
    <section className="flex flex-col gap-2">
      <SectionHead
        count={detail.criteria.length || undefined}
        aside={
          <div className="flex gap-1.5">
            <SmallButton tone="sky" busy={suggesting} onClick={() => suggest.mutate()}>
              {suggesting ? 'Suggesting…' : 'Suggest'}
            </SmallButton>
            <SmallButton onClick={() => setAdding('')}>Add</SmallButton>
          </div>
        }
      >
        Acceptance criteria
      </SectionHead>

      {detail.criteria.length === 0 && adding === null ? (
        <Empty>Nothing yet. Write what done means, or ask Claude to suggest it.</Empty>
      ) : (
        // Clipped, so a failed first or last row's wash keeps to the corners.
        <ol className="overflow-hidden rounded-md border border-(--color-edge) bg-(--color-ink)">
          {detail.criteria.map((c, i) => (
            <li
              key={c.id}
              className={`group flex items-start gap-3 px-3 py-[7px] not-first:border-t not-first:border-(--color-edge) ${
                c.verdict === 'fail' ? 'bg-red-500/[0.06]' : ''
              }`}
            >
              <span className="w-3 shrink-0 font-mono text-[11px]/5 text-(--color-muted)">{i + 1}</span>
              {judged && <Mark verdict={c.verdict} />}
              {/* min-w-0, or the evidence under it would set the row's width. */}
              <div className="flex min-w-0 grow flex-col">
                <span className="text-sm/5 text-(--color-text)">{c.text}</span>
                {judged && <Evidence criterion={c} shot={shotFor(c)} onView={setViewing} />}
              </div>
              <button
                type="button"
                aria-label={`Remove criterion ${i + 1}`}
                onClick={() => remove.mutate(c.id)}
                className="shrink-0 font-mono text-[11px]/5 text-(--color-muted) opacity-0 group-hover:opacity-100 hover:text-red-300"
              >
                ✕
              </button>
            </li>
          ))}
          {adding !== null && (
            <li className="flex gap-3 px-3 py-[7px] not-first:border-t not-first:border-(--color-edge)">
              <span className="w-3 shrink-0 font-mono text-[11px]/5 text-(--color-muted)">
                {detail.criteria.length + 1}
              </span>
              {/* The mark's width, so what is typed lines up with the text above. */}
              {judged && <span className="w-3 shrink-0" />}
              <form
                className="flex grow gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (adding.trim()) add.mutate(adding.trim());
                }}
              >
                <input
                  autoFocus
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  onBlur={() => !adding.trim() && setAdding(null)}
                  placeholder="Something a person could check off…"
                  className="grow bg-transparent text-sm/5 outline-none placeholder:text-(--color-muted)"
                />
                <SmallButton type="submit" tone="sky" disabled={!adding.trim() || add.isPending}>
                  Add
                </SmallButton>
              </form>
            </li>
          )}
        </ol>
      )}
      {judged ? (
        <Tally criteria={detail.criteria} />
      ) : (
        <span className="font-mono text-[10px]/4 text-(--color-muted)">
          Claude checks each one in Testing and links the evidence here
        </span>
      )}
      {failure && <p className="text-sm/5 text-red-300">{failure}</p>}
      {shown && (
        <Lightbox
          asset={shown}
          kind="Build"
          caption={`${shown.url ?? ''} · ${shown.viewport ?? '?'}px · ${when(shown.createdAt)}`}
          onClose={close}
        />
      )}
    </section>
  );
}

/** Where a person looks first to see what failed, so it has a column of its own. */
function Mark({ verdict }: { verdict: ApiCriterion['verdict'] }) {
  const [glyph, tone, label] =
    verdict === 'pass'
      ? ['✓', 'text-emerald-300', 'Passed']
      : verdict === 'fail'
        ? ['✕', 'text-red-300', 'Failed']
        : ['–', 'text-(--color-muted)', 'Not checked'];
  return (
    <span title={label} className={`w-3 shrink-0 font-mono text-[11px]/5 ${tone}`}>
      {glyph}
    </span>
  );
}

/**
 * What Testing saw, under the criterion rather than beside it. It is free text:
 * a test name, a path with no spaces in it, or a sentence of output. Beside the
 * criterion, the long ones squeezed it to a sliver or ran off the modal, so here
 * it wraps wherever it has to.
 */
function Evidence({ criterion: c, shot, onView }: {
  criterion: ApiCriterion;
  shot: ApiAsset | null;
  onView: (id: string) => void;
}) {
  // Criteria are only unjudged beside judged ones when they were added since
  // the last run, because a run clears every verdict when it starts.
  if (!c.verdict) {
    return (
      <span className="mt-0.5 font-mono text-[11px]/4 text-(--color-muted)">
        Not checked in the last Testing run
      </span>
    );
  }
  if (!c.evidence?.trim()) return null;
  return (
    <p
      className={`mt-0.5 font-mono text-[11px]/4 whitespace-pre-wrap [overflow-wrap:anywhere] ${
        c.verdict === 'pass' ? 'text-(--color-muted)' : 'text-red-300'
      }`}
    >
      {c.evidence.trim()}
      {shot && (
        <>
          {' '}
          <button
            type="button"
            // Safari and Firefox leave a clicked button unfocused, and the
            // lightbox hands focus back to whatever had it.
            onClick={(e) => { e.currentTarget.focus(); onView(shot.id); }}
            className="whitespace-nowrap text-sky-300 hover:underline"
          >
            View screenshot
          </button>
        </>
      )}
    </p>
  );
}

/** The footnote, once there are verdicts to count. A zero is left out rather than coloured. */
function Tally({ criteria }: { criteria: ApiCriterion[] }) {
  const passed = criteria.filter((c) => c.verdict === 'pass').length;
  const failed = criteria.filter((c) => c.verdict === 'fail').length;
  const unchecked = criteria.length - passed - failed;
  const parts = [
    { n: passed, text: 'passed', tone: 'text-emerald-300' },
    { n: failed, text: 'failed', tone: 'text-red-300' },
    { n: unchecked, text: 'not checked', tone: 'text-(--color-muted)' },
  ].filter((p) => p.n > 0);
  return (
    <span className="font-mono text-[10px]/4 text-(--color-muted)">
      {parts.map((p, i) => (
        <span key={p.text}>
          {i > 0 && ' · '}
          <span className={p.tone}>
            {p.n} {p.text}
          </span>
        </span>
      ))}
    </span>
  );
}

function Context({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<string | null>(null);
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
  const add = useMutation({
    // A value that looks like a path is a file; anything else is a link.
    mutationFn: (value: string) =>
      api.addRef(detail.card.id, { kind: /^https?:\/\//.test(value) ? 'url' : 'file', value }),
    onSuccess: () => { setAdding(null); invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRef(detail.card.id, id),
    onSuccess: invalidate,
  });

  return (
    <section className="flex flex-col gap-2">
      <SectionHead
        count={detail.refs.length || undefined}
        aside={<SmallButton onClick={() => setAdding('')}>Add</SmallButton>}
      >
        Context
      </SectionHead>
      {detail.refs.length === 0 && adding === null ? (
        <Empty>Nothing linked yet.</Empty>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {detail.refs.map((r) => (
            <button
              key={r.id}
              type="button"
              title="Remove"
              onClick={() => remove.mutate(r.id)}
              className="hover:opacity-60"
            >
              <Code>{r.label ?? r.value}</Code>
            </button>
          ))}
          {adding !== null && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (adding.trim()) add.mutate(adding.trim());
              }}
            >
              <input
                autoFocus
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                onBlur={() => !adding.trim() && setAdding(null)}
                placeholder="src/cart/CartPage.tsx"
                className="w-56 rounded-sm border border-(--color-edge) bg-(--color-ink) px-1.5 py-px font-mono text-[11px]/4 outline-none placeholder:text-(--color-muted) focus:border-sky-600"
              />
            </form>
          )}
        </div>
      )}
    </section>
  );
}
