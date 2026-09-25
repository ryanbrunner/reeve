import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  STAGES,
  STAGE_LABELS,
  isRunnable,
  needsWorktree,
  type ApiRunSummary,
  type CardDetail,
  type Stage,
} from '@reeve/shared';
import { api, cardsIn } from '../lib/api.js';
import { cost, duration, when } from './format.js';
import { Empty, Fact, SectionHead, SmallButton } from './ui.js';

/**
 * The card's machine facts, down the right-hand side.
 *
 * Everything here is mono and quiet, and almost all of it is key-and-value:
 * these are things the system knows rather than things a person wrote, and
 * they should read as reference rather than as prose.
 */
export function Rail({ detail }: { detail: CardDetail }) {
  return (
    <aside
      aria-label="Card facts"
      className="flex w-[300px] shrink-0 flex-col gap-[18px] overflow-y-auto border-l border-(--color-edge) p-4"
    >
      <Project detail={detail} />
      <Worktree detail={detail} />
      {detail.checks && <Checks detail={detail} />}
      <Commits detail={detail} />
      <Runs detail={detail} />
      <StageList detail={detail} />
    </aside>
  );
}

/**
 * Which repo this card's work happens in.
 *
 * First in the rail because everything under it depends on the answer: with no
 * project there is no `repoPath`, so there is no worktree, and with no worktree
 * Claude has nowhere to run. A card filed from the header without one lands
 * here to be adopted.
 *
 * Buttons rather than a dropdown, for the same reason `StageList` uses them:
 * this is a short list of named places, and seeing the other ones is most of
 * the value of showing it at all.
 */
