import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiProject, ApiSettings, CreateProjectBody } from '@reeve/shared';
import { api } from '../lib/api.js';
import { Button, Empty, SectionHead, SmallButton } from '../card/ui.js';

/**
 * What is open on the right: Reeve's own run settings, the new-repo form, or
 * one repo by id.
 */
export type SettingsPane = { kind: 'runs' } | { kind: 'repo'; id: string | null };

/**
 * Everything that is configured rather than worked on: how Reeve runs, and the
 * repos it is allowed to work in.
 *
 * A list down the side and a form beside it, and nothing cleverer. The
 * validation that matters lives on the server — it is the only side that can
 * stat a path or ask git what branches exist — and this shows whatever it says.
 */
export function SettingsModal({ initial, onClose }: { initial: SettingsPane; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['board'], queryFn: api.board });
  const projects = data?.projects ?? [];
  const panel = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const [pane, setPane] = useState<SettingsPane>(initial);
  const selected = pane.kind === 'repo' ? pane.id : undefined;
  const editing = projects.find((p) => p.id === selected) ?? null;

  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Same rule as the card: Escape gets you out of a field before it gets
      // you out of the dialog, so a half-typed path survives one keystroke.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        target.blur();
        return;
      }
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      restoreFocus.current?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 sm:p-10">
      <div className="absolute inset-0 bg-[#0e1116c2]" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        className="relative flex h-[min(720px,100%)] w-[min(980px,100%)] flex-col overflow-hidden rounded-lg border border-(--color-edge) bg-(--color-panel) outline-none"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-(--color-edge) px-5 py-3.5">
          <h2 id="settings-title" className="text-[18px]/[26px] font-medium tracking-[-0.01em]">
            Settings
          </h2>
          <div className="grow" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex items-center gap-1.5 rounded-sm border border-(--color-edge) py-[3px] pr-1 pl-2 font-mono text-[11px]/4 text-(--color-text) hover:border-slate-600"
          >
            Close
            <kbd className="rounded-[3px] bg-(--color-ink) px-1 font-mono text-[10px]/[14px] text-(--color-muted)">
              esc
            </kbd>
          </button>
        </header>

        <div className="flex min-h-0 grow">
          <nav
            aria-label="Settings"
            className="flex w-[240px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-(--color-edge) p-4"
          >
            <SectionHead>Reeve</SectionHead>
            <div className="-mx-1.5 flex flex-col">
              <NavItem current={pane.kind === 'runs'} onClick={() => setPane({ kind: 'runs' })}>
                <span className="min-w-0 truncate">Runs</span>
              </NavItem>
            </div>

            <div className="mt-3">
              <SectionHead count={projects.length}>Repos</SectionHead>
            </div>
            {projects.length === 0 ?
              <Empty>None yet</Empty>
            : <div className="-mx-1.5 flex flex-col">
                {projects.map((p) => (
                  <NavItem key={p.id} current={p.id === selected} onClick={() => setPane({ kind: 'repo', id: p.id })}>
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: p.laneColor ?? '#3f4754' }}
                    />
                    <span className="min-w-0 truncate">{p.name}</span>
                  </NavItem>
                ))}
              </div>
            }
            <SmallButton tone={selected === null ? 'sky' : 'plain'} onClick={() => setPane({ kind: 'repo', id: null })}>
              + Add a repo
            </SmallButton>
          </nav>

          {/* The repo form is keyed so switching projects rebuilds it rather
              than leaving one repo's half-typed path sitting in another's fields. */}
          {pane.kind === 'runs' ?
            <RunsPane />
          : <ProjectForm
              key={editing?.id ?? 'new'}
              project={editing}
              takenColors={projects.filter((p) => p.id !== editing?.id).map((p) => p.laneColor)}
              onCreated={(p) => setPane({ kind: 'repo', id: p.id })}
            />
          }
        </div>
      </div>
    </div>,
    document.body,
  );
}

