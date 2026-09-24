import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STAGES, STAGE_LABELS, isRunnable, type ApiRunSummary, type CardDetail, type Stage } from '@reeve/shared';
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
      <Worktree detail={detail} />
      {detail.checks && <Checks detail={detail} />}
      <Commits detail={detail} />
      <Runs detail={detail} />
      <StageList detail={detail} />
    </aside>
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
    return (
      <section className="flex flex-col gap-2">
        <SectionHead>Worktree</SectionHead>
        <Empty>None yet</Empty>
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
    </section>
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
  // Only fetched once there is a worktree to ask about.
  const { data } = useQuery({
    queryKey: ['commits', detail.card.id],
    queryFn: () => api.commits(detail.card.id),
    enabled: Boolean(detail.worktree.path && detail.worktree.base),
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
