import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  STAGE_LABELS,
  isTerminal,
  toolResultIn,
  type ApiConversation,
  type CardDetail,
  type ConversationItem,
  type ConversationRun,
  type RunnableStage,
} from '@reeve/shared';
import { api } from '../../lib/api.js';
import { Markdown } from '../Markdown.js';
import { Button, SmallButton } from '../ui.js';
import { clock } from './format.js';

/**
 * The card, as the conversation it is: one tab per stage Claude works in, and
 * in each, everything said in it — the person's messages, Claude's replies and
 * reasoning, each tool call with what came back, what it asked and what it
 * submitted.
 *
 * Each stage starts its own session, so each is its own thread; the tabs are
 * how an earlier stage's conversation stays readable once the card has moved
 * on. Only the card's current stage can be talked to, so a past tab is read-only
 * and the composer below says so.
 */
export type StageTab = RunnableStage;

/** The side panel tabs a submission can open. */
export type Panel = 'plan' | 'changes' | 'preview' | 'release';

type StageState = 'done' | 'running' | 'input' | 'review' | 'error' | 'idle' | 'none';

const DOT: Record<StageState, string> = {
  done: 'border-[1.5px] border-(--color-activity-review-mark) after:absolute after:left-[2.5px] after:top-[0.5px] after:h-[4px] after:w-[2px] after:rotate-45 after:border-r-[1.5px] after:border-b-[1.5px] after:border-(--color-activity-review-mark)',
  running: 'bg-(--color-activity-running-mark) shadow-[0_0_0_3px_#38bdf833] animate-pulse',
  input: 'bg-(--color-activity-input-mark) shadow-[0_0_0_3px_#fbbf2433]',
  review: 'bg-(--color-activity-review-mark) shadow-[0_0_0_3px_#34d39933]',
  error: 'bg-(--color-activity-error-mark)',
  idle: 'bg-(--color-muted)/60',
  none: 'border-[1.5px] border-dashed border-slate-600',
};

const DOT_LABEL: Record<StageState, string> = {
  done: 'submitted', running: 'live', input: 'your turn', review: 'ready', error: 'failed', idle: '', none: '',
};

export function stageState(detail: CardDetail, stage: StageTab, runs: ConversationRun[]): StageState {
  if (stage === detail.card.stage) {
    switch (detail.card.activity) {
      case 'running': return 'running';
      case 'needs_input': return 'input';
      case 'needs_review': return 'review';
      case 'error': return 'error';
      case 'idle': return runs.length ? 'idle' : 'none';
    }
  }
  if (runs.length === 0) return 'none';
  return runs.some((r) => r.status === 'succeeded') ? 'done' : 'idle';
}