function NavItem({ current, onClick, children }: { current: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-current={current ? 'true' : undefined}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-sm border px-1.5 py-1 text-left font-mono text-[11px]/[18px] ${
        current ?
          'border-(--color-edge) bg-white/4 text-(--color-text)'
        : 'border-transparent text-(--color-muted) hover:border-(--color-edge) hover:bg-white/4'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Reeve's own settings. Its own query rather than a field on the board, which
 * polls every few seconds for something that only changes here.
 */
function RunsPane() {
  const { data, error } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  if (error) {
    return (
      <div className="grow p-5">
        <Empty>Could not load settings: {error.message}</Empty>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grow p-5">
        <Empty>Loading…</Empty>
      </div>
    );
  }
  // Mounted only once the settings are here, so the field starts from the
  // stored value rather than from blank and then jumping.
  return <RunsForm settings={data} />;
}

function RunsForm({ settings }: { settings: ApiSettings }) {
  const qc = useQueryClient();
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(String(settings.maxConcurrentRuns));
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () => api.updateSettings({ maxConcurrentRuns: Number(maxConcurrentRuns) }),
    onSuccess: (s) => {
      setSaved(true);
      qc.setQueryData(['settings'], s);
    },
  });

  const limit = Number(maxConcurrentRuns);
  const valid = Number.isInteger(limit) && limit >= 1;

  return (
    <form
      className="flex min-w-0 grow flex-col gap-5 overflow-y-auto p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !save.isPending) save.mutate();
      }}
    >
      <section className="flex flex-col gap-3">
        <SectionHead>Runs</SectionHead>
        <Field
          label="Concurrent runs"
          hint="Claude sessions allowed at once, across every card and repo. Lowering it stops nothing already running; it holds new runs back until enough have finished."
        >
          <Text
            value={maxConcurrentRuns}
            onChange={(v) => {
              setSaved(false);
              setMaxConcurrentRuns(v);
            }}
            placeholder="3"
            mono
          />
        </Field>
      </section>

      <div className="flex items-center gap-3 border-t border-(--color-edge) pt-4">
        <Button tone="sky" type="submit" disabled={!valid || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        {saved && !save.isPending && (
          <span className="font-mono text-[11px]/4 text-(--color-muted)">Saved</span>
        )}
        {!valid && (
          <span className="font-mono text-[11px]/4 text-red-300">Concurrent runs must be a whole number, 1 or more.</span>
        )}
      </div>
      {save.error && (
        <p className="rounded-sm border border-(--color-btn-error-border) bg-(--color-btn-error-fill) p-2 font-mono text-[11px]/[18px] text-red-200">
          {save.error.message}
        </p>
      )}
    </form>
  );
}

/**
 * Lane colours, as a fixed set rather than a colour input.
 *
 * These are the board's swim lane dots and the chips on every card face, so
 * they have to sit on a dark panel without shouting — a free picker produces a
 * neon lane on the first try. Muted, evenly spaced, and picked for you.
 */
const LANE_COLORS = ['#6b7db3', '#7fa38a', '#b3866b', '#8f7fb3', '#b36b81', '#6ba3b3'] as const;

type FormState = {
  [K in keyof CreateProjectBody]-?: string;
};

function initialState(project: ApiProject | null, takenColors: (string | null)[]): FormState {
  const free = LANE_COLORS.find((c) => !takenColors.includes(c)) ?? LANE_COLORS[0];
  return {
    name: project?.name ?? '',
    repoPath: project?.repoPath ?? '',
    worktreeRoot: project?.worktreeRoot ?? '',
    defaultBranch: project?.defaultBranch ?? '',
    setupCommand: project?.setupCommand ?? '',
    testCommand: project?.testCommand ?? '',
    serverCommand: project?.serverCommand ?? '',
    teardownCommand: project?.teardownCommand ?? '',
    finishCommand: project?.finishCommand ?? '',
    laneColor: project?.laneColor ?? free,
    maxBudgetUsd: project?.maxBudgetUsd == null ? '' : String(project.maxBudgetUsd),
  };
}

