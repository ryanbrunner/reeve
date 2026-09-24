import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STAGE_LABELS, nextStage, type CardDetail } from '@reeve/shared';
import { api } from '../lib/api.js';
import { Button, Code, SmallButton } from './ui.js';
import { cost, duration, plural } from './format.js';
import type { LiveRun } from './useCardDetail.js';

/**
 * What this card wants from you right now, and the buttons to do it.
 *
 * One band, switched on activity, because the states are mutually exclusive by
 * construction: `needs_input` beats `needs_review` in deriveActivity, so a plan
 * that ended in questions is a question and never also a deliverable. An idle
 * card asks for nothing and the band is absent rather than empty.
 *
 * Done is the exception. Claude never runs there, so a Done card is always
 * idle — and that is exactly when it has one thing left to ask for: a merge.
 */
export function AttentionBand({ detail, live }: { detail: CardDetail; live: LiveRun | null }) {
  const { card } = detail;
  if (card.stage === 'done' && (detail.worktree.path || card.mergedSha)) {
    return (
      <div className="relative mt-3.5 border-t border-(--color-edge) pt-3.5">
        <ReadyToMerge detail={detail} />
      </div>
    );
  }
  if (card.activity === 'idle') return null;

  return (
    <div className="relative mt-3.5 border-t border-(--color-edge) pt-3.5">
      {card.activity === 'needs_input' && <NeedsInput detail={detail} />}
      {card.activity === 'needs_review' && <NeedsReview detail={detail} />}
      {card.activity === 'running' && <Running detail={detail} live={live} />}
      {card.activity === 'error' && <Failed detail={detail} />}
    </div>
  );
}

function NeedsReview({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState<string | null>(null);
  const review = useMutation({
    mutationFn: (v: { decision: 'approved' | 'rejected'; notes?: string }) =>
      api.review(detail.card.id, v.decision, v.notes),
    onSuccess: () => {
      setNotes(null);
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const to = nextStage(detail.card.stage);
  const checks = detail.checks;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4">
        <div className="min-w-0 grow">
          <div className="text-sm/5 font-medium text-(--color-text)">Ready for review</div>
          <p className="mt-0.5 text-sm/5 text-(--color-muted)">
            {checks
              ? `${checks.criteriaVerified} of ${checks.criteriaTotal} acceptance criteria verified` +
                (checks.differenceCount ? `, ${plural(checks.differenceCount, 'difference')} from the mockup` : '') +
                '. '
              : ''}
            {to ? `Approving moves this card to ${STAGE_LABELS[to]}.` : 'This card is at the end of the board.'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {notes === null && <Button onClick={() => setNotes('')}>Leave feedback</Button>}
          <Button
            tone="review"
            disabled={review.isPending}
            onClick={() => review.mutate({ decision: 'approved' })}
          >
            {review.isPending ? 'Working…' : 'Mark reviewed'}
          </Button>
        </div>
      </div>

      {/* The route refuses a rejection without notes — they become the next
          run's prompt — so the button opens the field rather than firing. */}
      {notes !== null && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (notes.trim()) review.mutate({ decision: 'rejected', notes: notes.trim() });
          }}
        >
          <input
            autoFocus
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What needs changing? This becomes Claude's next prompt…"
            className="min-w-0 grow rounded-md border border-(--color-edge) bg-(--color-panel) px-3 py-1.5 text-sm/5 outline-none placeholder:text-(--color-muted) focus:border-sky-600"
          />
          <Button type="submit" disabled={!notes.trim() || review.isPending}>Send back</Button>
          <SmallButton onClick={() => setNotes(null)}>Cancel</SmallButton>
        </form>
      )}
      {review.error && <p className="text-sm/5 text-red-300">{review.error.message}</p>}
    </div>
  );
}

function NeedsInput({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const questions = detail.questions;
  const firstOpen = questions.find((q) => q.answer === null);
  const [selected, setSelected] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  const current = questions.find((q) => q.id === selected) ?? firstOpen ?? questions[0];
  const answered = questions.filter((q) => q.answer !== null).length;

  const answer = useMutation({
    mutationFn: (v: { id: string; text: string }) => api.answerQuestion(detail.card.id, v.id, v.text),
    onSuccess: (res) => {
      setTyped('');
      // Move to whatever is still open, so answering three questions is three
      // clicks and not three clicks plus three navigations.
      setSelected(null);
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      if (res.resumed) void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  if (!current) return <div className="text-sm/5 font-medium">Needs your answer</div>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-sm/5 font-medium text-(--color-text)">Needs your answers</span>
        <div role="group" aria-label="Claude’s questions" className="flex gap-1.5">
          {questions.map((q) => {
            const isCurrent = q.id === current.id;
            const done = q.answer !== null;
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => setSelected(q.id)}
                aria-current={isCurrent ? 'step' : undefined}
                className={`rounded-sm border px-2 py-[3px] font-mono text-[11px]/4 whitespace-nowrap ${
                  isCurrent
                    ? 'border-(--color-activity-input-border) bg-(--color-activity-input-fill) text-amber-100'
                    : done
                      ? 'border-(--color-edge) text-(--color-muted)'
                      : 'border-(--color-edge) text-(--color-text)'
                }`}
              >
                <span className="opacity-70">{q.position}</span> {shortLabel(q.text)}
                {done && ' · answered'}
              </button>
            );
          })}
        </div>
        <div className="grow" />
        <span className="font-mono text-[11px]/4 text-(--color-muted)">
          {answered} of {questions.length} answered · Claude resumes after the last one
        </span>
      </div>

      <p className="text-sm/5 text-(--color-text)">{current.text}</p>

      {current.answer !== null ? (
        <p className="text-sm/5 text-(--color-muted)">
          You answered: <span className="text-(--color-text)">{current.answer}</span>
        </p>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) answer.mutate({ id: current.id, text: typed.trim() });
          }}
        >
          <div className="flex shrink-0 gap-2">
            {current.suggestions.map((s) => (
              <Button key={s} disabled={answer.isPending} onClick={() => answer.mutate({ id: current.id, text: s })}>
                {s}
              </Button>
            ))}
          </div>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Or write your own…"
            aria-label={`Your answer to question ${current.position}`}
            className="min-w-0 grow rounded-md border border-(--color-edge) bg-(--color-panel) px-3 py-1.5 text-sm/5 outline-none placeholder:text-(--color-muted) focus:border-sky-600"
          />
          <Button type="submit" tone="input" disabled={!typed.trim() || answer.isPending}>
            Answer
          </Button>
        </form>
      )}
      {answer.error && <p className="text-sm/5 text-red-300">{answer.error.message}</p>}
      {answer.data?.blocked && (
        <p className="text-sm/5 text-amber-200">
          Answer saved, but Claude could not resume: {answer.data.blocked}
        </p>
      )}
    </div>
  );
}

