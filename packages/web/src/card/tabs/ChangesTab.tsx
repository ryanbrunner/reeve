import type { CardDetail } from '@reeve/shared';
import { when } from '../format.js';
import { InlineMarkdown, Markdown } from '../Markdown.js';
import { Empty, SectionHead } from '../ui.js';

/**
 * What Claude says it did: its own account of the work, where it departed from
 * the plan, and what it left. The Diff tab is what git says it did.
 */
export function ChangesTab({ detail }: { detail: CardDetail }) {
  const impl = detail.implementation;
  if (!impl) {
    return (
      <Empty>
        No implementation notes yet. Claude writes them here when it finishes In Progress.
      </Empty>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <SectionHead
        aside={<span className="font-mono text-[11px]/4 text-(--color-muted)">Claude · {when(impl.createdAt)}</span>}
      >
        Implementation notes
      </SectionHead>
      <Markdown className="max-w-[44rem]">{impl.summary}</Markdown>
      {(impl.deviations.length > 0 || impl.suggestedTasks.length > 0) && (
        <ul className="flex max-w-[44rem] list-disc flex-col gap-1 pl-5 text-sm/5 text-(--color-text) marker:text-(--color-muted)">
          {impl.deviations.map((d) => <li key={d}><InlineMarkdown>{d}</InlineMarkdown></li>)}
          {impl.suggestedTasks.map((t) => (
            <li key={t} className="text-(--color-muted)">Suggested as a card: <InlineMarkdown>{t}</InlineMarkdown></li>
          ))}
        </ul>
      )}
    </section>
  );
}
