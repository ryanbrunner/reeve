import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CardDetail } from '@reeve/shared';
import { api } from '../lib/api.js';
import { ActivityTab } from './tabs/ActivityTab.js';
import { BriefTab } from './tabs/BriefTab.js';
import { ChangesTab } from './tabs/ChangesTab.js';
import { DiffTab } from './tabs/DiffTab.js';
import { PlanTab } from './tabs/PlanTab.js';
import { PreviewTab } from './tabs/PreviewTab.js';
import { ReleaseTab } from './tabs/ReleaseTab.js';
import { TasksTab } from './tabs/TasksTab.js';
import { Rail } from './Rail.js';
import { ReviewTools, type ReviewTool } from './ReviewTools.js';

/** The review tools at the head of each side tab: what that tab shows is what they review. */
const TOOLS: Partial<Record<TabId, ReviewTool[]>> = {
  plan: ['crit-plan'],
  changes: ['crit-changes', 'gloss'],
  diff: ['crit-changes'],
  preview: ['gloss'],
  release: ['crit-changes', 'gloss'],
};

export type TabId = 'brief' | 'tasks' | 'plan' | 'changes' | 'diff' | 'preview' | 'release' | 'activity' | 'card';

/**
 * The card's six readings, left to right in the order the work happens. A
 * project has three: its brief, the tasks it was split into, and its history.
 *
 * Each tab's count is the one number that says whether it is worth opening —
 * how many criteria, which plan version, how many files changed — and is
 * absent rather than zero when there is nothing there yet.
 *
 * In VIBES MODE there are four: what was asked, what Claude says it did, what
 * it looks like and that things happened. What was planned and the diff
 * itself — what actually changed — are not yours to see.
 */
