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
import { TasksTab } from './tabs/TasksTab.js';

type TabId = 'brief' | 'tasks' | 'plan' | 'changes' | 'diff' | 'preview' | 'activity';

/**
 * The card's six readings, left to right in the order the work happens. A
 * project has three: its brief, the tasks it was split into, and its history.
 *
 * Each tab's count is the one number that says whether it is worth opening —
 * how many criteria, which plan version, how many files changed — and is
 * absent rather than zero when there is nothing there yet.
 *
 * In VIBES MODE there are four: what was asked, what was planned, what it looks
 * like and that things happened. What actually changed is not yours to see.
 */
export function Tabs({ detail, onOpen, vibes = false }: {
  detail: CardDetail;
  onOpen: (id: string) => void;
  vibes?: boolean;
}) {
  const project = detail.card.kind === 'project';
  // Open on whatever this card is currently about. A card in Testing wants its
  // preview; one in Backlog has only a brief.
  const [chosen, setTab] = useState<TabId>(() => defaultTab(detail, vibes));

  // Shells out to git, but fetched for any card that has a worktree rather than
  // only while the Diff tab is open: the tab's own count comes out of it, and a
  // count that only becomes true after you click is worse than no count. A
  // card whose worktree has been removed still has its branch, and an old
  // squash-merged card its commit, and the server reads the diff from either.
  // Not at all in VIBES MODE, where there is no tab to show it in.
  const { worktree } = detail;
  const diff = useQuery({
    queryKey: ['diff', detail.card.id],
    queryFn: () => api.diff(detail.card.id),
    enabled: Boolean(worktree.path || (worktree.branch && worktree.base) || detail.card.mergedSha) && !vibes,
  });
  // The board already holds every task, so the Tasks tab reads them from there
  // rather than asking for them again.
  const board = useQuery({ queryKey: ['board'], queryFn: api.board, enabled: project });
  const tasks = board.data?.cards.filter((c) => c.projectId === detail.card.id) ?? [];

  const shots = detail.assets.filter((a) => a.kind === 'screenshot');
  const all: Array<{ id: TabId; label: string; count?: string | number }> = project ? [
    { id: 'brief', label: 'Brief' },
    { id: 'tasks', label: 'Tasks', count: tasks.length || undefined },
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
    { id: 'activity', label: 'Activity', count: detail.events.length || undefined },
  ];
  const tabs = vibes ? all.filter((t) => t.id !== 'changes' && t.id !== 'diff') : all;
  // Derived rather than reset, so a card left open on Diff when VIBES MODE
  // comes on shows something real, and goes back to Diff when it goes off.
  const tab = tabs.some((t) => t.id === chosen) ? chosen : defaultTab(detail, vibes);

  return (
    <div className="flex min-w-0 grow flex-col">
      <div role="tablist" aria-label="Card details" className="flex shrink-0 gap-[22px] border-b border-(--color-edge) px-5">
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
      </div>

      {/* Scrolls: the artboards are fixed-size canvases, a real card is not. */}
      <div role="tabpanel" className="flex min-h-0 grow flex-col gap-[18px] overflow-y-auto p-5">
        {tab === 'brief' && <BriefTab detail={detail} />}
        {tab === 'tasks' && <TasksTab tasks={tasks} loading={board.isLoading} onOpen={onOpen} />}
        {tab === 'plan' && <PlanTab detail={detail} />}
        {tab === 'changes' && <ChangesTab detail={detail} />}
        {tab === 'diff' && <DiffTab detail={detail} diff={diff.data ?? null} loading={diff.isLoading} />}
        {tab === 'preview' && <PreviewTab detail={detail} />}
        {tab === 'activity' && <ActivityTab detail={detail} vibes={vibes} />}
      </div>
    </div>
  );
}

function defaultTab(detail: CardDetail, vibes: boolean): TabId {
  if (detail.card.kind === 'project') return 'brief';
  if (detail.card.activity === 'needs_input') return 'plan';
  const shots = detail.assets.some((a) => a.kind === 'screenshot');
  // Claude's notes once it has written them; until then — a card still running
  // — the diff is the only account of the work there is. In VIBES MODE neither
  // is on offer, so the work is whatever it looks like, or failing that, what
  // was asked for.
  const work: TabId = vibes ? (shots ? 'preview' : 'brief') : detail.implementation ? 'changes' : 'diff';
  switch (detail.card.stage) {
    case 'planning': return 'plan';
    case 'in_progress': return work;
    case 'testing': return shots ? 'preview' : work;
    case 'done': return work;
    default: return 'brief';
  }
}