export function StageTabs({ detail, conversation, tab, onTab }: {
  detail: CardDetail;
  conversation: ApiConversation | null;
  tab: StageTab;
  onTab: (t: StageTab) => void;
}) {
  const stages = conversation?.stages ?? [];
  return (
    <div role="tablist" aria-label="Stages" className="flex shrink-0 items-stretch gap-[22px] overflow-x-auto border-b border-(--color-edge) px-5">
      {stages.map((s) => {
        const state = stageState(detail, s.stage, s.runs);
        const count = s.runs.length;
        return (
          <button
            key={s.stage}
            type="button"
            role="tab"
            aria-selected={tab === s.stage}
            onClick={() => onTab(s.stage)}
            className={`flex items-center gap-[7px] border-b-2 pt-3 pb-2.5 font-mono text-[11px]/4 font-medium tracking-[0.06em] whitespace-nowrap uppercase ${
              tab === s.stage ? 'border-sky-600 text-(--color-text)' : 'border-transparent text-(--color-muted) hover:text-(--color-text)'
            }`}
          >
            <span aria-hidden="true" className={`relative inline-block size-[8px] shrink-0 rounded-full ${DOT[state]}`} />
            {STAGE_LABELS[s.stage]}
            <span className="font-normal tracking-normal text-(--color-muted)/60 normal-case">
              {s.stage === detail.card.stage && DOT_LABEL[state] ? DOT_LABEL[state] : count ? `${count} run${count === 1 ? '' : 's'}` : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ConversationThread({ detail, conversation, tab, onOpenPanel }: {
  detail: CardDetail;
  conversation: ApiConversation | null;
  tab: StageTab;
  /** A submission's "Open" goes to the panel that shows it. */
  onOpenPanel: (panel: Panel) => void;
}) {
  const runs = conversation?.stages.find((s) => s.stage === tab)?.runs ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // A long stage is thousands of items, and the latest is what is being
  // talked about: render the end of it, and earlier on request.
  const [limit, setLimit] = useState(WINDOW);
  useEffect(() => setLimit(WINDOW), [tab]);
  const shown = tail(runs, limit);

  // Follows the conversation as it grows, unless the person has scrolled up
  // to read, in which case it stays where they are.
  const size = runs.reduce((n, r) => n + r.items.length, 0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [size, tab]);
  useEffect(() => {
    pinned.current = true;
  }, [tab]);

  if (!conversation) {
    return <div className="flex grow items-center justify-center text-sm text-(--color-muted)">Loading the conversation…</div>;
  }

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 grow overflow-y-auto py-[18px]"
    >
      <div className="mx-auto flex max-w-[780px] flex-col gap-3.5 px-7 max-sm:px-4">
        {runs.length === 0 ? (
          <NotStarted detail={detail} stage={tab} />
        ) : (
          <>
            {shown.hidden > 0 && (
              <button
                type="button"
                onClick={() => {
                  pinned.current = false;
                  setLimit((w) => w + WINDOW);
                }}
                className="self-center rounded-sm border border-(--color-edge) px-2.5 py-1 font-mono text-[11px]/4 text-(--color-muted) hover:text-(--color-text)"
              >
                Show earlier · {shown.hidden} more
              </button>
            )}
            {shown.runs.map(({ run, from }) => (
              <RunBlock
                key={run.runId}
                detail={detail}
                run={from ? { ...run, items: run.items.slice(from) } : run}
                first={run === runs[0] && from === 0}
                stage={tab}
                live={!isTerminal(run.status)}
                onOpenPanel={onOpenPanel}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** How many items a stage's thread renders at first, and adds per "Show earlier". */
const WINDOW = 400;

/** The last `limit` items across the stage's runs, as the runs they belong to and where each starts. */
function tail(runs: ConversationRun[], limit: number): { runs: Array<{ run: ConversationRun; from: number }>; hidden: number } {
  const out: Array<{ run: ConversationRun; from: number }> = [];
  let left = limit;
  let hidden = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    if (left <= 0) {
      hidden += run.items.length;
      continue;
    }
    const from = Math.max(0, run.items.length - left);
    hidden += from;
    left -= run.items.length - from;
    out.unshift({ run, from });
  }
  return { runs: out, hidden };
}

function NotStarted({ detail, stage }: { detail: CardDetail; stage: StageTab }) {
  const current = stage === detail.card.stage;
  return (
    <div className="flex flex-col items-center gap-1.5 py-16 text-center">
      <div className="font-mono text-[11px]/4 tracking-[0.06em] text-(--color-muted) uppercase">
        {STAGE_LABELS[stage]} {current ? 'has not started' : 'has not started yet'}
      </div>
      <p className="max-w-[400px] text-sm/5 text-(--color-muted)">
        {current
          ? detail.card.startingStage
            ? 'Claude starts in a moment.'
            : 'Send Claude a message below to start it, or press Run.'
          : 'Each stage starts a fresh session with the work so far. Approving the stage before this one moves the card here.'}
      </p>
    </div>
  );
}

/** A divider, in the thread's mono voice: when a run began, ended, or was carried on. */
function Divider({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'error' }) {
  return (
    <div className={`flex items-center gap-2.5 font-mono text-[11px]/4 ${tone === 'error' ? 'text-red-300' : 'text-(--color-muted)'}`}>
      <span className="h-px grow bg-(--color-edge)" />
      <span className="max-w-[80%] text-center">{children}</span>
      <span className="h-px grow bg-(--color-edge)" />
    </div>
  );
}

const ENDINGS: Partial<Record<ConversationRun['status'], string>> = {
  failed: 'The run failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted by a restart',
};

function RunBlock({ detail, run, first, stage, live, onOpenPanel }: {
  detail: CardDetail;
  run: ConversationRun;
  first: boolean;
  stage: StageTab;
  live: boolean;
  onOpenPanel: (panel: Panel) => void;
}) {
  const groups = group(run.items);
  const ending = ENDINGS[run.status];
  const summary = detail.runs.find((r) => r.id === run.runId);
  return (
    <>
      {first ? (
        <Divider>
          <b className="font-medium text-(--color-text)">{STAGE_LABELS[stage]}</b> started
          {run.startedAt ? ` · ${clock(run.startedAt)}` : ''}
          {run.model ? ` · ${run.model}` : ''}
        </Divider>
      ) : (
        // A follow-up opens with the person's words, which say why on their own.
        run.items[0]?.kind !== 'user' && <Divider>Continued{run.startedAt ? ` · ${clock(run.startedAt)}` : ''}</Divider>
      )}
      {groups.map((g, i) => {
        if (Array.isArray(g)) return <ToolGroup key={g[0]!.id} tools={g} live={live} runId={run.runId} />;
        // Claude speaking again after its own tool calls or reasoning is one
        // voice carrying on, not a new message: no second name and avatar.
        const prev = groups[i - 1];
        const continued = g.kind === 'text' && prev !== undefined && (Array.isArray(prev) || prev.kind === 'text' || prev.kind === 'thinking');
        return <Item key={g.id} item={g} detail={detail} live={live} stage={stage} onOpenPanel={onOpenPanel} continued={continued} />;
      })}
      {ending && (
        <Divider tone={run.status === 'failed' ? 'error' : 'muted'}>
          {ending}
          {summary?.errorMessage ? `: ${summary.errorMessage.slice(0, 160)}` : run.stopReason && run.stopReason !== 'completed' ? ` (${run.stopReason.replace(/_/g, ' ')})` : ''}
        </Divider>
      )}
    </>
  );
}

type ToolItem = Extract<ConversationItem, { kind: 'tool' }>;

/** Consecutive tool calls read as one block, the way they happen: in a burst. */
function group(items: ConversationItem[]): Array<ConversationItem | ToolItem[]> {
  const out: Array<ConversationItem | ToolItem[]> = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.kind === 'tool' && Array.isArray(last)) last.push(item);
    else out.push(item.kind === 'tool' ? [item] : item);
  }
  return out;
}

function Item({ item, detail, live, stage, onOpenPanel, continued = false }: {
  item: ConversationItem;
  detail: CardDetail;
  live: boolean;
  stage: StageTab;
  onOpenPanel: (panel: Panel) => void;
  continued?: boolean;
}) {
  switch (item.kind) {
    case 'prompt':
      return <PromptItem text={item.text} />;
    case 'user':
      return <UserItem item={item} />;
    case 'text':
      return (
        <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-2.5">
          {continued ? <span /> : <Avatar who="claude" />}
          <div className="min-w-0">
            {!continued && <div className="mb-[3px] font-mono text-[11px]/4 text-(--color-muted)">Claude · {clock(item.at)}</div>}
            <Markdown>{item.text}</Markdown>
          </div>
        </div>
      );
    case 'thinking':
      return <Thinking text={item.text} />;
    case 'ask':
      return <AskItem item={item} detail={detail} live={live} />;
    case 'submitted':
      return <Submitted item={item} stage={stage} onOpenPanel={onOpenPanel} />;
    case 'error':
      return <p className="ml-8 font-mono text-[11px]/4 text-red-300">{item.text}</p>;
    case 'tool':
      return null;
  }
}

function Avatar({ who }: { who: 'claude' | 'you' }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-[22px] place-items-center rounded-md border font-mono text-[11px] font-medium ${
        who === 'claude' ? 'border-[#d9775740] bg-[#d977571f] text-[#e8a184]' : 'border-[#0ea5e940] bg-[#0ea5e91f] text-sky-300'
      }`}
    >
      {who === 'claude' ? 'C' : 'Y'}
    </span>
  );
}

function PromptItem({ text }: { text: string }) {
  return (
    <details className="group rounded-md border border-(--color-edge) bg-(--color-ink)">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 font-mono text-[11px]/4 text-(--color-muted) hover:text-(--color-text)">
        <span className="transition-transform group-open:rotate-90">›</span>
        The stage's instructions to Claude
        <span className="text-(--color-muted)/60">· {text.split('\n').length} lines</span>
      </summary>
      <pre className="max-h-80 overflow-auto border-t border-dashed border-(--color-edge) px-3 py-2 font-mono text-[11px]/[17px] whitespace-pre-wrap text-(--color-muted)">
        {text}
      </pre>
    </details>
  );
}

const SOURCE_LABEL: Record<Extract<ConversationItem, { kind: 'user' }>['source'], string | null> = {
  chat: null,
  answer: 'your answers',
  review: 'sent back',
  note: 'note',
  crit: 'via Crit',
  gloss: 'via Gloss',
  vibes: 'VIBES MODE',
};

function UserItem({ item }: { item: Extract<ConversationItem, { kind: 'user' }> }) {
  const who = item.actor === 'claude' ? 'VIBES MODE' : 'you';
  const via = SOURCE_LABEL[item.source];
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] rounded-[10px_10px_3px_10px] border border-sky-700/50 bg-sky-900/25 px-3 py-2">
        <div className="mb-[3px] flex justify-end gap-1.5 font-mono text-[11px]/4 text-(--color-muted)">
          {via && <span className="text-sky-300">{via}</span>}
          {via && '·'}
          <span>{who}{item.live ? ' · while Claude worked' : ''} · {clock(item.at)}</span>
        </div>
        <Markdown>{item.text}</Markdown>
      </div>
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      className="ml-8 border-l-2 border-(--color-edge) py-0.5 pl-3 text-left text-[13px]/[19px] text-(--color-muted) italic"
    >
      <span className="mr-1.5 font-mono text-[10px] tracking-[0.06em] text-(--color-muted)/60 uppercase not-italic">thinking</span>
      <span className={open ? 'whitespace-pre-line' : 'line-clamp-2'}>{text}</span>
    </button>
  );
}

/** Past this, a burst shows its first and last few calls and folds the middle away. */
const GROUP_FOLD = 12;

function ToolGroup({ tools, live, runId }: { tools: ToolItem[]; live: boolean; runId: string }) {
  const first = tools[0]!;
  const last = tools.at(-1)!;
  const [unfolded, setUnfolded] = useState(false);
  const folded = !unfolded && tools.length > GROUP_FOLD;
  const shown = folded ? [...tools.slice(0, 4), ...tools.slice(-4)] : tools;
  return (
    <div className="ml-8 overflow-hidden rounded-md border border-(--color-edge) bg-[#0b0e12]">
      <div className="flex justify-between border-b border-(--color-edge) px-2.5 py-[5px] font-mono text-[10px] tracking-[0.06em] text-(--color-muted)/60 uppercase">
        <span>{tools.length} tool call{tools.length === 1 ? '' : 's'}</span>
        <span>{clock(first.at)}{last !== first ? ` – ${clock(last.at)}` : ''}</span>
      </div>
      {shown.map((t, i) => (
        <div key={t.id}>
          {folded && i === 4 && (
            <button
              type="button"
              onClick={() => setUnfolded(true)}
              className="w-full border-t border-(--color-edge) px-2.5 py-1.5 text-left font-mono text-[11px]/4 text-sky-300 hover:bg-(--color-panel)"
            >
              Show the other {tools.length - 8} calls
            </button>
          )}
          <ToolRow tool={t} pending={live && t.result === null} runId={runId} />
        </div>
      ))}
    </div>
  );
}

function ToolRow({ tool, pending, runId }: { tool: ToolItem; pending: boolean; runId: string }) {
  const result = tool.result;
  const [open, setOpen] = useState(false);
  // The conversation carries the head of each output; the rest is fetched
  // when the row is opened, from the event it was clipped from.
  const full = useQuery({
    queryKey: ['tool-result', runId, result?.seq, tool.toolUseId],
    queryFn: () => api.runEvent(runId, result!.seq).then((e) => toolResultIn(e.payload, tool.toolUseId)),
    enabled: open && Boolean(result?.truncated),
    staleTime: Infinity,
  });
  const text = full.data ?? result?.text ?? '';
  const lines = text ? text.split('\n').length : 0;
  return (
    <details className="group border-t border-(--color-edge) first-of-type:border-t-0" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="grid cursor-pointer list-none grid-cols-[12px_64px_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5 font-mono text-[11.5px]/4 hover:bg-(--color-panel)">
        <span className="text-(--color-muted)/50 transition-transform group-open:rotate-90">›</span>
        <span className="truncate text-(--color-muted)">{tool.verb}</span>
        <span className="truncate text-[#c9d1d9]">{tool.target || tool.name}</span>
        <span className={pending ? 'text-sky-300' : result?.isError ? 'text-red-400' : 'text-(--color-muted)/60'}>
          {pending ? 'running…' : result?.isError ? 'error' : result ? (result.truncated && !full.data ? 'long' : lines > 1 ? `${lines} lines` : 'ok') : '—'}
        </span>
      </summary>
      <div className="border-t border-dashed border-(--color-edge) bg-[#090b0f]">
        {tool.input && tool.input !== '{}' && (
          <pre className="max-h-40 overflow-auto px-3 pt-2 pb-1 pl-8 font-mono text-[11px]/[17px] whitespace-pre-wrap text-(--color-muted)">{tool.input}</pre>
        )}
        {text && (
          <pre className={`max-h-72 overflow-auto px-3 pt-1 pb-2.5 pl-8 font-mono text-[11.5px]/[17px] whitespace-pre-wrap ${result?.isError ? 'text-red-300' : 'text-[#adbac7]'}`}>
            {text}
            {result?.truncated && !full.data && (full.isFetching ? '\n…loading the rest' : '')}
          </pre>
        )}
      </div>
    </details>
  );
}

const SUBMITTED: Record<StageTab, { what: string; panel: Panel }> = {
  planning: { what: 'Plan', panel: 'plan' },
  in_progress: { what: 'Implementation', panel: 'changes' },
  testing: { what: 'Test report', panel: 'preview' },
  release: { what: 'Pull request', panel: 'release' },
};

function Submitted({ item, stage, onOpenPanel }: {
  item: Extract<ConversationItem, { kind: 'submitted' }>;
  stage: StageTab;
  onOpenPanel: (panel: Panel) => void;
}) {
  const what = SUBMITTED[stage].what;
  const panel = SUBMITTED[stage].panel;
  return (
    <div className="ml-8 rounded-lg border border-(--color-activity-review-border) bg-[linear-gradient(var(--color-activity-review-fill),var(--color-activity-review-fill)),var(--color-card-core)] px-3.5 py-3 shadow-[inset_0_0_14px_0_#00bc7d26]">
      <div className="flex items-center gap-2 font-mono text-[11px]/4 tracking-[0.06em] text-(--color-activity-review-mark) uppercase">
        ◆ {what} submitted
        <span className="grow" />
        <span className="tracking-normal text-(--color-muted) normal-case">{clock(item.at)}</span>
      </div>
      {item.summary && <p className="mt-1.5 text-sm/5 font-medium">{item.summary}</p>}
      <div className="mt-2">
        <SmallButton tone="sky" onClick={() => onOpenPanel(panel)}>Open the {what.toLowerCase()}</SmallButton>
      </div>
    </div>
  );
}

/**
 * What a live run is waiting on: a call auto mode would not approve on its
 * own, or a question. Answered here with a click, or in the composer with
 * words — which, for a permission, is a refusal with the reason in them.
 */
function AskItem({ item, detail, live }: {
  item: Extract<ConversationItem, { kind: 'ask' }>;
  detail: CardDetail;
  live: boolean;
}) {
  const qc = useQueryClient();
  const answer = useMutation({
    mutationFn: (body: Parameters<typeof api.answerAsk>[2]) => api.answerAsk(detail.card.id, item.askId!, body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });
  const pending = item.outcome === null && live && item.askId !== null;
  const [chosen, setChosen] = useState<Record<string, string>>({});

  if (item.request.kind === 'permission') {
    const input = item.request.input;
    const command = typeof input['command'] === 'string' ? input['command'] : null;
    const shown = command ?? (typeof input['file_path'] === 'string' ? input['file_path'] : JSON.stringify(input, null, 2));
    const description = typeof input['description'] === 'string' ? input['description'] : null;
    if (!pending) {
      const o = item.outcome;
      const verdict = !o ? 'Not answered'
        : o.kind === 'permission' ? (o.allow ? 'Allowed by you' : `Denied by you${o.reason ? `: “${o.reason}”` : ''}`)
        : o.kind === 'unanswered' ? (o.why === 'timeout' ? 'Nobody answered in time — denied' : 'Stopped while waiting')
        : '';
      return (
        <div className="ml-8 rounded-md border border-(--color-edge) bg-(--color-card-core) px-3 py-2">
          <div className="font-mono text-[11px]/4 text-(--color-muted)">
            <span className={o?.kind === 'permission' && o.allow ? 'text-(--color-activity-review-mark)' : 'text-red-300'}>
              {o?.kind === 'permission' && o.allow ? '✓' : '✕'}
            </span>{' '}
            {item.request.toolName} · {verdict}
          </div>
          <pre className="mt-1 truncate font-mono text-[11.5px]/4 text-(--color-muted)">{shown}</pre>
        </div>
      );
    }
    return (
      <div className="ml-8 rounded-lg border border-(--color-activity-input-border) bg-[linear-gradient(var(--color-activity-input-fill),var(--color-activity-input-fill)),var(--color-card-core)] px-3.5 py-3 shadow-[inset_0_0_14px_0_#fe9a0026]">
        <div className="font-mono text-[11px]/4 tracking-[0.06em] text-(--color-activity-input-mark) uppercase">
          ◆ Claude wants to use {item.request.toolName}, which auto mode would not allow on its own
        </div>
        <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-(--color-edge) bg-[#0b0e12] px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-(--color-text)">{shown}</pre>
        {description && <p className="mt-1.5 text-[13px]/[19px] text-(--color-muted)">“{description}”</p>}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button tone="input" disabled={answer.isPending} onClick={() => answer.mutate({ decision: 'allow' })}>Allow once</Button>
          <Button disabled={answer.isPending} onClick={() => answer.mutate({ decision: 'deny' })}>Deny</Button>
          <span className="ml-auto font-mono text-[10.5px] text-(--color-muted)/60">
            or type below to deny with your reason · denied after 10 min unanswered
          </span>
        </div>
        {answer.error && <p className="mt-1.5 text-sm/5 text-red-300">{answer.error.message}</p>}
      </div>
    );
  }

  const questions = item.request.questions;
  const outcome = item.outcome;
  if (!pending) {
    const answers = outcome?.kind === 'question' ? outcome.answers : {};
    return (
      <div className="ml-8 flex flex-col gap-1.5 rounded-md border border-(--color-edge) bg-(--color-card-core) px-3 py-2">
        {questions.map((q) => (
          <div key={q.question} className="text-sm/5">
            <span className="text-(--color-muted)">{q.question}</span>{' '}
            {answers[q.question] !== undefined ? (
              <span className="font-medium">→ {answers[q.question]}</span>
            ) : (
              <span className="font-mono text-[11px] text-(--color-muted)">
                {outcome?.kind === 'unanswered' ? (outcome.why === 'timeout' ? 'not answered in time' : 'stopped') : '—'}
              </span>
            )}
          </div>
        ))}
        {outcome?.kind === 'question' && outcome.actor === 'claude' && (
          <span className="font-mono text-[10px] text-(--color-muted)">answered by VIBES MODE with Claude's own first option</span>
        )}
      </div>
    );
  }
  const single = questions.length === 1 && !questions[0]!.multiSelect;
  const ready = questions.every((q) => chosen[q.question]);
  return (
    <div className="ml-8 rounded-lg border border-(--color-activity-input-border) bg-[linear-gradient(var(--color-activity-input-fill),var(--color-activity-input-fill)),var(--color-card-core)] px-3.5 py-3 shadow-[inset_0_0_14px_0_#fe9a0026]">
      <div className="font-mono text-[11px]/4 tracking-[0.06em] text-(--color-activity-input-mark) uppercase">◆ Claude is asking</div>
      <div className="mt-2 flex flex-col gap-3">
        {questions.map((q) => (
          <div key={q.question}>
            <p className="text-sm/5 font-medium">{q.question}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {q.options.map((o) => {
                const picked = chosen[q.question] === o.label;
                return (
                  <button
                    key={o.label}
                    type="button"
                    title={o.description}
                    disabled={answer.isPending}
                    onClick={() => {
                      if (single) answer.mutate({ answers: { [q.question]: o.label } });
                      else setChosen((c) => ({ ...c, [q.question]: o.label }));
                    }}
                    className={`rounded-full border px-2.5 py-[3px] text-[13px] ${
                      picked ? 'border-(--color-activity-input-mark) bg-[#fe9a0033] text-amber-50' : 'border-[#fbbf2466] bg-[#fe9a0014] text-amber-100 hover:border-(--color-activity-input-mark)'
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        {!single && <Button tone="input" disabled={!ready || answer.isPending} onClick={() => answer.mutate({ answers: chosen })}>Send answers</Button>}
        <span className="font-mono text-[10.5px] text-(--color-muted)/60">or type your own answer below</span>
      </div>
      {answer.error && <p className="mt-1.5 text-sm/5 text-red-300">{answer.error.message}</p>}
    </div>
  );
}
