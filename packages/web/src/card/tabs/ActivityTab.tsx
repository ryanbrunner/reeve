import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { STAGE_LABELS, type ApiCardEvent, type ApiToolDenial, type CardDetail, type Stage } from '@reeve/shared';
import { api } from '../../lib/api.js';
import { duration, tok, tokenTitle, when } from '../format.js';
import { Empty, SectionHead, SmallButton } from '../ui.js';

type Filter = 'all' | 'runs' | 'human';

/**
 * The card's story, newest first.
 *
 * Deliberately not the run transcript — that is thousands of SDK messages in
 * Claude's vocabulary. This is the handful of moments that would appear in a
 * changelog, in the terms a person tells them: who did what, and when. In
 * VIBES MODE, only that it happened: no run's status, time or tokens.
 */
export function ActivityTab({ detail, vibes = false }: { detail: CardDetail; vibes?: boolean }) {
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
                {e.kind === 'run_finished' && !vibes && <RunFacts event={e} detail={detail} />}
                {(e.kind === 'answered' || e.kind === 'note') && e.body && (
                  <p className="text-sm/5 text-(--color-muted)">{e.body}</p>
                )}
                {/* Line breaks kept: feedback from Crit or Gloss is one paragraph per comment. */}
                {(e.kind === 'reviewed' || e.kind === 'crit_reviewed' || e.kind === 'gloss_reviewed') && e.body && (
                  <p className="text-sm/5 whitespace-pre-line text-(--color-muted)">{e.body}</p>
                )}
                {(e.kind === 'pr_opened' || e.kind === 'merged') && <PullRequestLink event={e} />}
                {(e.kind === 'pr_failed' || e.kind === 'conflicts_failed' || e.kind === 'conflicts_refused' || e.kind === 'merge_failed') && e.body && (
                  <p className="font-mono text-[11px]/4 whitespace-pre-wrap text-red-300">{e.body}</p>
                )}
                {e.kind === 'conflicts_resolved' && <Resolution event={e} />}
              </div>
            </li>
          ))}
        </ol>
      )}

      <NoteComposer detail={detail} />
    </>
  );
}

function RunFacts({ event, detail }: { event: ApiCardEvent; detail: CardDetail }) {
  const meta = event.meta ?? {};
  const status = String(meta['status'] ?? '');
  const ms = typeof meta['durationMs'] === 'number' ? meta['durationMs'] : null;
  // Both read off the run rather than the event, so runs that finished before
  // anyone thought to show them get them too — the denials and the SDK's usage
  // were always recorded.
  const run = detail.runs.find((r) => r.id === event.runId);
  const denied = run?.deniedToolUses ?? [];
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
      {run?.totalTokens != null && (
        <span title={tokenTitle(run.tokenBreakdown)} className="whitespace-nowrap text-(--color-muted)">
          {tok(run.totalTokens)}
        </span>
      )}
      {/* A succeeded run that was refused its tools still reads as success
          everywhere else. This is the only place that says otherwise, so it
          carries the commands themselves rather than just a count. */}
      {denied.length > 0 && (
        <span
          className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-amber-300"
          title={`Refused, so this run did not do them:\n${denied.map(asked).join('\n')}`}
        >
          {denied.length} denied
        </span>
      )}
      {event.body && <span className="text-red-300">{event.body}</span>}
    </div>
  );
}