function ProjectForm({
  project,
  takenColors,
  onCreated,
}: {
  project: ApiProject | null;
  takenColors: (string | null)[];
  onCreated: (p: ApiProject) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(() => initialState(project, takenColors));
  const [saved, setSaved] = useState(false);
  const set = (k: keyof FormState) => (v: string) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const save = useMutation({
    mutationFn: async () => {
      // A blank optional field means "no command", which is null on the wire;
      // a blank path or branch means "you work it out", which is absent.
      const blankIsNull = (v: string) => (v.trim() ? v.trim() : null);
      const body = {
        name: form.name.trim(),
        repoPath: form.repoPath.trim(),
        setupCommand: blankIsNull(form.setupCommand),
        testCommand: blankIsNull(form.testCommand),
        serverCommand: blankIsNull(form.serverCommand),
        teardownCommand: blankIsNull(form.teardownCommand),
        finishCommand: blankIsNull(form.finishCommand),
        laneColor: blankIsNull(form.laneColor),
        maxBudgetUsd: form.maxBudgetUsd.trim() ? Number(form.maxBudgetUsd) : null,
        ...(form.worktreeRoot.trim() ? { worktreeRoot: form.worktreeRoot.trim() } : {}),
        ...(form.defaultBranch.trim() ? { defaultBranch: form.defaultBranch.trim() } : {}),
      };
      return project ? api.updateProject(project.id, body) : api.createProject(body);
    },
    onSuccess: (p) => {
      setSaved(true);
      // The board carries the project list, so the header picker, the rail
      // picker and the swim lanes all read this one invalidation.
      void qc.invalidateQueries({ queryKey: ['board'] });
      if (!project) onCreated(p);
    },
  });

  const budgetIsNumber = !form.maxBudgetUsd.trim() || Number.isFinite(Number(form.maxBudgetUsd));
  const ready = form.name.trim() !== '' && form.repoPath.trim() !== '' && budgetIsNumber;

  return (
    <form
      className="flex min-w-0 grow flex-col gap-5 overflow-y-auto p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !save.isPending) save.mutate();
      }}
    >
      <section className="flex flex-col gap-3">
        <SectionHead>{project ? 'Identity' : 'New repo'}</SectionHead>
        <Field label="Name" hint="What the chips and swim lanes call it.">
          <Text value={form.name} onChange={set('name')} placeholder="storefront" autoFocus={!project} />
        </Field>
        <Field label="Lane colour">
          <div role="group" aria-label="Lane colour" className="flex flex-wrap gap-1.5">
            {LANE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={form.laneColor === c}
                onClick={() => set('laneColor')(c)}
                className={`h-6 w-6 rounded-full border-2 ${
                  form.laneColor === c ? 'border-(--color-text)' : 'border-transparent hover:border-(--color-edge)'
                }`}
                style={{ background: c }}
              />
            ))}
          </div>
        </Field>
      </section>

      <section className="flex flex-col gap-3 border-t border-(--color-edge) pt-4">
        <SectionHead>Repository</SectionHead>
        <Field label="Repo path" hint="An absolute path, or one starting with ~. A path inside a repo files the whole repo.">
          <Text value={form.repoPath} onChange={set('repoPath')} placeholder="~/code/storefront" mono />
        </Field>
        <Field label="Default branch" hint="Blank asks the repo which branch it is on.">
          <Text value={form.defaultBranch} onChange={set('defaultBranch')} placeholder="main" mono />
        </Field>
        <Field label="Worktree root" hint="Where per-card worktrees are cut. Blank puts .reeve-worktrees beside the repo.">
          <Text value={form.worktreeRoot} onChange={set('worktreeRoot')} placeholder="beside the repo" mono />
        </Field>
      </section>

      <section className="flex flex-col gap-3 border-t border-(--color-edge) pt-4">
        <SectionHead>Commands</SectionHead>
        <Field label="Setup" hint="Once, after a worktree is made.">
          <Text value={form.setupCommand} onChange={set('setupCommand')} placeholder="npm install" mono />
        </Field>
        <Field label="Test" hint="What Testing runs to check the work.">
          <Text value={form.testCommand} onChange={set('testCommand')} placeholder="npm test" mono />
        </Field>
        <Field label="Server" hint="The dev server behind Preview.">
          <Text value={form.serverCommand} onChange={set('serverCommand')} placeholder="npm run dev" mono />
        </Field>
        <Field label="Teardown" hint="Before a worktree is removed.">
          <Text value={form.teardownCommand} onChange={set('teardownCommand')} mono />
        </Field>
        <Field label="Finish" hint="When a card reaches Done.">
          <Text value={form.finishCommand} onChange={set('finishCommand')} mono />
        </Field>
      </section>

      <section className="flex flex-col gap-3 border-t border-(--color-edge) pt-4">
        <SectionHead>Budget</SectionHead>
        <Field label="Max spend" hint="US dollars across a card's runs. Blank means no cap.">
          <Text value={form.maxBudgetUsd} onChange={set('maxBudgetUsd')} placeholder="5" mono />
        </Field>
      </section>

      <div className="flex items-center gap-3 border-t border-(--color-edge) pt-4">
        <Button tone="sky" type="submit" disabled={!ready || save.isPending}>
          {save.isPending ? 'Saving…'
          : project ? 'Save changes'
          : 'Add repo'}
        </Button>
        {saved && !save.isPending && (
          <span className="font-mono text-[11px]/4 text-(--color-muted)">Saved</span>
        )}
        {!budgetIsNumber && (
          <span className="font-mono text-[11px]/4 text-red-300">Max spend must be a number.</span>
        )}
      </div>
      {save.error && (
        <p className="rounded-sm border border-(--color-btn-error-border) bg-(--color-btn-error-fill) p-2 font-mono text-[11px]/[18px] text-red-200">
          {save.error.message}
        </p>
      )}
    </form>
  );
}

/**
 * Sentence case, deliberately. `SectionHead` above it is mono uppercase, and a
 * form where both levels shout the same way has no hierarchy left — the eye
 * cannot tell a group from a field in it.
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[11px]/4 text-(--color-text)">{label}</span>
      {children}
      {hint && <span className="font-mono text-[10px]/[15px] text-(--color-muted)/80">{hint}</span>}
    </label>
  );
}

function Text({
  value,
  onChange,
  placeholder,
  mono,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <input
      value={value}
      autoFocus={autoFocus}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-md border border-(--color-edge) bg-(--color-ink) px-2.5 py-1.5 outline-none placeholder:text-(--color-muted)/50 focus:border-sky-600 ${
        mono ? 'font-mono text-[11px]/[18px]' : 'text-sm'
      }`}
    />
  );
}