function Project({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  // Same key the board is already holding, so this is the cache rather than a
  // second request — and an observer rather than a `getQueryData` peek, so the
  // list still fills in for a card opened by link before the board has landed.
  const { data } = useQuery({ queryKey: ['board'], queryFn: api.board });
  const projects = data?.repos ?? [];
  const assign = useMutation({
    mutationFn: (projectId: string) => api.updateCard(detail.card.id, { repoId: projectId }),
    onSuccess: () => {
      // The chip in the header comes from the card, the swim lane from the
      // board. Both move on this one click.
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  // The branch and the directory on disk belong to the repo they were cut from,
  // so once there is a tree the answer is settled. The server refuses this too.
  const settled = Boolean(detail.worktree.path);

  return (
    <section className="flex flex-col gap-2">
      <SectionHead>Project</SectionHead>
      {projects.length === 0 ?
        <Empty>No projects yet</Empty>
      : <div role="group" aria-label="File the card under a project" className="-mx-1.5 flex flex-col">
          {projects.map((p) => {
            const here = p.id === detail.card.repoId;
            return (
              <button
                key={p.id}
                type="button"
                disabled={here || settled || assign.isPending}
                aria-current={here ? 'true' : undefined}
                onClick={() => assign.mutate(p.id)}
                className={`flex w-full items-center gap-2 rounded-sm border px-1.5 py-0.5 text-left font-mono text-[11px]/[18px] disabled:cursor-default ${
                  here ?
                    'border-(--color-edge) bg-white/4 font-medium text-(--color-text)'
                  : `border-transparent text-(--color-muted) ${settled ? 'opacity-40' : 'hover:border-(--color-edge) hover:bg-white/4'}`
                }`}
              >
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: p.laneColor ?? '#3f4754' }}
                />
                <span className="min-w-0 truncate">{p.name}</span>
              </button>
            );
          })}
        </div>
      }
      {!detail.card.repoId && !settled && projects.length > 0 && (
        <p className="font-mono text-[10px]/4 text-(--color-muted)">
          Unfiled — pick a repo before starting a stage.
        </p>
      )}
      {settled && (
        <p className="font-mono text-[10px]/4 text-(--color-muted)">
          Fixed by the worktree. Remove it to move the card.
        </p>
      )}
      {assign.error && <p className="font-mono text-[10px]/4 text-red-300">{assign.error.message}</p>}
    </section>
  );
}

function Worktree({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const { worktree } = detail;
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
    void qc.invalidateQueries({ queryKey: ['board'] });
  };
  const start = useMutation({ mutationFn: () => api.startServer(detail.card.id), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => api.stopServer(detail.card.id), onSuccess: invalidate });

  if (!worktree.path) {
    const merged = detail.card.mergedSha;
    return (
      <section className="flex flex-col gap-2">
        <SectionHead>Worktree</SectionHead>
        {merged ? (
          <div className="flex flex-col">
            <Fact label="Merged as">{merged.slice(0, 7)}</Fact>
            <Fact label="Into">{worktree.baseBranch}</Fact>
          </div>
        ) : (
          <Empty>None yet</Empty>
        )}
        <Handoff detail={detail} />
      </section>
    );
  }

  const server = worktree.server;
  return (
    <section className="flex flex-col gap-2">
      <SectionHead>Worktree</SectionHead>
      <div className="flex items-center gap-2">
        <span className="inline-block rounded-sm bg-slate-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-slate-300">
          {!worktree.exists ? 'missing' : server?.running ? 'running' : server ? 'stopped' : 'idle'}
        </span>
        {server?.since && (
          <span className="font-mono text-[11px]/4 text-(--color-muted)">
            {server.running ? 'since' : 'last'} {when(server.since)}
          </span>
        )}
      </div>

      <div className="flex flex-col">
        <Fact label="URL">
          {server?.running && server.url ? (
            <a href={server.url} target="_blank" rel="noreferrer" className="text-sky-300 no-underline">
              {server.url.replace(/^https?:\/\//, '')}
            </a>
          ) : (
            '—'
          )}
        </Fact>
        <Fact label="Branch">{worktree.branch ?? '—'}</Fact>
        <Fact label="Base">
          {worktree.baseBranch}
          {worktree.behind ? ` · ${worktree.behind} behind` : worktree.behind === 0 ? ' · up to date' : ''}
        </Fact>
        <Fact label="Path">{worktree.path.replace(/^\/Users\/[^/]+/, '~')}</Fact>
      </div>

      {/* The server's error is the one thing here that is worth its own space:
          "port 5174 is in use" is the whole reason a card went red. */}
      {server?.errorMessage && (
        <pre className="overflow-x-auto rounded-sm border border-(--color-edge) bg-(--color-ink) p-2 font-mono text-[10px]/4 whitespace-pre-wrap text-red-300">
          {server.errorMessage}
        </pre>
      )}

      <div className="flex flex-wrap gap-1.5">
        {server?.running ? (
          <>
            <SmallButton tone="sky" onClick={() => server.url && window.open(server.url, '_blank')}>
              Open preview
            </SmallButton>
            <SmallButton disabled={stop.isPending} onClick={() => stop.mutate()}>
              {stop.isPending ? 'Stopping…' : 'Stop'}
            </SmallButton>
          </>
        ) : (
          <SmallButton tone="sky" disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? 'Starting…' : 'Start server'}
          </SmallButton>
        )}
      </div>
      {(start.error ?? stop.error) && (
        <p className="font-mono text-[10px]/4 text-red-300">{(start.error ?? stop.error)!.message}</p>
      )}
      <Handoff detail={detail} />
    </section>
  );
}

/**
 * Take the card into Claude Code in a terminal, for work that needs a person
 * sitting with it rather than another unattended run.
 *
 * The server writes the context into the worktree and answers with a short
 * command; this copies it and also shows it. The clipboard only exists in a
 * secure context, so over a LAN address the text on screen is the only copy.
 */
function Handoff({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const handoff = useMutation({
    mutationFn: () => api.handoff(detail.card.id),
    onMutate: () => setCopied(false),
    onSuccess: ({ command }) => {
      // In `onSuccess` rather than the mutation: the file and the event exist by
      // now, and a refused clipboard must not read as a failed handoff.
      navigator.clipboard?.writeText(command).then(() => setCopied(true), () => {});
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
    },
  });

  const { card, worktree } = detail;
  if (card.stage === 'done') return null;
  const blocked =
    !needsWorktree(card.stage) ? 'Move to Planning to get a worktree'
    : !worktree.path ? 'Start the stage first. Its worktree is made then.'
    : !worktree.exists ? 'The worktree is missing from disk.'
    : card.activity === 'running' ? 'Claude is working here. Stop the run before taking over.'
    : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        <SmallButton disabled={Boolean(blocked) || handoff.isPending} onClick={() => handoff.mutate()}>
          {handoff.isPending ? 'Writing handoff…' : 'Hand off to Claude Code'}
        </SmallButton>
      </div>
      {blocked && <p className="font-mono text-[10px]/4 text-(--color-muted)">{blocked}</p>}
      {!blocked && handoff.data && (
        <>
          <p className="font-mono text-[10px]/4 text-(--color-muted)">
            {copied ? 'Copied. Paste it into a terminal:' : 'Paste this into a terminal:'}
          </p>
          <pre className="overflow-x-auto rounded-sm border border-(--color-edge) bg-(--color-ink) p-2 font-mono text-[10px]/4 break-all whitespace-pre-wrap text-(--color-text) select-all">
            {handoff.data.command}
          </pre>
        </>
      )}
      {handoff.error && <p className="font-mono text-[10px]/4 text-red-300">{handoff.error.message}</p>}
    </div>
  );
}

function Checks({ detail }: { detail: CardDetail }) {
  const c = detail.checks!;
  const runNumber = runIndex(detail.runs, c.runId);
  return (
    <section className="flex flex-col gap-2">
      <SectionHead aside={<span className="font-mono text-[11px]/4 text-(--color-muted)">run {runNumber}</span>}>
        Checks
      </SectionHead>
      <div className="flex flex-col">
        <Fact label="Acceptance criteria">
          {c.criteriaTotal ? `${c.criteriaVerified} of ${c.criteriaTotal} verified` : 'none written'}
        </Fact>
        {detail.assets.some((a) => a.kind === 'mockup') && (
          <Fact label="Mockup">
            {c.differenceCount === 0 ? 'matches' : `${c.differenceCount} difference${c.differenceCount === 1 ? '' : 's'}`}
          </Fact>
        )}
        <Fact label="Tests">{c.passed ? 'passed' : `${c.failures.length} failing`}</Fact>
      </div>
    </section>
  );
}

function Commits({ detail }: { detail: CardDetail }) {
  // Only fetched once there is a worktree to ask about, or a merge to read.
  const { data } = useQuery({
    queryKey: ['commits', detail.card.id],
    queryFn: () => api.commits(detail.card.id),
    enabled: Boolean((detail.worktree.path && detail.worktree.base) || detail.card.mergedSha),
  });
  if (!data?.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <SectionHead count={data.length}>Commits</SectionHead>
      <div className="flex flex-col">
        {data.map((c) => (
          <div key={c.sha} className="flex items-baseline gap-2 font-mono text-[11px]/[18px]">
            <span className="shrink-0 text-(--color-muted)">{c.sha}</span>
            <span className="min-w-0 truncate text-(--color-text)">{c.subject}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Runs({ detail }: { detail: CardDetail }) {
  const runs = detail.runs.filter((r) => r.kind === 'claude');
  const spent = runs.reduce((n, r) => n + (r.totalCostUsd ?? 0), 0);
  return (
    <section className="flex flex-col gap-2">
      <SectionHead
        aside={runs.length ? <span className="font-mono text-[11px]/4 text-(--color-muted)">{cost(spent)}</span> : null}
      >
        Runs
      </SectionHead>
      {runs.length === 0 ? (
        <Empty>None yet</Empty>
      ) : (
        <div className="flex flex-col">
          {runs.map((r) => (
            <div
              key={r.id}
              className="grid grid-cols-[18px_minmax(0,1fr)_auto_auto] gap-2 font-mono text-[11px]/[18px]"
            >
              <span className="text-(--color-muted)">{runIndex(detail.runs, r.id)}</span>
              <span className="truncate text-(--color-text)">
                {STAGE_LABELS[r.stage]} · {r.status}
              </span>
              <span className="text-(--color-muted)">
                {duration(r.startedAt && r.finishedAt ? r.finishedAt - r.startedAt : null)}
              </span>
              <span className="min-w-[40px] text-right text-(--color-muted)">{cost(r.totalCostUsd)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Where the card has been, and where it can go.
 *
 * Clicking a stage moves the card, which is the same human action as a drag —
 * appended to the end of that column, because the choice being made here is
 * the column and not the slot within it.
 */
function StageList({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const board = qc.getQueryData<{ cards: Parameters<typeof cardsIn>[0] }>(['board']);
  const move = useMutation({
    mutationFn: (stage: Stage) =>
      api.moveCard(detail.card.id, {
        stage,
        index: board ? cardsIn(board.cards, stage).filter((c) => c.id !== detail.card.id).length : 0,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  return (
    <section className="flex flex-col gap-2">
      <SectionHead>Stage</SectionHead>
      <div role="group" aria-label="Move the card to a stage" className="-mx-1.5 flex flex-col">
        {STAGES.map((stage) => {
          const here = stage === detail.card.stage;
          const entered = detail.stageHistory[stage];
          return (
            <button
              key={stage}
              type="button"
              disabled={here || move.isPending}
              aria-current={here ? 'step' : undefined}
              onClick={() => move.mutate(stage)}
              className={`flex w-full items-center justify-between gap-2 rounded-sm border px-1.5 py-0.5 text-left font-mono text-[11px]/[18px] ${
                here
                  ? 'border-(--color-edge) bg-white/4 text-(--color-text)'
                  : 'border-transparent text-(--color-muted) hover:border-(--color-edge) hover:bg-white/4'
              }`}
            >
              <span className={here ? 'font-medium' : ''}>
                {STAGE_LABELS[stage]}
                {isRunnable(stage) && <span title="Claude runs here" className="ml-1 text-[10px] text-sky-500">◆</span>}
              </span>
              <span>{entered ? (here ? `since ${when(entered)}` : when(entered)) : ''}</span>
            </button>
          );
        })}
      </div>
      {move.error && <p className="font-mono text-[10px]/4 text-red-300">{move.error.message}</p>}
    </section>
  );
}

/** Runs are numbered as a person counts them: oldest is 1. */
function runIndex(runs: ApiRunSummary[], runId: string): number {
  const claude = runs.filter((r) => r.kind === 'claude');
  return claude.length - claude.findIndex((r) => r.id === runId);
}
