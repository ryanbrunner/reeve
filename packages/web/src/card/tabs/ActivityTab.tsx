import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { STAGE_LABELS, type ApiCardEvent, type CardDetail, type Stage } from '@reeve/shared';
import { api } from '../../lib/api.js';
import { cost, duration, when } from '../format.js';
import { Empty, SectionHead, SmallButton } from '../ui.js';

type Filter = 'all' | 'runs' | 'human';

/**
 * The card's story, newest first.
 *
 * Deliberately not the run transcript — that is thousands of SDK messages in
 * Claude's vocabulary. This is the handful of moments that would appear in a
 * changelog, in the terms a person tells them: who did what, and when.
 */
export function ActivityTab({ detail }: { detail: CardDetail }) {
  const [filter, setFilter] = useState<Filter>('all');
  const events = detail.events.filter((e) => matches(e, filter));

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <SectionHead count={detail.events.length}>Activity</SectionHead>
        <div role="group" aria-label="Show" className="flex overflow-hidden rounded-md border border-(--color-edge)">
          {([['all', 'All'], ['runs', 'Runs'], ['human', 'Questions and notes']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={`px-2.5 py-1 font-mono text-[11px]/4 not-first:border-l not-first:border-(--color-edge) ${
                filter === id ? 'bg-white/8 text-(--color-text)' : 'text-(--color-muted) hover:text-(--color-text)'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {events.length === 0 ? (
        <Empty>Nothing here yet.</Empty>
      ) : (
        <ol className="flex flex-col gap-3">
          {events.map((e) => (
            <li key={e.id} className="flex gap-3">
              <span className="w-10 shrink-0 pt-px font-mono text-[11px]/5 text-(--color-muted)">
                {when(e.createdAt)}
              </span>
              <div className="flex min-w-0 grow flex-col gap-1">
                <p className="text-sm/5 text-(--color-text)">
                  <span className="font-medium">{e.actor === 'human' ? 'You' : 'Claude'}</span> {sentence(e, detail)}
                </p>
                {e.kind === 'run_finished' && <RunFacts event={e} />}
                {(e.kind === 'answered' || e.kind === 'note') && e.body && (
                  <p className="text-sm/5 text-(--color-muted)">{e.body}</p>
                )}
                {e.kind === 'reviewed' && e.body && <p className="text-sm/5 text-(--color-muted)">{e.body}</p>}
                {e.kind === 'pr_opened' && <PullRequestLink event={e} />}
                {e.kind === 'pr_failed' && e.body && (
                  <p className="font-mono text-[11px]/4 whitespace-pre-wrap text-red-300">{e.body}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <NoteComposer detail={detail} />
    </>
  );
}

function RunFacts({ event }: { event: ApiCardEvent }) {
  const meta = event.meta ?? {};
  const status = String(meta['status'] ?? '');
  const ms = typeof meta['durationMs'] === 'number' ? meta['durationMs'] : null;
  const usd = typeof meta['costUsd'] === 'number' ? meta['costUsd'] : null;
  return (
    <div className="flex flex-wrap items-baseline gap-2 font-mono text-[11px]/4">
      <span
        className={`rounded-sm px-1.5 py-0.5 ${
          status === 'succeeded' ? 'bg-emerald-500/15 text-emerald-300' : status === 'cancelled' ? 'bg-slate-500/15 text-slate-300' : 'bg-red-500/15 text-red-300'
        }`}
      >
        {status === 'succeeded' ? 'done' : status}
      </span>
      {ms !== null && <span className="text-(--color-muted)">{duration(ms)}</span>}
      {usd !== null && <span className="text-(--color-muted)">{cost(usd)}</span>}
      {event.body && <span className="text-red-300">{event.body}</span>}
    </div>
  );
}

function PullRequestLink({ event }: { event: ApiCardEvent }) {
  const url = event.meta?.['url'];
  if (typeof url !== 'string') return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="font-mono text-[11px]/4 text-sky-300 hover:underline">
      {url}
    </a>
  );
}

function NoteComposer({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const add = useMutation({
    mutationFn: (body: string) => api.addNote(detail.card.id, body),
    onSuccess: () => {
      setText('');
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
    },
  });

  return (
    <form
      className="mt-auto flex shrink-0 gap-2 pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) add.mutate(text.trim());
      }}
    >
      <label className="sr-only" htmlFor="card-note">Note for Claude’s next run</label>
      <input
        id="card-note"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Note for Claude’s next run…"
        className="min-w-0 grow rounded-md border border-(--color-edge) bg-(--color-panel) px-3 py-1.5 text-sm/5 outline-none placeholder:text-(--color-muted) focus:border-sky-600"
      />
      <SmallButton type="submit" tone="sky" disabled={!text.trim() || add.isPending}>
        {add.isPending ? 'Adding…' : 'Add note'}
      </SmallButton>
    </form>
  );
}

function matches(e: ApiCardEvent, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'runs') return e.kind === 'run_started' || e.kind === 'run_finished';
  return (
    e.kind === 'answered' || e.kind === 'note' || e.kind === 'question_asked' || e.kind === 'reviewed' ||
    e.kind === 'merged' || e.kind === 'pr_opened' || e.kind === 'pr_failed'
  );
}

/** What the event says, as a sentence following the actor's name. */
function sentence(e: ApiCardEvent, detail: CardDetail): string {
  const stage = (s: Stage | null) => (s ? STAGE_LABELS[s] : 'the board');
  switch (e.kind) {
    case 'created':
      return `added this card to ${stage(e.stage)}`;
    case 'moved':
      return `moved the card to ${stage(e.toStage)}`;
    case 'run_started':
      return `started ${e.meta?.['revision'] ? 'a revision' : `run ${runLabel(detail, e.runId)}`} in ${stage(e.stage)}`;
    case 'run_finished':
      return `finished run ${runLabel(detail, e.runId)} in ${stage(e.stage)}`;
    case 'reviewed':
      return e.meta?.['decision'] === 'approved' ? 'approved the work' : 'sent the work back';
    case 'question_asked':
      return 'asked';
    case 'answered':
      return 'answered';
    case 'note':
      return 'left a note';
    case 'merged': {
      const sha = e.meta?.['sha'];
      const into = e.meta?.['into'];
      return `merged the work into ${typeof into === 'string' ? into : 'the base branch'}` +
        (typeof sha === 'string' ? ` as ${sha.slice(0, 7)}` : '');
    }
    case 'pr_opened': {
      const number = e.meta?.['number'];
      const into = e.meta?.['into'];
      return `${e.meta?.['reused'] ? 'pushed to' : 'opened'} pull request` +
        (typeof number === 'number' ? ` #${number}` : '') +
        ` into ${typeof into === 'string' ? into : 'the base branch'}`;
    }
    case 'pr_failed':
      return 'could not open a pull request';
    case 'archived':
      return 'archived the card';
    case 'restored':
      return `restored the card to ${stage(e.stage)}`;
  }
}

function runLabel(detail: CardDetail, runId: string | null): string {
  if (!runId) return '';
  const claude = detail.runs.filter((r) => r.kind === 'claude');
  const i = claude.findIndex((r) => r.id === runId);
  return i === -1 ? '' : String(claude.length - i);
}
