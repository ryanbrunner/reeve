import { STAGES, STAGE_LABELS, type ApiCard } from '@reeve/shared';
import { Empty, SectionHead } from '../ui.js';

/**
 * A project's tasks, in the order the board would show them: by column left to
 * right, then by place in the column. Each opens in this one's place.
 *
 * The ones the sweep archived after they finished are not on the board to list,
 * so they are a count at the end, and the count at the top includes them: the
 * number must match the lane's bar, and a project whose work had all merged
 * must not read as one never started.
 */
export function TasksTab({ tasks, archivedDone, loading, onOpen }: {
  tasks: ApiCard[];
  /** The project's `archivedDoneCount`. */
  archivedDone: number;
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  const ordered = [...tasks].sort(
    (a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || a.position - b.position,
  );
  return (
    <section className="flex flex-col gap-2">
      <SectionHead count={tasks.length + archivedDone || undefined}>Tasks</SectionHead>
      {loading ?
        <Empty>Loading tasks…</Empty>
      : ordered.length === 0 && archivedDone > 0 ?
        <Empty>
          {archivedDone === 1 ?
            'Its one task finished and was archived. The Archive has it.'
          : `All ${archivedDone} tasks finished and were archived. The Archive has them.`}
        </Empty>
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
          {/* Not a button: there is no card on the board to open. */}
          {archivedDone > 0 && (
            <li className="border-t border-(--color-edge) px-3 py-[7px] text-sm/5 text-(--color-muted)">
              {archivedDone} more finished and archived
            </li>
          )}
        </ul>
      }
    </section>
  );
}
