import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isTerminal, type CardDetail } from '@reeve/shared';
import critMark from '../assets/crit.png';
import { api } from '../lib/api.js';
import { SmallButton } from './ui.js';

/**
 * Reviewing the work in the tools made for it, wherever there is work to
 * review: Crit for the plan once there is one and for the changes once the
 * branch has commits, Gloss for the build once Claude has submitted one and
 * the repo can serve it. What comes back from either goes into the card's
 * conversation as the person's own words; see crit.ts and gloss.ts.
 *
 * One component for every tab that shows them, so each tool is offered,
 * refused and shown open by the same rule wherever it appears.
 */
export type ReviewTool = 'crit-plan' | 'crit-changes' | 'gloss';

export function ReviewTools({ detail, tools }: { detail: CardDetail; tools: ReviewTool[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {tools.map((t) => (t === 'gloss' ? <Gloss key={t} detail={detail} /> : <Crit key={t} detail={detail} target={t === 'crit-plan' ? 'plan' : 'changes'} />))}
    </div>
  );
}

function Tile({ mark, name, children, note }: { mark: React.ReactNode; name: string; children: React.ReactNode; note: React.ReactNode }) {
  return (
    <div className="flex min-w-[170px] flex-1 flex-col gap-1.5 rounded-lg border border-(--color-edge) bg-(--color-panel) px-3 py-2.5">
      <div className="flex items-center gap-2 text-sm/5 font-medium">
        {mark}
        {name}
      </div>
      <p className="text-[12.5px]/[17px] text-(--color-muted)">{note}</p>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

const CritMark = () => <img src={critMark} alt="" aria-hidden="true" className="size-[18px] rounded" />;

/** Gloss's own G◆ glyph: its assets/gloss-glyph-dark.svg, in Reeve's ink and sky. */
const GlossMark = () => (
  <svg viewBox="15 12 34 40" width="14" height="16" aria-hidden="true" className="mx-0.5">
    <path d="M49 12v11H29a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h20a11 11 0 0 1-11 11H29a14 14 0 0 1-14-14V26a14 14 0 0 1 14-14z" fill="#e6edf3" />
    <path d="M42 25l7 7-7 7-7-7z" fill="#00a6f4" />
  </svg>
);

/** The board does not poll, so a review ending — which may approve and move the card — is passed on. */
function useEndRefresh(live: boolean) {
  const qc = useQueryClient();
  const was = useRef(live);
  useEffect(() => {
    if (was.current && !live) void qc.invalidateQueries({ queryKey: ['board'] });
    was.current = live;
  }, [live, qc]);
}

function Crit({ detail, target }: { detail: CardDetail; target: 'plan' | 'changes' }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
  const open = useMutation({ mutationFn: () => api.reviewWithCrit(detail.card.id, target), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: (runId: string) => api.stopRun(runId), onSuccess: invalidate });
  // One Crit review runs at a time per card, whichever it is of.
  const last = detail.runs.find((r) => r.task === 'crit_review');
  const live = last && !isTerminal(last.status) ? last : null;
  useEndRefresh(Boolean(live));

  const { card, worktree } = detail;
  const commits = useQuery({
    queryKey: ['commits', card.id],
    queryFn: () => api.commits(card.id),
    enabled: target === 'changes' && Boolean(worktree.path),
  });
  const blocked =
    !worktree.path || !worktree.exists ? 'The worktree is missing from disk.'
    : target === 'plan' && !detail.plan ? 'There is no plan yet.'
    : target === 'changes' && !commits.data?.length ? 'The branch has no commits of its own yet.'
    : null;
  const href = !live ? null
    : open.data?.runId === live.id && open.data.url ? open.data.url
    : live.port ? `http://127.0.0.1:${live.port}`
    : null;
  const error = open.error ?? stop.error;
  const what = target === 'plan' ? 'the plan' : 'the changes';

  return (
    <Tile
      mark={<CritMark />}
      name={target === 'plan' ? 'Crit · plan' : 'Crit · changes'}
      note={error ? <span className="text-red-300">{error.message}</span>
        : live ? 'Open in your browser. Your comments arrive in the conversation; finishing with none approves the stage when it is waiting.'
        : blocked ?? `Comment on ${what} line by line. Your comments arrive in the conversation.`}
    >
      {live ? (
        <>
          {href ? (
            <a href={href} target="_blank" rel="noreferrer" className="font-mono text-[11px]/4 text-sky-300 no-underline hover:underline">Open in Crit</a>
          ) : null}
          <SmallButton busy={stop.isPending} onClick={() => stop.mutate(live.id)}>{stop.isPending ? 'Stopping…' : 'Stop'}</SmallButton>
        </>
      ) : (
        <SmallButton tone="sky" disabled={Boolean(blocked)} busy={open.isPending} onClick={() => open.mutate()}>
          {open.isPending ? 'Opening Crit…' : target === 'plan' ? 'Review the plan' : 'Review the changes'}
        </SmallButton>
      )}
    </Tile>
  );
}

function Gloss({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
  const open = useMutation({ mutationFn: () => api.reviewWithGloss(detail.card.id), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: (runId: string) => api.stopRun(runId), onSuccess: invalidate });
  const { data: board } = useQuery({ queryKey: ['board'], queryFn: api.board });
  const repo = board?.repos.find((r) => r.id === detail.card.repoId);
  const last = detail.runs.find((r) => r.task === 'gloss_review');
  const live = last && !isTerminal(last.status) ? last : null;
  useEndRefresh(Boolean(live));

  const { card, worktree } = detail;
  const submitted = detail.runs.some((r) => r.kind === 'claude' && r.task === null && r.stage === card.stage && r.status === 'succeeded');
  const blocked =
    repo && !repo.serverCommand ? 'The repo has no server command, so there is no app to open. Add one in Settings.'
    : !worktree.path || !worktree.exists ? 'The worktree is missing from disk.'
    : card.stage !== 'in_progress' && card.stage !== 'testing' && card.stage !== 'release' ? 'There is no build until In Progress.'
    : card.activity === 'running' ? 'Claude is working. Review once it has submitted.'
    : !submitted ? 'Claude has not submitted a build in this stage yet.'
    : null;
  const error = open.error ?? stop.error;

  return (
    <Tile
      mark={<GlossMark />}
      name="Gloss"
      note={error ? <span className="text-red-300">{error.message}</span>
        : live ? 'Open in its own window. Submit sends your comments to Claude, and the window reloads once it is done; Approve approves the build.'
        : blocked ?? 'Use the running build and leave feedback on the page. It arrives in the conversation.'}
    >
      {live ? (
        <SmallButton busy={stop.isPending} onClick={() => stop.mutate(live.id)}>{stop.isPending ? 'Stopping…' : 'Stop'}</SmallButton>
      ) : (
        <SmallButton tone="sky" disabled={Boolean(blocked)} busy={open.isPending} onClick={() => open.mutate()}>
          {open.isPending ? 'Opening Gloss…' : 'Open in Gloss'}
        </SmallButton>
      )}
    </Tile>
  );
}
