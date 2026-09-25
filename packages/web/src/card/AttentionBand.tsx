import { useLayoutEffect, useRef, useState } from 'react';
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
 * idle — and that is exactly when there is one thing left to say about it:
 * where its pull request is, or why there is not one yet.
 */
export function AttentionBand({ detail, live }: { detail: CardDetail; live: LiveRun | null }) {
  const { card } = detail;
  if (card.stage === 'done' && (detail.worktree.path || card.mergedSha || card.prUrl)) {
    return (
      <div className="relative mt-3.5 border-t border-(--color-edge) pt-3.5">
        <PullRequest detail={detail} />
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
        // One option to a line, so a long one wraps rather than pushing the
        // rest off the band, and Other last as the way out of all of them.
        // Picking an option answers at once, as before.
        <div className="flex flex-col items-start gap-1.5">
          {current.suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={answer.isPending}
              onClick={() => answer.mutate({ id: current.id, text: s })}
              className="max-w-full rounded-md border border-(--color-edge) px-3 py-[5px] text-left text-sm/5 font-medium text-(--color-text) hover:border-slate-600 disabled:opacity-40"
            >
              {s}
            </button>
          ))}
          <form
            className="flex w-full items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) answer.mutate({ id: current.id, text: typed.trim() });
            }}
          >
            <label htmlFor={`answer-${current.id}`} className="shrink-0 text-sm/5 font-medium text-(--color-muted)">
              Other
            </label>
            <input
              id={`answer-${current.id}`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Write your own answer…"
              className="min-w-0 grow rounded-md border border-(--color-edge) bg-(--color-panel) px-3 py-1.5 text-sm/5 outline-none placeholder:text-(--color-muted) focus:border-sky-600"
            />
            <Button type="submit" tone="input" disabled={!typed.trim() || answer.isPending}>
              Answer
            </Button>
          </form>
        </div>
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

  const elapsed = live?.elapsedMs ?? (run?.startedAt ? Date.now() - run.startedAt : null);
  // The stream only knows what happened since the modal opened; the stored
  // thought covers everything before, including while nobody was looking.
  const activity = live?.activity ?? detail.thought?.activity ?? null;
  const thinking = live?.thinking ?? detail.thought?.thinking ?? null;

  return (
    // Top-aligned so a summary growing beneath the status line does not drag
    // the Stop button down with it.
    <div className="flex items-start gap-4">
      <div className="min-w-0 grow">
        <div className="text-sm/5 font-medium text-(--color-text)">Claude running</div>
        <p className="mt-0.5 truncate text-sm/5 text-(--color-muted)">
          {activity ? activity[0]!.toUpperCase() + activity.slice(1) : 'Starting up'}
        </p>
        {thinking && <ThinkingSummary text={thinking} />}
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

/**
 * The latest summary of Claude's reasoning, clamped to three lines.
 *
 * Expanding sticks when a newer summary replaces this one: someone who chose to
 * read in full is likely still reading, and snapping shut on every block would
 * be jumpy. Expanded, it scrolls within a cap rather than pushing the band's
 * header off the modal.
 */
function ThinkingSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  // Measured only while clamped. Expanded, it never overflows the clamp, and
  // measuring then would hide the button that collapses it again.
  useLayoutEffect(() => {
    if (!expanded && ref.current) setOverflows(ref.current.scrollHeight > ref.current.clientHeight);
  }, [text, expanded]);

  return (
    <div className="mt-1.5 flex flex-col items-start gap-1">
      <p
        ref={ref}
        className={`text-sm/5 whitespace-pre-line text-(--color-muted) italic ${
          expanded ? 'max-h-48 overflow-y-auto' : 'line-clamp-3'
        }`}
      >
        {text}
      </p>
      {(expanded || overflows) && (
        <SmallButton aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </SmallButton>
      )}
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

/**
 * Where a Done card's work went. Entering Done pushes the branch and opens a
 * pull request on its own, so this mostly reports: the pull request, whether
 * it has merged, the attempt still under way, or why the last attempt failed —
 * with a button to try again once the cause is put right.
 */
function PullRequest({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const { card, worktree } = detail;
  // Same key the rail's commit list holds, so this is its cache, not a second call.
  const commits = useQuery({
    queryKey: ['commits', card.id],
    queryFn: () => api.commits(card.id),
    enabled: Boolean(worktree.path && worktree.base) && !card.mergedSha,
  });
  const open = useMutation({
    mutationFn: () => api.openPr(card.id),
    // Settled, not succeeded: a failure is written to the card too, and the
    // band reads its reason from there.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['card', card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const base = worktree.baseBranch;

  // From before pull requests replaced the merge. Nothing squash-merges any
  // more, but a card that did still says where it went.
  if (card.mergedSha) {
    return (
      <div className="min-w-0">
        <div className="text-sm/5 font-medium text-(--color-text)">
          Merged into {base} as <Code>{card.mergedSha.slice(0, 7)}</Code>
        </div>
        <p className="mt-0.5 text-sm/5 text-(--color-muted)">One commit, titled with this card.</p>
      </div>
    );
  }

  // Events are newest first, so this is how the latest attempt ended.
  const last = detail.events.find((e) => e.kind === 'pr_opened' || e.kind === 'pr_failed');
  const failure = last?.kind === 'pr_failed' ? (last.body ?? 'reason unrecorded') : null;
  const busy = card.openingPr || open.isPending;
  const count = commits.data?.length ?? null;
  const retry = (label: string) => (
    <Button tone={card.prUrl ? 'plain' : 'review'} disabled={busy || !worktree.exists} onClick={() => open.mutate()}>
      {busy ? 'Pushing…' : label}
    </Button>
  );
  // The same sentence the event holds, so a refusal is said once, not twice.
  const refused = open.error && open.error.message !== failure ? open.error.message : null;

  // Merged on GitHub, which the server notices on its own. There is nothing
  // left to push, so no button: the server would refuse it anyway.
  if (card.prUrl && card.mergedAt != null) {
    const into = detail.events.find((e) => e.kind === 'merged')?.meta?.['into'];
    return (
      <div className="min-w-0">
        <div className="text-sm/5 font-medium text-(--color-text)">
          Pull request{' '}
          <a href={card.prUrl} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
            #{card.prNumber}
          </a>{' '}
          merged into {typeof into === 'string' ? into : base}
        </div>
        <p className="mt-0.5 text-sm/5 text-(--color-muted)">
          Merged on GitHub. The worktree and branch here are left as they were.
        </p>
      </div>
    );
  }

  if (card.prUrl) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-4">
          <div className="min-w-0 grow">
            <div className="text-sm/5 font-medium text-(--color-text)">
              Pull request{' '}
              <a href={card.prUrl} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                #{card.prNumber}
              </a>{' '}
              open against {base}
            </div>
            <p className="mt-0.5 text-sm/5 text-(--color-muted)">
              {busy
                ? 'Pushing the latest commits to it…'
                : 'The worktree and branch stay, for whatever review asks for. Moving the card back into Done pushes again.'}
            </p>
          </div>
          {failure && !busy && <div className="flex shrink-0 gap-2">{retry('Push again')}</div>}
        </div>
        {failure && !busy && <p className="text-sm/5 text-amber-200">The last push did not reach it: {failure}</p>}
        {refused && <p className="text-sm/5 text-red-300">{refused}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4">
        <div className="min-w-0 grow">
          <div className="text-sm/5 font-medium text-(--color-text)">
            {busy ? 'Opening a pull request' : failure ? 'No pull request yet' : 'Ready for a pull request'}
          </div>
          <p className="mt-0.5 text-sm/5 text-(--color-muted)">
            {busy
              ? `Pushing ${worktree.branch ?? 'the branch'} to origin, then asking GitHub for a pull request into ${base}.`
              : !worktree.exists
                ? 'The worktree is missing, so there is nothing left to push.'
                : (
                  <>
                    {count !== null && `${plural(count, 'commit')} on ${worktree.branch ?? 'the branch'}. `}
                    Only committed work is pushed, as a pull request into {base}.
                  </>
                )}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">{retry('Open pull request')}</div>
      </div>
      {failure && !busy && <p className="text-sm/5 text-red-300">{failure}</p>}
      {refused && <p className="text-sm/5 text-red-300">{refused}</p>}
    </div>
  );
}

/** A question's pill shows a few words, not the whole question. */
function shortLabel(text: string): string {
  const words = text.replace(/[?.]$/, '').split(/\s+/);
  return words.length <= 3 ? words.join(' ') : `${words.slice(0, 3).join(' ')}…`;
}
