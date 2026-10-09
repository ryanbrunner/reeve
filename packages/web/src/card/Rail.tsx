import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  STAGES,
  STAGE_LABELS,
  blockedMoveRefusal,
  isRunnable,
  needsWorktree,
  stageEntryRefusal,
  type ApiCard,
  type ApiRunSummary,
  type CardDetail,
  type EffortLevel,
  type Stage,
} from '@reeve/shared';
import { api, cardsIn } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';
import { Dropdown } from '../lib/Dropdown.js';
import { effortLevelsFor, findModel, keepEffort, modelOptions } from '../lib/models.js';
import { duration, sumTokens, tok, tokenTitle, when } from './format.js';
import { Empty, Fact, SectionHead, SmallButton } from './ui.js';

/**
 * The card's machine facts, down the right-hand side.
 *
 * Everything here is mono and quiet, and almost all of it is key-and-value:
 * these are things the system knows rather than things a person wrote, and
 * they should read as reference rather than as prose.
 */
export function Rail({ detail, onOpen, embedded = false }: {
  detail: CardDetail;
  onOpen: (id: string) => void;
  /** Inside the conversation's side panel, as its Card tab, rather than a column of its own. */
  embedded?: boolean;
}) {
  return (
    <aside
      aria-label="Card facts"
      className={embedded
        ? 'flex flex-col gap-[18px]'
        : 'flex w-[300px] shrink-0 flex-col gap-[18px] overflow-y-auto border-l border-(--color-edge) p-4'}
    >
      <Repo detail={detail} />
      <Dependencies detail={detail} onOpen={onOpen} />
      <Suggestions detail={detail} onOpen={onOpen} />
      <Model detail={detail} />
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
 * repo there is no `repoPath`, so there is no worktree, and with no worktree
 * Claude has nowhere to run. A card filed from the header without one lands
 * here to be adopted.
 *
 * Buttons rather than a dropdown, for the same reason `StageList` uses them:
 * this is a short list of named places, and seeing the other ones is most of
 * the value of showing it at all.
 */
function Repo({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  // Same key the board is already holding, so this is the cache rather than a
  // second request — and an observer rather than a `getQueryData` peek, so the
  // list still fills in for a card opened by link before the board has landed.
  const { data } = useQuery({ queryKey: ['board'], queryFn: api.board });
  const repos = data?.repos ?? [];
  const assign = useMutation({
    mutationFn: (repoId: string) => api.updateCard(detail.card.id, { repoId }),
    onSuccess: () => {
      // The chip in the header comes from the card, the swim lane from the
      // board. Both move on this one click.
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  // The branch and the directory on disk belong to the repo they were cut from,
  // so once there is a tree the answer is settled. So is a merged card's, whose
  // branch outlives its tree and is read from that repo. The server refuses both.
  const settled = Boolean(detail.worktree.path || (detail.card.mergedAt != null && detail.worktree.branch));

  return (
    <section className="flex flex-col gap-2">
      <SectionHead>Repo</SectionHead>
      {repos.length === 0 ?
        <Empty>No repos yet</Empty>
      : <div role="group" aria-label="File the card under a repo" className="-mx-1.5 flex flex-col">
          {repos.map((p) => {
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
      {!detail.card.repoId && !settled && repos.length > 0 && (
        <p className="font-mono text-[10px]/4 text-(--color-muted)">
          Unfiled — pick a repo before starting a stage.
        </p>
      )}
      {settled && (
        <p className="font-mono text-[10px]/4 text-(--color-muted)">
          {detail.worktree.path ? 'Fixed by the worktree. Remove it to move the card.' : 'Fixed by the merged branch.'}
        </p>
      )}
      {assign.error && <p className="font-mono text-[10px]/4 text-red-300">{assign.error.message}</p>}
    </section>
  );
}

/** A rail dropdown's trigger: the width of the rail, on the ink like its other fields. */
const FIELD = 'w-full rounded-sm bg-(--color-ink) px-1.5 py-1 text-(--color-text)';

/**
 * The tasks this card depends on, and the ones that depend on it.
 *
 * Each opens in this card's place, the way a project's tasks do. The linked
 * cards come off the detail rather than the board because the board has no
 * archived cards, and a dependency that merged and left is still one. The
 * picker is the board's cards, though: something to start depending on now
 * has to be live.
 */
function Dependencies({ detail, onOpen }: { detail: CardDetail; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['board'], queryFn: api.board });
  const invalidate = () => {
    // Every card detail rather than this one's: the card at the other end of
    // the link has just gained or lost a dependent.
    void qc.invalidateQueries({ queryKey: ['card'] });
    void qc.invalidateQueries({ queryKey: ['board'] });
  };
  const add = useMutation({
    mutationFn: (dependsOnId: string) => api.addDependency(detail.card.id, { dependsOnId }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (dependsOnId: string) => api.removeDependency(detail.card.id, dependsOnId),
    onSuccess: invalidate,
  });

  const { dependsOn, dependents } = detail.dependencies;
  const groups = byRepo(pickable(data?.cards ?? [], detail.card));
  const error = add.error ?? remove.error;

  return (
    <>
      <section className="flex flex-col gap-2">
        <SectionHead count={dependsOn.length || undefined}>Depends on</SectionHead>
        {dependsOn.length > 0 && (
          <div className="-mx-1.5 flex flex-col">
            {dependsOn.map((c) => (
              <LinkedCard
                key={c.id}
                card={c}
                onOpen={onOpen}
                onRemove={() => !remove.isPending && remove.mutate(c.id)}
              />
            ))}
          </div>
        )}
        {/* Nothing is ever picked here, so it always reads as the prompt: a
            card picked moves up into the list above. Searchable, because this
            is every task on the board. */}
        <Dropdown
          label="Add a card this one depends on"
          value=""
          placeholder={groups.length ? 'Add a dependency…' : 'No other cards to depend on'}
          searchable
          disabled={add.isPending || groups.length === 0}
          options={groups.map(([repo, cards]) => ({
            group: repo,
            options: cards.map((c) => ({
              value: c.id,
              label: `#${c.number} ${c.title}`,
              color: c.laneColor ?? '#3f4754',
              hint: STAGE_LABELS[c.stage],
            })),
          }))}
          onChange={(id) => add.mutate(id)}
          className={FIELD}
        />
        {error && <p className="font-mono text-[10px]/4 text-red-300">{error.message}</p>}
      </section>
      {dependents.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionHead count={dependents.length}>Needed by</SectionHead>
          <div className="-mx-1.5 flex flex-col">
            {dependents.map((c) => (
              <LinkedCard key={c.id} card={c} onOpen={onOpen} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/**
 * The card whose run suggested this one, and the cards this one's runs
 * suggested. Read-only, unlike dependencies above it: a run made these links
 * and nothing a person does changes them, so there is no picker and no ✕.
 * Each still opens in this card's place.
 */
function Suggestions({ detail, onOpen }: { detail: CardDetail; onOpen: (id: string) => void }) {
  const { suggestedBy, suggested } = detail.suggestions;
  if (!suggestedBy && suggested.length === 0) return null;
  const label = 'font-mono text-[10px]/4 text-(--color-muted)';
  return (
    <section className="flex flex-col gap-2">
      <SectionHead>Suggestions</SectionHead>
      {suggestedBy && (
        <div className="flex flex-col gap-1">
          <p className={label}>Suggested by</p>
          <div className="-mx-1.5 flex flex-col">
            <LinkedCard card={suggestedBy} onOpen={onOpen} />
          </div>
        </div>
      )}
      {suggested.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className={label}>Suggested · {suggested.length}</p>
          <div className="-mx-1.5 flex flex-col">
            {suggested.map((c) => (
              <LinkedCard key={c.id} card={c} onOpen={onOpen} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** One linked card: its repo's colour, `#number`, title, and where it has got to. */
function LinkedCard({ card, onOpen, onRemove }: {
  card: ApiCard;
  onOpen: (id: string) => void;
  /** Only on this card's own dependencies. A dependent's link is removed from that card. */
  onRemove?: () => void;
}) {
  return (
    <div className="group flex items-center gap-1">
      <button
        type="button"
        onClick={() => onOpen(card.id)}
        title={card.repoName ? `${card.repoName} #${card.number}` : undefined}
        className="flex min-w-0 grow items-center gap-2 rounded-sm border border-transparent px-1.5 py-0.5 text-left font-mono text-[11px]/[18px] hover:border-(--color-edge) hover:bg-white/4"
      >
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: card.laneColor ?? '#3f4754' }}
        />
        <span className="shrink-0 text-(--color-muted)">#{card.number}</span>
        <span className="min-w-0 grow truncate text-(--color-text)">{card.title}</span>
        <span className="shrink-0 text-(--color-muted)">
          {card.archivedAt ? 'archived' : STAGE_LABELS[card.stage]}
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`Stop depending on #${card.number}`}
          onClick={onRemove}
          className="shrink-0 px-1 font-mono text-[11px]/[18px] text-(--color-muted) opacity-0 group-hover:opacity-100 hover:text-red-300 focus:opacity-100"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/**
 * What this card could depend on: every task on the board but itself and the
 * ones it already depends on, less any that already depend on it however
 * indirectly. The server would refuse those as a cycle, so they are not
 * offered. The board only knows live cards, so a loop through an archived one
 * is left to that refusal, which says why.
 */
function pickable(cards: ApiCard[], card: ApiCard): ApiCard[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const excluded = new Set([card.id, ...card.dependsOn.map((d) => d.id)]);
  // A for-of visits what is pushed onto the array mid-loop, so it is the queue too.
  const waiting = [...card.dependents];
  for (const id of waiting) {
    if (excluded.has(id)) continue;
    excluded.add(id);
    waiting.push(...(byId.get(id)?.dependents ?? []));
  }
  return cards.filter((c) => !excluded.has(c.id));
}

/** Grouped under their repo's name, since `#number` only means something within one. */
function byRepo(cards: ApiCard[]): Array<[string, ApiCard[]]> {
  const groups = new Map<string, ApiCard[]>();
  const sorted = [...cards].sort(
    (a, b) => (a.repoName ?? '').localeCompare(b.repoName ?? '') || a.number - b.number,
  );
  for (const c of sorted) {
    const repo = c.repoName ?? 'No repo';
    groups.set(repo, [...(groups.get(repo) ?? []), c]);
  }
  return [...groups];
}

/**
 * Which model this card's runs use, and how hard they think.
 *
 * One override for every stage, above the Settings default for each: a card
 * that needs Opus needs it for the plan and the build alike. Suggest is left
 * out — it is a cheap aside, not the card's work — and says so, since a person
 * who has just picked Opus here would otherwise expect it everywhere.
 */
function Model({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: Infinity });
  const models = data?.models ?? [];
  const { model, effort } = detail.card;
  const set = useMutation({
    mutationFn: (body: { model?: string | null; effort?: EffortLevel | null }) => api.updateCard(detail.card.id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });
  const levels = effortLevelsFor(models, model);

  return (
    <section className="flex flex-col gap-2">
      <SectionHead>Model</SectionHead>
      <div className="flex flex-col gap-1.5">
        <Dropdown
          label="Model for this card's runs"
          value={model ?? ''}
          disabled={set.isPending}
          options={[{ value: '', label: 'Settings default' }, ...modelOptions(models, model)]}
          onChange={(v) => {
            const next = v || null;
            set.mutate({ model: next, effort: keepEffort(models, next, effort) });
          }}
          className={FIELD}
        />
        <Dropdown
          label="Effort for this card's runs"
          value={effort ?? ''}
          disabled={set.isPending || levels.length === 0}
          options={[
            { value: '', label: levels.length === 0 ? 'No effort on this model' : 'Settings default' },
            ...levels.map((l) => ({ value: l, label: l })),
          ]}
          onChange={(v) => set.mutate({ effort: (v || null) as EffortLevel | null })}
          className={FIELD}
        />
      </div>
      <p className="font-mono text-[10px]/4 text-(--color-muted)">
        For Planning, In Progress and Testing. Suggest keeps its own.
      </p>
      {set.error && <p className="font-mono text-[10px]/4 text-red-300">{set.error.message}</p>}
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
    const { mergedSha: merged, prUrl, prNumber } = detail.card;
    // Newest first, so this is why the tree went last. The branch outlives it.
    const removed = detail.events.find((e) => e.kind === 'worktree_removed');
    return (
      <section className="flex flex-col gap-2">
        <SectionHead>Worktree</SectionHead>
        {merged ? (
          <div className="flex flex-col">
            <Fact label="Merged as" copy={merged} copyLabel="commit">
              {merged.slice(0, 7)}
            </Fact>
            <Fact label="Into" copy={worktree.baseBranch} copyLabel="base branch">
              {worktree.baseBranch}
            </Fact>
          </div>
        ) : worktree.branch ? (
          <>
            <div className="flex items-center gap-2">
              <span className="inline-block rounded-sm bg-slate-500/15 px-1.5 py-0.5 font-mono text-[10px]/4 text-slate-300">
                {removed?.meta?.['reason'] === 'archived' ? 'removed on archive' : 'removed'}
              </span>
              {removed && <span className="font-mono text-[11px]/4 text-(--color-muted)">{when(removed.createdAt)}</span>}
            </div>
            <div className="flex flex-col">
              <Fact label="Branch" copy={worktree.branch}>{worktree.branch}</Fact>
              <Fact label="Base" copy={worktree.baseBranch} copyLabel="base branch">{worktree.baseBranch}</Fact>
              {prUrl && (
                <Fact label="Pull request">
                  <a href={prUrl} target="_blank" rel="noreferrer" className="text-sky-300 no-underline">
                    #{prNumber}
                  </a>
                </Fact>
              )}
            </div>
          </>
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

      {/* Each copies what a person would paste, not what fits in the rail: the
          whole path, since `~` means nothing to half the tools it lands in,
          and the base without how far behind it is. The URL stays a link,
          because opening the preview is what it is for. */}
      <div className="flex flex-col">
        <Fact label="URL">
          {/* Only an address something vouched for. A server that has not
              printed one yet is not at the port Reeve offered it, necessarily. */}
          {server?.running && server.url ? (
            <a href={server.url} target="_blank" rel="noreferrer" className="text-sky-300 no-underline">
              {server.url.replace(/^https?:\/\//, '')}
            </a>
          ) : server?.running ? (
            <span className="text-(--color-muted)">waiting for the server to print its URL</span>
          ) : (
            '—'
          )}
        </Fact>
        <Fact label="Branch" copy={worktree.branch ?? undefined}>
          {worktree.branch ?? '—'}
        </Fact>
        <Fact label="Base" copy={worktree.baseBranch} copyLabel="base branch">
          {worktree.baseBranch}
          {worktree.behind ? ` · ${worktree.behind} behind` : worktree.behind === 0 ? ' · up to date' : ''}
        </Fact>
        <Fact label="Path" copy={worktree.path}>
          {worktree.path.replace(/^\/Users\/[^/]+/, '~')}
        </Fact>
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
            <SmallButton
              tone="sky"
              disabled={!server.url}
              onClick={() => server.url && window.open(server.url, '_blank')}
            >
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
      void copyText(command).then((ok) => ok && setCopied(true));
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
    },
  });

  const { card, worktree } = detail;
  if (card.stage === 'done') return null;
  const blocked =
    !needsWorktree(card.stage) ? 'Move to Planning to get a worktree'
    // Restored after its worktree was removed: starting it is refused too.
    : !worktree.path && card.mergedAt != null ? 'Merged, and its worktree has been removed.'
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
  // Only fetched once there is a worktree to ask about, the branch one left
  // behind, or a merge to read.
  const { worktree } = detail;
  const { data } = useQuery({
    queryKey: ['commits', detail.card.id],
    queryFn: () => api.commits(detail.card.id),
    enabled: Boolean(((worktree.path || worktree.branch) && worktree.base) || detail.card.mergedSha),
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
  const { data } = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: Infinity });
  const models = data?.models ?? [];
  const runs = detail.runs.filter((r) => r.kind === 'claude');
  // The same sum the header shows, so the two totals can never disagree.
  const spent = sumTokens(runs);
  return (
    <section className="flex flex-col gap-2">
      <SectionHead
        aside={
          spent ? (
            <span title={tokenTitle(spent.breakdown)} className="font-mono text-[11px]/4 text-(--color-muted)">
              {tok(spent.total)}
            </span>
          ) : null
        }
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
              <span className="min-w-0">
                <span className="block truncate text-(--color-text)">
                  {STAGE_LABELS[r.stage]} · {r.status}
                </span>
                {/* What the run was actually sent, so two attempts that differ
                    only in model can be told apart. Null is the CLI's default. */}
                {(r.model || r.effort) && (
                  <span className="block truncate text-(--color-muted)">
                    {r.model ? (findModel(models, r.model)?.displayName ?? r.model) : 'default model'}
                    {r.effort && ` · ${r.effort}`}
                  </span>
                )}
              </span>
              <span className="text-(--color-muted)">
                {duration(r.startedAt && r.finishedAt ? r.finishedAt - r.startedAt : null)}
              </span>
              <span title={tokenTitle(r.tokenBreakdown)} className="min-w-[40px] text-right whitespace-nowrap text-(--color-muted)">
                {tok(r.totalTokens)}
              </span>
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
 * the column and not the slot within it. Testing and Done stay shut until the
 * card has been implemented, and every stage but Backlog while it waits on a
 * card that has not cleared, both of which the server enforces too.
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
          // The server's own sentences, so the button never offers a move that
          // would come back as an error. `detail.card.dependsOn`, not
          // `detail.dependencies`: only the links carry the server's `done`.
          const refusal =
            stageEntryRefusal(detail.card.stage, stage, detail.card.implemented) ??
            blockedMoveRefusal(detail.card.stage, stage, detail.card.dependsOn);
          const button = (
            <button
              key={stage}
              type="button"
              disabled={here || refusal !== null || move.isPending}
              aria-current={here ? 'step' : undefined}
              onClick={() => move.mutate(stage)}
              className={`flex w-full items-center justify-between gap-2 rounded-sm border px-1.5 py-0.5 text-left font-mono text-[11px]/[18px] ${
                here ? 'border-(--color-edge) bg-white/4 text-(--color-text)'
                : refusal ? 'pointer-events-none cursor-not-allowed border-transparent text-(--color-muted) opacity-50'
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
          // A disabled button does not reliably get hover in every browser, so
          // the reason sits on a wrapper that does.
          return refusal ?
              <div key={stage} title={refusal} className="cursor-not-allowed">
                {button}
              </div>
            : button;
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
