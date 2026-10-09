import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { STAGE_LABELS, isRunnable, isTerminal, type CardDetail } from '@reeve/shared';
import { api } from '../../lib/api.js';
import { AttentionBand } from '../AttentionBand.js';
import { cost, duration } from '../format.js';
import type { LiveRun } from '../useCardDetail.js';
import type { StageTab } from './ConversationView.js';

/**
 * Where a person talks to Claude about the card: pinned under the thread, as
 * Claude Code's prompt is.
 *
 * What a message does depends on the run, and the server decides it (see
 * conversation.ts): while Claude works it is read at its next step; while it
 * waits on a question or a permission it answers that; otherwise it carries
 * the stage's conversation on. So the box is always there, and only what it
 * says changes — what Claude is doing, that it is waiting, that the work is
 * ready — with the gate above it whenever there is work to approve.
 */
export function Composer({ detail, live, tab, onClose }: {
  detail: CardDetail;
  live: LiveRun | null;
  /** The stage tab being read. Only the card's own stage can be talked to. */
  tab: StageTab;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { card } = detail;
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  const run = detail.runs.find((r) => r.kind === 'claude' && r.task === null && r.stage === card.stage) ?? null;
  const liveRun = run && !isTerminal(run.status) ? run : null;
  const asking = liveRun?.status === 'asking';
  const runnable = isRunnable(card.stage);
  const readOnly = tab !== card.stage;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['card', card.id] });
    void qc.invalidateQueries({ queryKey: ['conversation', card.id] });
    void qc.invalidateQueries({ queryKey: ['board'] });
  };
  const send = useMutation({
    mutationFn: (words: string) => api.sendMessage(card.id, words),
    onSuccess: () => {
      setText('');
      refresh();
    },
  });
  const stop = useMutation({ mutationFn: () => api.stopRun(liveRun!.id), onSuccess: refresh });

  // Grows with what is typed, up to a few lines, then scrolls.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const disabled = readOnly || !runnable || card.archivedAt !== null || card.startingStage || card.mergedAt != null;
  const placeholder = readOnly
    ? `${STAGE_LABELS[tab]} is over — switch to ${STAGE_LABELS[card.stage]} to talk to Claude`
    : !runnable
      ? card.stage === 'backlog'
        ? 'Move the card to Planning to start working on it with Claude'
        : 'Claude does not work in this column'
      : card.startingStage
        ? 'Claude is starting…'
        : asking
          ? 'Answer Claude — or type a reason to deny what it asked'
          : liveRun
            ? 'Interject — Claude reads this before its next step'
            : card.stage === 'release' && card.activity !== 'needs_input'
              ? card.mergedAt != null ? 'Merged — this card is finished' : 'Ask Claude about the release: the description, the notes, what to check before merging'
            : card.activity === 'needs_review'
              ? 'Send it back with what to change, or ask Claude about it'
              : card.activity === 'needs_input'
                ? 'Reply to Claude'
                : run
                  ? 'Message Claude to pick this back up'
                  : `Message Claude to start ${STAGE_LABELS[card.stage]}`;

  const submit = () => {
    const words = text.trim();
    if (words && !disabled && !send.isPending) send.mutate(words);
  };

  return (
    <div className="shrink-0 border-t border-(--color-edge) bg-(--color-card-core) px-5 pt-2.5 pb-3.5 max-sm:px-4">
      <div className="mx-auto max-w-[780px]">
        {!readOnly && <AttentionBand detail={detail} live={live} onClose={onClose} conversation />}
        <StatusLine detail={detail} live={live} readOnly={readOnly} tab={tab} />
        <div className={`rounded-lg border bg-(--color-panel) transition-colors ${disabled ? 'border-(--color-edge) opacity-70' : 'border-(--color-edge) focus-within:border-sky-600'}`}>
          <textarea
            ref={box}
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            aria-label="Message Claude"
            className="block min-h-[46px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm/5 text-(--color-text) outline-none placeholder:text-(--color-muted) disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-1.5 px-2 pt-1 pb-2">
            {send.error && <span className="min-w-0 truncate font-mono text-[11px]/4 text-red-300">{send.error.message}</span>}
            <span className="grow" />
            {!disabled && <span className="font-mono text-[10.5px] text-(--color-muted)/60 max-sm:hidden">⏎ send · ⇧⏎ newline</span>}
            {liveRun && !readOnly && (
              <button
                type="button"
                disabled={stop.isPending}
                onClick={() => stop.mutate()}
                className="inline-flex h-[30px] items-center gap-1.5 rounded-md border border-(--color-edge) px-2.5 text-[13px] text-(--color-muted) hover:border-(--color-activity-error-border) hover:text-red-200 disabled:opacity-40"
              >
                <i className="size-2 rounded-[1px] bg-current" />
                {stop.isPending ? 'Stopping…' : 'Stop'}
              </button>
            )}
            <button
              type="button"
              title="Send"
              aria-label="Send"
              disabled={disabled || !text.trim() || send.isPending}
              onClick={submit}
              className={`grid size-[30px] place-items-center rounded-md bg-sky-700 hover:bg-sky-600 disabled:opacity-40 ${send.isPending ? 'btn-busy' : ''}`}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One line of what is going on, in the thread's mono voice, above the box. */
function StatusLine({ detail, live, readOnly, tab }: { detail: CardDetail; live: LiveRun | null; readOnly: boolean; tab: StageTab }) {
  const { card } = detail;
  const run = card.latestRun;
  let main: React.ReactNode = null;
  let side: React.ReactNode = null;

  if (readOnly) {
    main = <span>{STAGE_LABELS[tab]} is read-only now: each stage is its own session.</span>;
  } else if (card.startingStage) {
    main = <span className="text-sky-300">Starting {STAGE_LABELS[card.stage]}…</span>;
  } else if (run?.status === 'asking') {
    main = <span className="text-(--color-activity-input-mark)">◆ Paused — Claude is waiting on you above</span>;
    side = <span>Typing here answers it</span>;
  } else if (card.activity === 'running') {
    const asking = false;
    const elapsed = live?.elapsedMs ?? (run?.startedAt ? Date.now() - run.startedAt : null);
    const doing = live?.activity ?? detail.thought?.activity ?? null;
    main = asking ? (
      <span className="text-(--color-activity-input-mark)">◆ Paused — Claude is waiting on you above</span>
    ) : (
      <span className="flex min-w-0 items-center gap-1.5 text-sky-300">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-(--color-activity-running-mark)" />
        <span className="truncate">Claude is working{doing ? ` · ${doing}` : ''}</span>
      </span>
    );
    side = <span className="shrink-0">{duration(elapsed)}{run?.totalCostUsd != null ? ` · ${cost(run.totalCostUsd)}` : ''}</span>;
  } else if (card.activity === 'needs_input') {
    main = <span className="text-(--color-activity-input-mark)">◆ Claude is waiting on your reply</span>;
    side = <span>Replying carries on the same conversation</span>;
  } else if (card.activity === 'needs_review' && card.stage === 'release') {
    main = <span className="text-(--color-activity-review-mark)">◆ Pull request written · merge when you are satisfied</span>;
    side = <span>Claude never merges</span>;
  } else if (card.activity === 'needs_review') {
    main = <span className="text-(--color-activity-review-mark)">◆ Submitted · ready for review</span>;
  } else if (card.activity === 'error') {
    main = <span className="text-red-300">The run stopped with an error. Reply to pick it back up, or Retry.</span>;
  }
  if (!main && !side) return null;
  return (
    <div className="mb-2 flex min-h-4 items-center gap-2.5 font-mono text-[11px]/4 text-(--color-muted)">
      <span className="min-w-0 truncate">{main}</span>
      <span className="grow" />
      {side}
    </div>
  );
}
