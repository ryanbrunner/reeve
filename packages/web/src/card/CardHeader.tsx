import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STAGE_LABELS, isRunnable, type CardDetail } from '@reeve/shared';
import { ProjectProgress } from '../board/ProjectProgress.js';
import { api } from '../lib/api.js';
import { Dropdown } from '../lib/Dropdown.js';
import { AttentionBand } from './AttentionBand.js';
import { plural, sumTokens, tok, tokenTitle, when } from './format.js';
import { SmallButton } from './ui.js';
import type { LiveRun } from './useCardDetail.js';

/**
 * Who this card is, and then what it wants from you.
 *
 * The identity line is fixed; the band below it is whatever the card's activity
 * says needs doing, or nothing at all for a card quietly sitting in Backlog.
 */
export function CardHeader({
  detail,
  live,
  onClose,
  editTitle = false,
  band = true,
}: {
  detail: CardDetail;
  live: LiveRun | null;
  onClose: () => void;
  /** Arrive with the title selected, so typing replaces it. For a card just made. */
  editTitle?: boolean;
  /** The attention band, which the conversation layout moves above its composer. */
  band?: boolean;
}) {
  const { card } = detail;
  const runs = detail.runs.filter((r) => r.kind === 'claude');
  const spent = sumTokens(runs);
  const running = card.activity === 'running';
  const createdBy = detail.events.find((e) => e.kind === 'created')?.actor;

  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['card', card.id] });
    void qc.invalidateQueries({ queryKey: ['board'] });
    void qc.invalidateQueries({ queryKey: ['archived'] });
  };
  // Closes on success: the card has left the board, and the archive is where
  // it can be found again — which is also why there is no "are you sure". The
  // one exception is a project with cards not yet Done: those do not go to the
  // Archive but to No project, and restoring the project does not bring them
  // back, so that is asked first.
  const archive = useMutation({
    mutationFn: (detachOpen: boolean) => api.archiveCard(card.id, detachOpen ? { detachOpen } : undefined),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const [confirming, setConfirming] = useState(false);
  const restore = useMutation({ mutationFn: () => api.restoreCard(card.id), onSuccess: invalidate });
  const rename = useMutation({
    mutationFn: (title: string) => api.updateCard(card.id, { title }),
    onSuccess: invalidate,
  });
  const refile = useMutation({
    mutationFn: (repoId: string | null) => api.updateCard(card.id, { repoId }),
    onSuccess: invalidate,
  });
  const failed = archive.error ?? restore.error ?? rename.error ?? refile.error;
  // Every repo, for the picker, and a project's cards, for its progress and the
  // confirm. The board already has them. The server checks again, so a card
  // added since the last poll is refused rather than moved unasked.
  const board = useQuery({ queryKey: ['board'], queryFn: api.board }).data;
  const repos = board?.repos ?? [];
  const tasks = card.kind === 'project' ? (board?.cards ?? []).filter((c) => c.projectId === card.id) : [];
  const open = tasks.filter((c) => c.stage !== 'done');
  // Live Done cards alone: these are what go to the Archive with the project,
  // and the ones already there are not the confirm's to count.
  const done = tasks.length - open.length;
  // The project's lane, for the tasks the sweep has archived. Only a live
  // project has one, so an archived project shows no bar, and that is by
  // decision rather than for want of a count: its finished work is counted in
  // the Tasks tab instead, off the detail's `archivedDoneCount`.
  const lane = card.kind === 'project' ? board?.projects.find((p) => p.id === card.id) : undefined;

  // The heading is the field. It is left to the DOM while it is being typed in,
  // so everything that ends an edit without saving one — an empty title, no
  // change, a failed save — has to put the text back by hand.
  const commit = (el: HTMLElement) => {
    // Collapsed, not just trimmed: Enter is handled, but a pasted paragraph
    // still arrives with its newlines in it, and a title is one line.
    const title = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!title || title === card.title) {
      el.textContent = card.title;
      return;
    }
    rename.mutate(title, {
      onError: () => {
        el.textContent = card.title;
      },
    });
  };

  // Selected rather than just focused: a bare caret would leave "Untitled" in
  // front of whatever was typed. Once per header, not per heading — the heading
  // remounts on every saved rename, and taking focus back then would pull it out
  // of the brief just as someone moved on to it. This only holds because the
  // header mounts after the card has loaded, and so after the modal has focused
  // its panel; were it there on the first render, the panel would win.
  const heading = useRef<HTMLHeadingElement>(null);
  const selected = useRef(false);
  useEffect(() => {
    const el = heading.current;
    if (!editTitle || selected.current || !el) return;
    selected.current = true;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editTitle]);

  return (
    <header className="relative shrink-0 border-b border-(--color-edge) px-5 pt-3.5 pb-4">
      <div className="relative flex items-center gap-2">
        {/* The repo chip is the picker. Locked once there is a worktree: that
            and its branch belong to the repo they were made in, and the server
            refuses the move for the same reason. A merged card's branch
            outlives its worktree, so that stays locked for good. */}
        <Dropdown
          variant="chip"
          label="Repo"
          value={card.repoId ?? ''}
          disabled={Boolean(card.worktreePath || (card.mergedAt != null && card.branchName)) || refile.isPending}
          onChange={(v) => refile.mutate(v || null)}
          title={
            card.worktreePath ? 'Remove the worktree before moving the card to another repo'
            : card.mergedAt != null && card.branchName ? 'Merged from this repo, where its branch is kept'
            : card.kind === 'project' ? 'The repo the project is split from, and its tasks default to'
            : 'Move the card to another repo'
          }
          options={[
            // A repo archived since is still the card's, so it stays pickable.
            ...(card.repoId && !repos.some((r) => r.id === card.repoId) ?
              [{ value: card.repoId, label: card.repoName ?? 'Unknown repo', color: card.laneColor ?? '#3f4754' }]
            : []),
            ...repos.map((r) => ({ value: r.id, label: r.name, color: r.laneColor ?? '#3f4754' })),
            { value: '', label: 'No repo', color: '#3f4754' },
          ]}
          style={{ background: `${card.laneColor ?? '#3f4754'}33`, color: card.laneColor ?? '#9aa4b2' }}
        />
        {/* A project has no number and sits in no column. */}
        {card.kind === 'project' ?
          <>
            <span aria-hidden="true" className="h-3 w-px bg-(--color-edge)" />
            <span className="font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-text) uppercase">
              Project
            </span>
            {/* The same bar as the lane's, since a project opens on its brief
                and this is the first thing that says how far it has got. The
                divider goes with it, for a project with no tasks yet. */}
            {lane && tasks.length + lane.archivedDoneCount > 0 && (
              <>
                <span aria-hidden="true" className="h-3 w-px bg-(--color-edge)" />
                <ProjectProgress
                  tasks={tasks}
                  archivedDone={lane.archivedDoneCount}
                  width="w-36"
                  long
                  className="font-mono text-[11px]/4 text-(--color-muted)"
                />
              </>
            )}
          </>
        : <>
            <span className="font-mono text-[11px]/4 text-(--color-muted)">#{card.number}</span>
            <span aria-hidden="true" className="h-3 w-px bg-(--color-edge)" />
            <span className="flex items-center gap-1.5 font-mono text-[11px]/4 font-medium tracking-[0.06em] text-(--color-text) uppercase">
              {STAGE_LABELS[card.stage]}
              {isRunnable(card.stage) && (
                <span title="Claude runs here" className="text-[10px] text-sky-500">◆</span>
              )}
            </span>
          </>
        }
        <div className="grow" />
        {card.archivedAt ?
          <>
            <span className="font-mono text-[10px]/4 text-(--color-muted)">Archived {when(card.archivedAt)}</span>
            <SmallButton tone="sky" disabled={restore.isPending} onClick={() => restore.mutate()}>
              {restore.isPending ? 'Restoring…' : 'Restore'}
            </SmallButton>
          </>
        : <>
            <span className="font-mono text-[10px]/4 text-(--color-muted)">Updated {when(card.updatedAt)}</span>
            {card.kind === 'project' ?
              <SmallButton
                disabled={running || archive.isPending || confirming}
                title={
                  running ? 'Stop the run before archiving'
                  : 'Take the project off the board, with its Done cards. The Archive can restore them.'
                }
                onClick={() => (open.length > 0 ? setConfirming(true) : archive.mutate(false))}
              >
                {archive.isPending ? 'Archiving…' : 'Archive'}
              </SmallButton>
            : <SmallButton
                disabled={running || archive.isPending}
                title={running ? 'Stop the run before deleting' : 'Take the card off the board. The Archive can restore it.'}
                onClick={() => archive.mutate(false)}
              >
                {archive.isPending ? 'Deleting…' : 'Delete'}
              </SmallButton>
            }
          </>
        }
        <button
          type="button"
          onClick={onClose}
          aria-label="Close card details"
          className="flex items-center gap-1.5 rounded-sm border border-(--color-edge) py-[3px] pr-1 pl-2 font-mono text-[11px]/4 text-(--color-text) hover:border-slate-600"
        >
          Close
          <kbd className="rounded-[3px] bg-(--color-ink) px-1 font-mono text-[10px]/[14px] text-(--color-muted)">
            esc
          </kbd>
        </button>
      </div>

      {/* Keyed on the title so a saved rename remounts it with React's text,
          not the text the browser was left holding. */}
      <h2
        key={card.title}
        ref={heading}
        id="card-title"
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        title="Click to edit"
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          e.currentTarget.blur();
        }}
        className="relative -mx-1.5 mt-2.5 max-w-[33rem] cursor-text rounded-sm border border-transparent px-1.5 text-[18px]/[26px] font-medium tracking-[-0.01em] text-(--color-text) outline-none hover:border-(--color-edge) focus:border-sky-600"
      >
        {card.title}
      </h2>

      <div className="relative mt-1 font-mono text-[11px]/4 text-(--color-muted)">
        {/* "by you" is rendered, never stored: there is one person, and the day
            there are two this is the line that changes. Claude is the other
            author, of the tasks a project was split into. */}
        Created {when(card.createdAt)} by {createdBy === 'claude' ? 'Claude' : 'you'} ·{' '}
        {runs.length === 0 ? 'No runs yet' : plural(runs.length, 'run')}
        {/* Left off while no run has a count yet, rather than "· —". */}
        {spent && (
          <>
            {' · '}
            <span title={tokenTitle(spent.breakdown)}>{tok(spent.total)}</span>
          </>
        )}
        {running && runs.length > 0 && ' so far'}
      </div>
      {failed && <p className="relative mt-1 font-mono text-[10px]/4 text-red-300">{failed.message}</p>}

      {/* Gone by itself if the last open card finishes while it is up: the
          button then archives straight away, as for any project. */}
      {confirming && open.length > 0 && (
        <div role="group" aria-labelledby="archive-confirm" className="relative mt-3.5 border-t border-(--color-edge) pt-3.5">
          <div id="archive-confirm" className="text-sm/5 font-medium text-(--color-text)">
            {open.length === 1 ? '1 card is' : `${open.length} cards are`} not Done
          </div>
          <p className="mt-0.5 text-sm/5 text-(--color-muted)">
            {open.length === 1 ?
              'It moves to No project, in the column it is in, and stays there if the project is restored.'
            : 'They move to No project, in the columns they are in, and stay there if the project is restored.'}{' '}
            {done === 0 ? 'The project has no Done cards to archive.'
            : done === 1 ? 'Its one Done card goes to the Archive with it.'
            : `Its ${done} Done cards go to the Archive with it.`}
          </p>
          <ul className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
            {open.map((c) => (
              <li key={c.id} className="flex items-baseline gap-2 text-sm/5">
                <span className="shrink-0 font-mono text-[11px]/4 text-(--color-muted)">#{c.number}</span>
                <span className="min-w-0 truncate text-(--color-text)">{c.title}</span>
                <span className="shrink-0 font-mono text-[10px]/4 text-(--color-muted)">{STAGE_LABELS[c.stage]}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <SmallButton tone="sky" busy={archive.isPending} onClick={() => archive.mutate(true)}>
              {archive.isPending ? 'Archiving…' : `Archive and move ${open.length} to No project`}
            </SmallButton>
            <SmallButton disabled={archive.isPending} onClick={() => setConfirming(false)}>
              Cancel
            </SmallButton>
          </div>
        </div>
      )}

      {band && <AttentionBand detail={detail} live={live} onClose={onClose} />}
    </header>
  );
}
