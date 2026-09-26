import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isTerminal, type CardDetail } from '@reeve/shared';
import { api } from '../../lib/api.js';
import { Markdown } from '../Markdown.js';
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
 * The field's own look, worn by the textarea and — when nothing is written yet —
 * by the empty box standing in for it, so clicking one doesn't change the shape
 * of the other.
 */
const FIELD =
  'max-w-[40rem] rounded-md border border-(--color-edge) bg-(--color-ink) p-3 text-sm/5 outline-none focus:border-sky-600';

function Purpose({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const noun = detail.card.kind === 'project' ? 'project' : 'card';
  const prompt = `What is this ${noun} for?`;
  const save = useMutation({
    mutationFn: (body: string) => api.updateCard(detail.card.id, { body }),
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: ['board'] });
      await qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      setDraft(null);
    },
  });

  // Clicking the text is what edits it, except where the click meant something
  // else: following a link, or finishing a selection to copy.
  const edit = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a')) return;
    if (window.getSelection()?.toString()) return;
    setDraft(detail.card.body);
  };
  // Enter on the field itself, not on a link inside it.
  const open = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) setDraft(detail.card.body);
  };

  // Blur is the save — and Escape blurs (see CardModal), so it saves too. The
  // draft stays up until the save lands, rather than flashing the old body.
  const commit = () => {
    if (draft === null) return;
    if (draft === detail.card.body) setDraft(null);
    else save.mutate(draft);
  };

  return (
    <section className="flex flex-col gap-2">
      {draft !== null ? (
        <textarea
          autoFocus
          rows={4}
          value={draft}
          disabled={save.isPending}
          placeholder={prompt}
          // The heading used to name this field. Nothing else does now, and a
          // placeholder stops naming it the moment there is something in it.
          aria-label={`What this ${noun} is for`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          className={`${FIELD} resize-y placeholder:text-(--color-muted)`}
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
          // 6.625rem is the textarea's four rows, padding and border, so the
          // box does not change height the moment it becomes one.
          className={`${FIELD} min-h-[6.625rem] cursor-text text-(--color-muted) hover:border-slate-600`}
        >
          {prompt}
        </div>
      )}
      {save.error && <p className="text-sm/5 text-red-300">{save.error.message}</p>}
      {/* A project is never planned, so it has no mockups to draw. */}
      {detail.card.kind === 'task' && <GenerateMockups detail={detail} />}
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
        <ol className="rounded-md border border-(--color-edge) bg-(--color-ink)">
          {detail.criteria.map((c, i) => (
            <li
              key={c.id}
              className="group flex gap-3 px-3 py-[7px] not-first:border-t not-first:border-(--color-edge)"
            >
              <span className="w-3 shrink-0 font-mono text-[11px]/5 text-(--color-muted)">{i + 1}</span>
              <span className="grow text-sm/5 text-(--color-text)">{c.text}</span>
              {/* A verdict, once Testing has reached this one. */}
              {c.verdict && (
                <span
                  title={c.evidence ?? undefined}
                  className={`shrink-0 font-mono text-[11px]/5 ${
                    c.verdict === 'pass' ? 'text-emerald-300' : 'text-red-300'
                  }`}
                >
                  {c.verdict === 'pass' ? '✓' : '✕'} {c.evidence}
                </span>
              )}
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
      <span className="font-mono text-[10px]/4 text-(--color-muted)">
        Claude checks each one in Testing and links the evidence here
      </span>
      {failure && <p className="text-sm/5 text-red-300">{failure}</p>}
    </section>
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
