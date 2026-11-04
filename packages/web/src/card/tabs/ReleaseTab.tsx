import type { CardDetail } from '@reeve/shared';
import { Markdown } from '../Markdown.js';
import { Empty, SectionHead } from '../ui.js';

/**
 * What the Release conversation last wrote for the pull request: the title
 * and description Reeve set on it, the release notes, the finish command's
 * result and what to know before merging. The pull request itself, and its
 * Merge button, are in the band above the composer.
 */
export function ReleaseTab({ detail }: { detail: CardDetail }) {
  const r = detail.release;
  if (!r) {
    return (
      <Empty>
        Nothing written for the pull request yet. Claude drafts its title, description and release notes in Release,
        and Reeve sets them on the pull request.
      </Empty>
    );
  }
  return (
    <>
      <section className="flex flex-col gap-2">
        <SectionHead>Verdict</SectionHead>
        <p className={`text-sm/5 font-medium ${r.ready ? 'text-emerald-200' : 'text-amber-100'}`}>
          {r.ready ? 'Ready to merge' : 'Not ready yet'}
        </p>
        <p className="text-sm/5 text-(--color-muted)">{r.summary}</p>
        {r.concerns.length > 0 && (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm/5">
            {r.concerns.map((c) => <li key={c}>{c}</li>)}
          </ul>
        )}
      </section>
      {(r.finish.ran || r.finish.notes) && (
        <section className="flex flex-col gap-1.5">
          <SectionHead>Finish command</SectionHead>
          <p className="font-mono text-[11.5px]/4">
            <span className={r.finish.ran ? (r.finish.passed ? 'text-emerald-300' : 'text-red-300') : 'text-(--color-muted)'}>
              {r.finish.ran ? (r.finish.passed ? '✓ passed' : '✕ failed') : 'not run'}
            </span>
            {r.finish.notes && <span className="text-(--color-muted)"> · {r.finish.notes}</span>}
          </p>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <SectionHead>Pull request</SectionHead>
        <p className="text-sm/5 font-medium">{r.prTitle}</p>
        <div className="rounded-md border border-(--color-edge) bg-(--color-panel) px-3 py-2.5">
          <Markdown>{r.prBody}</Markdown>
        </div>
      </section>
      {r.releaseNotes.trim() && (
        <section className="flex flex-col gap-2">
          <SectionHead>Release notes</SectionHead>
          <Markdown>{r.releaseNotes}</Markdown>
        </section>
      )}
    </>
  );
}
