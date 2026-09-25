import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isTerminal, type ApiAsset, type CardDetail } from '@reeve/shared';
import { api } from '../../lib/api.js';
import { when } from '../format.js';
import { InlineMarkdown, Markdown } from '../Markdown.js';
import { Code, Empty, SectionHead, SmallButton } from '../ui.js';

/**
 * How Claude means to do it.
 *
 * The prose sections are whatever Claude decided this task needed — the
 * contract does not name them, so neither does this: however many come back,
 * in order, with their own headings. A migration's sections are not a UI
 * change's sections, and a fixed "Risks" heading only ever gets padded.
 */
export function PlanTab({ detail }: { detail: CardDetail }) {
  const { plan } = detail;
  if (!plan) {
    return (
      <Empty>
        No plan yet. Move this card to Planning and run it, and Claude will write one here.
      </Empty>
    );
  }

  return (
    <>
      <CritReview detail={detail} />
      <div className="grid grid-cols-[minmax(0,1fr)_312px] gap-6">
        <div className="flex flex-col gap-4">
          {plan.details.map((section) => (
            <section key={section.heading} className="flex flex-col gap-2">
              <SectionHead>{section.heading}</SectionHead>
              <Markdown>{section.body}</Markdown>
            </section>
          ))}
          {plan.details.length === 0 && <Empty><InlineMarkdown>{plan.summary}</InlineMarkdown></Empty>}
        </div>
        <Designs detail={detail} />
      </div>

      <section className="flex flex-col gap-2">
        <SectionHead
          count={plan.steps.length || undefined}
          aside={
            <span className="font-mono text-[11px]/4 text-(--color-muted)">
              v{plan.version} · Claude · {when(plan.createdAt)}
            </span>
          }
        >
          Steps
        </SectionHead>
        {plan.steps.length === 0 ? (
          <Empty>This plan has no separate steps.</Empty>
        ) : (
          <ol className="flex flex-col gap-2.5">
            {plan.steps.map((step, i) => {
              const blocking = step.blockedOnQuestion
                ? detail.questions.find((q) => q.position === step.blockedOnQuestion)
                : undefined;
              return (
                <li key={i} className="flex gap-3">
                  <span className="mt-px w-3 shrink-0 font-mono text-[11px]/5 text-(--color-muted)">{i + 1}</span>
                  <div className="flex min-w-0 grow flex-col gap-1">
                    <div className="text-sm/5 text-(--color-text)">
                      <span className="font-medium"><InlineMarkdown>{step.title}</InlineMarkdown></span>
                      {step.detail && (
                        <span className="text-(--color-muted)"> — <InlineMarkdown>{step.detail}</InlineMarkdown></span>
                      )}
                    </div>
                    {step.files.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {step.files.map((f) => <Code key={f}>{f}</Code>)}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 font-mono text-[11px]/5 text-(--color-muted)">
                    {/* A step blocked on a question that has since been answered
                        is not blocked any more, and shouldn't still say so. */}
                    {step.blockedOnQuestion && blocking?.answer === null
                      ? `waits on question ${step.blockedOnQuestion}`
                      : 'planned'}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
}

/**
 * Review the plan in Crit, line by line, instead of in one text box.
 *
 * The verdict comes from Crit rather than from here: comments left there send
 * the plan back as a revision, and finishing with none approves it. So this
 * only opens the review, links back to it, and stops it.
 */
function CritReview({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['card', detail.card.id] });
  // Returned rather than fired, as Suggest does, so the button stays pending
  // until the refetch has the run in it and `live` below takes over.
  const open = useMutation({
    mutationFn: () => api.reviewWithCrit(detail.card.id),
    onSuccess: invalidate,
  });

  // Read off the card's runs, newest first, so a modal opened again finds the
  // review still open.
  const last = detail.runs.find((r) => r.task === 'crit_review');
  const live = last && !isTerminal(last.status) ? last : null;
  const stop = useMutation({ mutationFn: (runId: string) => api.stopRun(runId), onSuccess: invalidate });

  // An approval moves the card, and the board does not poll. The modal does,
  // so the review ending is noticed here and passed on.
  const isLive = Boolean(live);
  const wasLive = useRef(isLive);
  useEffect(() => {
    if (wasLive.current && !isLive) void qc.invalidateQueries({ queryKey: ['board'] });
    wasLive.current = isLive;
  }, [isLive, qc]);

  const { card, worktree } = detail;
  const blocked =
    card.stage !== 'planning' ? 'Only a plan in Planning can be reviewed in Crit.'
    : card.activity === 'running' ? 'Claude is working on the plan. Wait for it to finish.'
    : card.activity === 'needs_input' ? 'Answer Claude’s questions first.'
    : card.activity !== 'needs_review' ? 'The plan is not ready for review.'
    : !worktree.path || !worktree.exists ? 'The worktree is missing from disk.'
    : null;
  // The URL Crit printed, while it is this review's; the port on the row, for
  // a modal opened since.
  const href = !live ? null
    : open.data?.runId === live.id && open.data.url ? open.data.url
    : live.port ? `http://127.0.0.1:${live.port}`
    : null;
  const error = open.error ?? stop.error;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {live ? (
          <>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px]/4 text-sky-300 no-underline hover:underline"
              >
                Open in Crit
              </a>
            ) : (
              <span className="font-mono text-[11px]/4 text-(--color-muted)">Crit opened in your browser.</span>
            )}
            <SmallButton busy={stop.isPending} onClick={() => stop.mutate(live.id)}>
              {stop.isPending ? 'Stopping…' : 'Stop'}
            </SmallButton>
          </>
        ) : (
          <SmallButton tone="sky" disabled={Boolean(blocked)} busy={open.isPending} onClick={() => open.mutate()}>
            {open.isPending ? 'Opening Crit…' : 'Review with Crit'}
          </SmallButton>
        )}
        {(live || blocked) && (
          <p className="font-mono text-[10px]/4 text-(--color-muted)">
            {live ? 'Comments come back as feedback. Finish Review with no comments approves the plan.' : blocked}
          </p>
        )}
      </div>
      {error && <p className="font-mono text-[10px]/4 text-red-300">{error.message}</p>}
    </div>
  );
}

function Designs({ detail }: { detail: CardDetail }) {
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const mockups = detail.assets.filter((a) => a.kind === 'mockup');

  const upload = useMutation({
    mutationFn: async (chosen: File) => {
      const form = new FormData();
      form.set('file', chosen);
      form.set('label', chosen.name.replace(/\.[a-z]+$/i, ''));
      return api.uploadMockup(detail.card.id, form);
    },
    onSuccess: () => { setError(null); void qc.invalidateQueries({ queryKey: ['card', detail.card.id] }); },
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: (assetId: string) => api.deleteAsset(detail.card.id, assetId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['card', detail.card.id] }),
  });

  return (
    <section className="flex flex-col gap-2">
      <SectionHead
        count={mockups.length || undefined}
        aside={
          <SmallButton disabled={upload.isPending} onClick={() => file.current?.click()}>
            {upload.isPending ? 'Uploading…' : 'Attach mockup'}
          </SmallButton>
        }
      >
        Designs
      </SectionHead>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          if (chosen) upload.mutate(chosen);
          e.target.value = '';
        }}
      />
      {mockups.length === 0 ? (
        <Empty>
          None attached. A mockup with a page and a width is what tells Testing which screen to
          photograph.
        </Empty>
      ) : (
        <div className="flex flex-wrap gap-3">
          {mockups.map((m) => <Thumb key={m.id} asset={m} onRemove={() => remove.mutate(m.id)} />)}
        </div>
      )}
      {error && <p className="font-mono text-[10px]/4 text-red-300">{error}</p>}
    </section>
  );
}

function Thumb({ asset, onRemove }: { asset: ApiAsset; onRemove: () => void }) {
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <div className="overflow-hidden rounded-md border border-(--color-edge)">
        <img
          src={asset.src}
          alt={asset.label}
          width={150}
          height={asset.width && asset.height ? Math.round((150 * asset.height) / asset.width) : 94}
          className="block w-[150px] bg-(--color-ink) object-cover"
        />
      </div>
      <figcaption className="flex items-baseline justify-between gap-2 font-mono text-[10px]/4 text-(--color-muted)">
        <span className="truncate">{asset.label}</span>
        <button type="button" onClick={onRemove} aria-label={`Remove ${asset.label}`} className="hover:text-red-300">
          ✕
        </button>
      </figcaption>
    </figure>
  );
}