/** One denied call, for the tooltip: the command if there was one, else the tool. */
function asked(d: ApiToolDenial): string {
  return d.detail ? `${d.tool}: ${d.detail}` : d.tool;
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

/**
 * What Claude decided, file by file. The merge reached the pull request with
 * nobody looking at it first, so this is where a person finds out what it was.
 */
function Resolution({ event }: { event: ApiCardEvent }) {
  const meta = event.meta ?? {};
  const files = Array.isArray(meta['files']) ? (meta['files'] as Array<{ path?: unknown; resolution?: unknown }>) : [];
  const concerns = Array.isArray(meta['concerns']) ? meta['concerns'].filter((c) => typeof c === 'string') : [];
  return (
    <>
      {event.body && <p className="text-sm/5 text-(--color-muted)">{event.body}</p>}
      {meta['testsPassed'] === false && (
        <p className="text-sm/5 text-amber-200">Pushed with the tests failing.</p>
      )}
      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map((f, i) => (
            <li key={i} className="text-sm/5 text-(--color-muted)">
              <code className="font-mono text-[11px]/4 text-(--color-text)">{String(f.path ?? '')}</code>{' '}
              {String(f.resolution ?? '')}
            </li>
          ))}
        </ul>
      )}
      {concerns.map((c, i) => (
        <p key={i} className="text-sm/5 text-amber-200">{c}</p>
      ))}
    </>
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
    e.kind === 'crit_reviewed' || e.kind === 'gloss_reviewed' || e.kind === 'merged' || e.kind === 'pr_opened' || e.kind === 'pr_failed' ||
    e.kind === 'conflicts_resolved' || e.kind === 'conflicts_failed' || e.kind === 'conflicts_refused' || e.kind === 'merge_failed' ||
    e.kind === 'suggestion_accepted'
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
      if (e.meta?.['via'] === 'crit') {
        return e.meta?.['decision'] === 'approved' ? 'approved the plan in Crit' : 'sent the plan back from Crit';
      }
      if (e.meta?.['via'] === 'gloss') {
        return e.meta?.['decision'] === 'approved' ? 'approved the build in Gloss' : 'sent the build back from Gloss';
      }
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
      const number = e.meta?.['number'];
      // A number means it merged as a pull request on GitHub, not a squash here.
      return `merged ${typeof number === 'number' ? `pull request #${number}` : 'the work'}` +
        ` into ${typeof into === 'string' ? into : 'the base branch'}` +
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
      return e.meta?.['reason'] === 'merged' ? 'archived the card once it had merged'
        : e.meta?.['reason'] === 'project' ? 'archived the card with its project'
        : e.meta?.['rejectedSuggestion'] ? 'rejected the suggestion'
        : 'archived the card';
    case 'suggestion_accepted':
      return 'accepted the suggestion';
    case 'left_project': {
      // Named from the event: the card no longer points at the project.
      const title = e.meta?.['projectTitle'];
      return `moved the card to No project when ${typeof title === 'string' ? title : 'its project'} was archived`;
    }
    case 'restored':
      return `restored the card to ${stage(e.stage)}`;
    case 'handed_off':
      return `handed off to Claude Code in ${stage(e.stage)}`;
    case 'crit_reviewed': {
      const outcome = e.meta?.['outcome'];
      return outcome === 'cancelled' ? 'stopped a review in Crit'
        : outcome === 'not_applied' ? 'finished a review in Crit that was not applied'
        : 'could not finish a review in Crit';
    }
    case 'gloss_reviewed': {
      // `ended` is a loop that stopped after a round was applied: the revision
      // came back with questions, or not at all, rather than ready for review.
      const outcome = e.meta?.['outcome'];
      return outcome === 'cancelled' ? 'stopped a review in Gloss'
        : outcome === 'not_applied' ? 'finished a round in Gloss that was not applied'
        : outcome === 'ended' ? 'ended a review in Gloss after a revision'
        : 'could not finish a round in Gloss';
    }
    case 'conflicts_resolved': {
      const base = typeof e.meta?.['base'] === 'string' ? e.meta['base'] : 'the base branch';
      const number = e.meta?.['number'];
      const pr = typeof number === 'number' ? `pull request #${number}` : 'the pull request';
      // Clean means GitHub's verdict was stale and no run was needed.
      return e.meta?.['clean']
        ? `merged ${base} into the branch and pushed it to ${pr}`
        : `resolved the conflicts with ${base} and pushed the merge to ${pr}`;
    }
    case 'conflicts_failed':
      return 'could not resolve the conflicts';
    case 'conflicts_refused':
      return 'could not even start resolving the conflicts';
    case 'merge_failed': {
      const number = e.meta?.['number'];
      return `could not merge ${typeof number === 'number' ? `pull request #${number}` : 'the pull request'}`;
    }
    case 'worktree_removed':
      // Forced means work nobody committed went with it, which is worth saying
      // where someone looking for it would look.
      return (e.meta?.['reason'] === 'archived' ? 'removed the worktree once the card was archived' : 'removed the worktree') +
        (e.meta?.['forced'] ? ' with uncommitted changes' : '');
  }
}

function runLabel(detail: CardDetail, runId: string | null): string {
  if (!runId) return '';
  const claude = detail.runs.filter((r) => r.kind === 'claude');
  const i = claude.findIndex((r) => r.id === runId);
  return i === -1 ? '' : String(claude.length - i);
}
