import { useState } from 'react';
import type { ApiDiff, ApiDiffFile, CardDetail } from '@reeve/shared';
import { Empty, SectionHead } from '../ui.js';

/**
 * What the card has changed, file by file.
 *
 * The diff arrives already parsed into rows — files, hunks, line numbers — so
 * nothing here understands unified diff format. That is deliberate: the server
 * counts "+38 −9" in the same pass that produces the lines, so the file list
 * and the file itself cannot disagree.
 *
 * Fills the panel rather than growing with its content, so the file list and
 * the file scroll separately: forty changed files cannot push the diff out of
 * view.
 */
export function DiffTab({
  detail,
  diff,
  loading,
}: {
  detail: CardDetail;
  diff: ApiDiff | null;
  loading: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const files = diff?.files ?? [];
  const current = files.find((f) => f.path === selected) ?? files[0] ?? null;
  // The same test Tabs fetches on: a worktree, or failing that the branch it
  // left behind, or an old card's squash commit.
  const { worktree } = detail;
  const readable = Boolean(worktree.path || (worktree.branch && worktree.base) || detail.card.mergedSha);

  return (
    <section className="flex min-h-0 grow flex-col gap-2">
      <SectionHead
        count={files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : undefined}
        aside={
          diff && files.length > 0 ? (
            <span className="font-mono text-[11px]/4 text-(--color-muted)">
              <span className="text-(--diff-add-mark,#34d399)">+{diff.additions}</span>{' '}
              <span className="text-(--diff-del-mark,#f87171)">−{diff.deletions}</span> · against {diff.baseBranch}
            </span>
          ) : null
        }
      >
        Diff
      </SectionHead>

      {loading && <Empty>Reading the worktree…</Empty>}
      {!loading && !readable && <Empty>This card has no worktree yet, so nothing has changed.</Empty>}
      {!loading && readable && files.length === 0 && (
        // No "yet" once the worktree is gone: nothing more is coming.
        <Empty>Nothing has changed against {diff?.baseBranch ?? 'the base branch'}{worktree.path ? ' yet' : ''}.</Empty>
      )}

      {files.length > 0 && current && (
        // Stacked, not side-by-side: this tab only ever renders in the 420px
        // aside, which leaves no real width for a list beside the file.
        <div className="flex min-h-0 grow flex-col gap-2">
          <div className="flex max-h-24 shrink-0 flex-col overflow-y-auto rounded-md border border-(--color-edge)">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                aria-pressed={f.path === current.path}
                onClick={() => setSelected(f.path)}
                className={`flex items-baseline justify-between gap-2 px-2.5 py-1.5 text-left font-mono text-[11px]/4 not-first:border-t not-first:border-(--color-edge) ${
                  f.path === current.path ? 'bg-white/6' : 'hover:bg-white/3'
                }`}
              >
                <span className="flex min-w-0 items-baseline">
                  <span className="min-w-0 truncate text-(--color-muted)">{dirOf(f.path)}</span>
                  <span className="shrink-0 text-(--color-text)">{baseOf(f.path)}</span>
                </span>
                <span className="shrink-0">
                  <span className="text-emerald-400">+{f.additions}</span>{' '}
                  <span className="text-red-400">−{f.deletions}</span>
                </span>
              </button>
            ))}
          </div>
          <FileDiff file={current} />
        </div>
      )}
    </section>
  );
}

function FileDiff({ file }: { file: ApiDiffFile }) {
  // Size both gutters to this file's own widest line number rather than a flat
  // 3rem each, so a short file (most of them) gives that width back to the code.
  // A loop, not Math.max(...spread): the server sends a regenerated lockfile's
  // tens of thousands of lines whole, and spreading that many arguments throws.
  let widest = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) widest = Math.max(widest, line.oldLine ?? 0, line.newLine ?? 0);
  }
  const gutterWidth = Math.max(1, String(widest).length);
  // Each number column keeps its px-2 (1rem) padding, so the track needs that
  // added back on top of the digits themselves or the widest number clips.
  const gridStyle = { gridTemplateColumns: `calc(${gutterWidth}ch + 1rem) calc(${gutterWidth}ch + 1rem) 1rem minmax(0,1fr)` };

  return (
    <div className="flex min-h-0 grow flex-col overflow-hidden rounded-md border border-(--color-edge)">
      <div className="flex min-w-0 shrink-0 items-baseline justify-between gap-2 border-b border-(--color-edge) px-2.5 py-1.5">
        <span className="flex min-w-0 items-baseline font-mono text-[11px]/4 text-(--color-text)">
          <span className="min-w-0 truncate text-(--color-muted)">
            {file.oldPath ? `${file.oldPath} → ` : ''}
            {dirOf(file.path)}
          </span>
          <span className="shrink-0">{baseOf(file.path)}</span>
          <span className="ml-2 shrink-0">
            <span className="text-emerald-400">+{file.additions}</span>{' '}
            <span className="text-red-400">−{file.deletions}</span>
          </span>
        </span>
        <span className="shrink-0 font-mono text-[10px]/4 text-(--color-muted)">{file.status}</span>
      </div>

      <div className="min-h-0 grow overflow-auto bg-(--color-ink)">
        {file.binary ? (
          <p className="p-3 text-sm/5 text-(--color-muted)">Binary file — nothing to show.</p>
        ) : (
          file.hunks.map((hunk) => (
            <div key={hunk.header}>
              <div className="bg-white/4 px-2.5 py-1 font-mono text-[10px]/4 text-(--color-muted)">{hunk.header}</div>
              {hunk.lines.map((line, i) => (
                <div
                  key={i}
                  className={`grid font-mono text-[11px]/[17px] ${
                    line.kind === 'add' ? 'bg-emerald-500/10' : line.kind === 'del' ? 'bg-red-500/10' : ''
                  }`}
                  style={gridStyle}
                >
                  <span className="px-2 text-right text-(--color-muted)/60 select-none">{line.oldLine ?? ''}</span>
                  <span className="px-2 text-right text-(--color-muted)/60 select-none">{line.newLine ?? ''}</span>
                  <span
                    className={`select-none ${
                      line.kind === 'add' ? 'text-emerald-400' : line.kind === 'del' ? 'text-red-400' : ''
                    }`}
                  >
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}
                  </span>
                  <span className="pr-3 whitespace-pre-wrap text-(--color-text) [overflow-wrap:anywhere]">
                    {line.text}
                  </span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const dirOf = (path: string) => (path.includes('/') ? `${path.slice(0, path.lastIndexOf('/') + 1)}` : '');
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
