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

type TabId = 'brief' | 'plan' | 'changes' | 'diff' | 'preview' | 'activity';

/**
 * The card's six readings, left to right in the order the work happens.
 *
 * Each tab's count is the one number that says whether it is worth opening —
 * how many criteria, which plan version, how many files changed — and is
 * absent rather than zero when there is nothing there yet.
 */
export function Tabs({ detail }: { detail: CardDetail }) {
  // Open on whatever this card is currently about. A card in Testing wants its
  // preview; one in Backlog has only a brief.
  const [tab, setTab] = useState<TabId>(() => defaultTab(detail));

  // Shells out to git, but fetched for any card that has a worktree rather than
  // only while the Diff tab is open: the tab's own count comes out of it, and a
  // count that only becomes true after you click is worse than no count.
  const diff = useQuery({
    queryKey: ['diff', detail.card.id],
    queryFn: () => api.diff(detail.card.id),
    enabled: Boolean(detail.worktree.path),
  });

  const shots = detail.assets.filter((a) => a.kind === 'screenshot');
  const tabs: Array<{ id: TabId; label: string; count?: string | number }> = [
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
        {tab === 'plan' && <PlanTab detail={detail} />}
        {tab === 'changes' && <ChangesTab detail={detail} />}
        {tab === 'diff' && <DiffTab detail={detail} diff={diff.data ?? null} loading={diff.isLoading} />}
        {tab === 'preview' && <PreviewTab detail={detail} />}
        {tab === 'activity' && <ActivityTab detail={detail} />}
      </div>
    </div>
  );
}

function defaultTab(detail: CardDetail): TabId {
  if (detail.card.activity === 'needs_input') return 'plan';
  switch (detail.card.stage) {
    case 'planning': return 'plan';
    case 'in_progress': return 'changes';
    case 'testing': return detail.assets.some((a) => a.kind === 'screenshot') ? 'preview' : 'changes';
    case 'done': return 'changes';
    default: return 'brief';
  }
}
