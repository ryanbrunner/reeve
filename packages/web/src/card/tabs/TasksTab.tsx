import { STAGES, STAGE_LABELS, type ApiCard } from '@reeve/shared';
import { Empty, SectionHead } from '../ui.js';

/**
 * A project's tasks, in the order the board would show them: by column left to
 * right, then by place in the column. Each opens in this one's place.
 */
export function TasksTab({ tasks, loading, onOpen }: {
  tasks: ApiCard[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  const ordered = [...tasks].sort(
    (a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || a.position - b.position,
  );
  return (
    <section className="flex flex-col gap-2">
      <SectionHead count={tasks.length || undefined}>Tasks</SectionHead>
      {loading ?
        <Empty>Loading tasks…</Empty>
      : ordered.length === 0 ?
        <Empty>Nothing yet. Write the brief and Claude will split it into tasks, or add them from the board.</Empty>
      : <ul className="rounded-md border border-(--color-edge) bg-(--color-ink)">
          {ordered.map((t) => (
            <li key={t.id} className="not-first:border-t not-first:border-(--color-edge)">
              <button
                type="button"
                onClick={() => onOpen(t.id)}
                className="flex w-full items-center gap-2 px-3 py-[7px] text-left hover:bg-white/4"
              >
                {t.repoName && (
                  <span
                    className="shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px]/4"
                    style={{ background: `${t.laneColor ?? '#3f4754'}33`, color: t.laneColor ?? '#9aa4b2' }}
                  >
                    {t.repoName}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[11px]/5 text-(--color-muted)">#{t.number}</span>
                <span className="min-w-0 grow truncate text-sm/5 text-(--color-text)">{t.title}</span>
                <span className="shrink-0 font-mono text-[10px]/4 tracking-[0.06em] text-(--color-muted) uppercase">
                  {STAGE_LABELS[t.stage]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      }
    </section>
  );
}