export function Tabs({ detail, onOpen, vibes = false, side = false, tab: controlled, onTab, onCollapse }: {
  detail: CardDetail;
  onOpen: (id: string) => void;
  vibes?: boolean;
  /**
   * Beside the conversation rather than the whole card: the documents a
   * stage produced, and the rail's facts as a Card tab of their own. Here the
   * conversation is the card, and these are what you open from it.
   */
  side?: boolean;
  /** Which tab is open, when the conversation opens one from a submission. */
  tab?: TabId;
  onTab?: (t: TabId) => void;
  onCollapse?: () => void;
}) {
  const project = detail.card.kind === 'project';
  // Open on whatever this card is currently about. A card in Testing wants its
  // preview; one in Backlog has only a brief.
  const [own, setOwn] = useState<TabId>(() => defaultTab(detail, vibes));
  const chosen = controlled ?? own;
  const setTab = (t: TabId) => (onTab ? onTab(t) : setOwn(t));

  // Shells out to git, but fetched for any card that has a worktree rather than
  // only while the Diff tab is open: the tab's own count comes out of it, and a
  // count that only becomes true after you click is worse than no count. A
  // card whose worktree has been removed still has its branch, and an old
  // squash-merged card its commit, and the server reads the diff from either.
  // Not at all in VIBES MODE, where the Diff tab is withheld but the Changes
  // tab's own notes come from the implementation record, not from here.
  const { worktree } = detail;
  const diff = useQuery({
    queryKey: ['diff', detail.card.id],
    queryFn: () => api.diff(detail.card.id),
    enabled: Boolean(worktree.path || (worktree.branch && worktree.base) || detail.card.mergedSha) && !vibes,
  });
  // The board already holds every task, so the Tasks tab reads them from there
  // rather than asking for them again. It holds the live ones only: those the
  // sweep archived after they finished are a count on the project's lane, and
  // the tab counts them too, or a project whose work had all merged would
  // open on nothing. The lane's count comes first, since it arrives in the
  // same response as the live cards: the detail polls slowly when idle, and
  // read alone it would lag each task the sweep took off the board, so Release
  // would dip until it caught up. An archived project has no lane, and its
  // count comes off the detail instead.
  const board = useQuery({ queryKey: ['board'], queryFn: api.board, enabled: project });
  const tasks = board.data?.cards.filter((c) => c.projectId === detail.card.id) ?? [];
  const archivedDone =
    board.data?.projects.find((p) => p.id === detail.card.id)?.archivedDoneCount ?? detail.archivedDoneCount;

  const shots = detail.assets.filter((a) => a.kind === 'screenshot');
  const all: Array<{ id: TabId; label: string; count?: string | number }> = project ? [
    { id: 'brief', label: 'Brief' },
    { id: 'tasks', label: 'Tasks', count: tasks.length + archivedDone || undefined },
    { id: 'activity', label: 'Activity', count: detail.events.length || undefined },
  ] : [
    { id: 'brief', label: 'Brief', count: detail.criteria.length || undefined },
    { id: 'plan', label: 'Plan', count: detail.plan ? `v${detail.plan.version}` : undefined },
    { id: 'changes', label: 'Changes' },
    {
      id: 'diff',
      label: 'Diff',
      // git's count once we have it, Claude's claim until then. They can
      // disagree — Claude reports what it meant to change — and when they do,
      // the number beside the tab must not contradict the list inside it.
      count: diff.data?.files.length ?? detail.implementation?.filesChanged.length ?? undefined,
    },
    { id: 'preview', label: 'Preview', count: shots.length || undefined },
    // Only once a card has reached Release: before that there is nothing to say about its pull request.
    ...(detail.card.stage === 'release' || detail.release ? [{ id: 'release' as const, label: 'Release' }] : []),
    { id: 'activity', label: 'Activity', count: detail.events.length || undefined },
  ];
  // Beside the conversation the stage's documents come first, the brief after
  // them, and the rail's facts last.
  const sideTabs: typeof all = side
    ? [...all.filter((t) => t.id !== 'brief' && t.id !== 'activity'), all.find((t) => t.id === 'brief')!, { id: 'activity', label: 'Activity' }, { id: 'card', label: 'Card' }]
    : all;
  const tabs = vibes ? sideTabs.filter((t) => t.id !== 'plan' && t.id !== 'diff') : sideTabs;
  // Derived rather than reset, so a card left open on Diff when VIBES MODE
  // comes on shows something real, and goes back to Diff when it goes off.
  const tab = tabs.some((t) => t.id === chosen) ? chosen : defaultTab(detail, vibes);

  return (
    <div className="flex min-w-0 grow flex-col">
      <div role="tablist" aria-label="Card details" className={`flex shrink-0 border-b border-(--color-edge) ${side ? 'gap-3.5 overflow-x-auto pr-2 pl-4 [scrollbar-width:none]' : 'gap-[22px] px-5'}`}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-baseline gap-1.5 border-b-2 pt-3 pb-2.5 font-mono text-[11px]/4 font-medium tracking-[0.06em] uppercase ${
              tab === t.id
                ? 'border-sky-600 text-(--color-text)'
                : 'border-transparent text-(--color-muted) hover:text-(--color-text)'
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-muted)/60 normal-case">
                {t.count}
              </span>
            )}
          </button>
        ))}
        {onCollapse && (
          <>
            <span className="grow" />
            <button
              type="button"
              title="Hide the panel"
              aria-label="Hide the panel"
              onClick={onCollapse}
              className="my-auto grid size-[22px] shrink-0 place-items-center rounded font-mono text-[13px] text-(--color-muted) hover:bg-(--color-edge)/60 hover:text-(--color-text)"
            >
              ⇥
            </button>
          </>
        )}
      </div>

      {/* Scrolls: the artboards are fixed-size canvases, a real card is not. */}
      <div role="tabpanel" className={`flex min-h-0 grow flex-col gap-[18px] overflow-y-auto ${side ? 'p-4' : 'p-5'}`}>
        {side && !vibes && TOOLS[tab] && <ReviewTools detail={detail} tools={TOOLS[tab]!} />}
        {tab === 'brief' && <BriefTab detail={detail} />}
        {tab === 'tasks' && <TasksTab tasks={tasks} archivedDone={archivedDone} loading={board.isLoading} onOpen={onOpen} />}
        {tab === 'plan' && <PlanTab detail={detail} />}
        {tab === 'changes' && <ChangesTab detail={detail} />}
        {tab === 'diff' && <DiffTab detail={detail} diff={diff.data ?? null} loading={diff.isLoading} />}
        {tab === 'preview' && <PreviewTab detail={detail} vibes={vibes} />}
        {tab === 'release' && <ReleaseTab detail={detail} />}
        {tab === 'activity' && <ActivityTab detail={detail} vibes={vibes} />}
        {tab === 'card' && <Rail detail={detail} onOpen={onOpen} embedded />}
      </div>
    </div>
  );
}

export function defaultTab(detail: CardDetail, vibes: boolean): TabId {
  if (detail.card.kind === 'project') return 'brief';
  if (detail.card.activity === 'needs_input') return vibes ? 'brief' : 'plan';
  const shots = detail.assets.some((a) => a.kind === 'screenshot');
  // Claude's notes once it has written them, in either mode; until then — a
  // card still running — the diff is the only account of the work there is,
  // but VIBES MODE never offers it, so there the work is whatever it looks
  // like, or failing that, what was asked for.
  const work: TabId = detail.implementation ? 'changes' : vibes ? (shots ? 'preview' : 'brief') : 'diff';
  switch (detail.card.stage) {
    // In VIBES MODE there is no plan to open; Planning looks like Brief until
    // it has something else to show.
    case 'planning': return vibes ? work : 'plan';
    case 'in_progress': return work;
    case 'testing': return shots ? 'preview' : work;
    case 'release': return detail.release ? 'release' : work;
    default: return 'brief';
  }
}