function Running({ detail, live }: { detail: CardDetail; live: LiveRun | null }) {
  const qc = useQueryClient();
  const run = detail.card.latestRun;
  const stop = useMutation({
    mutationFn: () => api.stopRun(run!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const steps = detail.plan?.steps.length ?? 0;
  const elapsed = live?.elapsedMs ?? (run?.startedAt ? Date.now() - run.startedAt : null);

  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 grow">
        <div className="text-sm/5 font-medium text-(--color-text)">Claude running</div>
        <p className="mt-0.5 truncate text-sm/5 text-(--color-muted)">
          {live?.turns ? `Turn ${live.turns}${steps ? ` of ${steps} steps` : ''}` : 'Starting up'}
          {live?.activity ? ` · ${live.activity}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="font-mono text-[11px]/4 text-(--color-muted)">
          {duration(elapsed)}
          {run?.totalCostUsd != null && ` · ${cost(run.totalCostUsd)} so far`}
        </span>
        <SmallButton disabled={!run || stop.isPending} onClick={() => stop.mutate()}>
          {stop.isPending ? 'Stopping…' : 'Stop'}
        </SmallButton>
      </div>
    </div>
  );
}

function Failed({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const run = detail.card.latestRun;
  const retry = useMutation({
    mutationFn: () => api.startStage(detail.card.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 grow">
        <div className="text-sm/5 font-medium text-(--color-text)">Error</div>
        <p className="mt-0.5 text-sm/5 text-(--color-muted)">
          {run?.errorMessage ?? `The run stopped: ${run?.stopReason ?? 'reason unrecorded'}.`}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button tone="error" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? 'Starting…' : 'Retry'}
        </Button>
      </div>
      {retry.error && <p className="basis-full text-sm/5 text-red-300">{retry.error.message}</p>}
    </div>
  );
}

function ReadyToMerge({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const { card, worktree } = detail;
  // Same key the rail's commit list holds, so this is its cache, not a second call.
  const commits = useQuery({
    queryKey: ['commits', card.id],
    queryFn: () => api.commits(card.id),
    enabled: Boolean(worktree.path && worktree.base) && !card.mergedSha,
  });
  const merge = useMutation({
    mutationFn: () => api.merge(card.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['card', card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
      // Both now read from the squash commit rather than the worktree.
      void qc.invalidateQueries({ queryKey: ['diff', card.id] });
      void qc.invalidateQueries({ queryKey: ['commits', card.id] });
    },
  });

  const base = worktree.baseBranch;

  if (card.mergedSha) {
    return (
      <div className="flex flex-col gap-2">
        <div className="min-w-0">
          <div className="text-sm/5 font-medium text-(--color-text)">
            Merged into {base} as <Code>{card.mergedSha.slice(0, 7)}</Code>
          </div>
          <p className="mt-0.5 text-sm/5 text-(--color-muted)">One commit, titled with this card.</p>
        </div>
        {merge.data?.cleanup && (
          <p className="text-sm/5 text-amber-200">The merge landed, but tidying up after it did not: {merge.data.cleanup}</p>
        )}
      </div>
    );
  }

  const count = commits.data?.length ?? null;
  // Refused here only where the answer is already on screen. Everything the
  // page cannot see — a dirty tree, a conflict — the server says instead.
  const blocked = !worktree.exists
    ? 'The worktree is missing, so there is nothing left to merge.'
    : count === 0
      ? 'No commits on this branch yet. Only committed work is merged.'
      : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4">
        <div className="min-w-0 grow">
          <div className="text-sm/5 font-medium text-(--color-text)">{blocked ? 'Nothing to merge' : 'Ready to merge'}</div>
          <p className="mt-0.5 text-sm/5 text-(--color-muted)">
            {blocked ?? (
              <>
                {count !== null && `${plural(count, 'commit')} on ${worktree.branch ?? 'the branch'}, squashed into one. `}
                {worktree.behind ? `${base} is ${plural(worktree.behind, 'commit')} ahead of it. ` : ''}
                The worktree and branch are removed afterwards.
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button tone="review" disabled={Boolean(blocked) || merge.isPending} onClick={() => merge.mutate()}>
            {merge.isPending ? 'Merging…' : `Squash & merge into ${base}`}
          </Button>
        </div>
      </div>
      {merge.error && <p className="text-sm/5 text-red-300">{merge.error.message}</p>}
    </div>
  );
}

/** A question's pill shows a few words, not the whole question. */
function shortLabel(text: string): string {
  const words = text.replace(/[?.]$/, '').split(/\s+/);
  return words.length <= 3 ? words.join(' ') : `${words.slice(0, 3).join(' ')}…`;
}
