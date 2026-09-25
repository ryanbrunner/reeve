import { useState } from 'react';
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
  return (
    <>
      <Purpose detail={detail} />
      <Criteria detail={detail} />
      <Context detail={detail} />
    </>
  );
}

function Purpose({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: string) => api.updateCard(detail.card.id, { body }),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  return (
    <section className="flex flex-col gap-2">
      <SectionHead
        aside={
          draft === null ? (
            <SmallButton onClick={() => setDraft(detail.card.body)}>Edit</SmallButton>
          ) : (
            <div className="flex gap-1.5">
              <SmallButton onClick={() => setDraft(null)}>Cancel</SmallButton>
              <SmallButton tone="sky" disabled={save.isPending} onClick={() => save.mutate(draft)}>
                {save.isPending ? 'Saving…' : 'Save'}
              </SmallButton>
            </div>
          )
        }
      >
        What this is for
      </SectionHead>
      {draft === null ? (
        detail.card.body.trim() ? (
          <Markdown className="max-w-[40rem]">{detail.card.body}</Markdown>
        ) : (
          <Empty>Nothing written yet.</Empty>
        )
      ) : (
        <textarea
          autoFocus
          rows={4}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="max-w-[40rem] resize-y rounded-md border border-(--color-edge) bg-(--color-ink) p-3 text-sm/5 outline-none focus:border-sky-600"
        />
      )}
    </section>
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
