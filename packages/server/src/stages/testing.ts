import { planningOutput, testingOutput, type TestingOutput } from '@reeve/shared';
import { absoluteAssetPath, relativeAssetPath, writeAsset } from '../assets/store.js';
import { captureTargets, type CaptureTarget } from '../capture/screenshot.js';
import {
  assetsFor,
  clearVerdicts,
  insertAsset,
  latestClaudeRunForStage,
  recordVerdicts,
  replaceDifferences,
  replaceScreenshots,
} from '../db/queries.js';
import { ensureDevServer, waitForServer } from '../runs/devServer.js';
import { recordSuggestions } from '../suggestions.js';
import { blockquote, renderNotes, renderPrompt, renderSuggesting } from './template.js';
import type { StageDefinition } from './types.js';

/**
 * The stage that checks the work against what was asked for.
 *
 * It photographs before it thinks. `prepare` brings up the dev server and
 * captures every state a mockup or the plan named, so `buildPrompt` can hand
 * Claude the file paths of both the mockup and the matching screenshot — and
 * Claude can look at them. That is why the differences it reports are prose
 * about intent ("Save for later is a link here but a button in the mockup")
 * rather than a pixel count, which is the only kind of answer worth showing a
 * person.
 */
export const testingStage: StageDefinition<TestingOutput> = {
  id: 'testing',
  schema: testingOutput,
  maxBudgetUsd: 8,
  maxTurns: 150,
  effort: 'high',

  /**
   * Take the pictures. Every failure here is reported into the prompt rather
   * than thrown: a run that cannot photograph anything can still run the tests
   * and check the criteria, which is the larger half of its job.
   */
  async prepare(db, writer, ctx, runId) {
    // A person's mockups first, so on a label clash theirs sets the page and
    // width, and theirs is the one the screenshot is compared with.
    const mockups = assetsFor(db, ctx.card.id)
      .filter((a) => a.kind === 'mockup')
      .sort((a, b) => Number(a.runId !== null) - Number(b.runId !== null));
    const targets = captureTargetsFor(mockups, plannedCaptures(db, ctx.card.id));
    if (targets.length === 0) return { screenshots: 'No screenshots were requested for this card.' };

    const server = await ensureDevServer(db, writer, ctx.card, ctx.repo);
    if (server.state === 'unavailable') {
      return { screenshots: `No screenshots: the dev server could not be started (${server.reason}).` };
    }
    const answer = await waitForServer(db, server.runId);
    if (answer.state === 'no-url') {
      return {
        screenshots:
          'No screenshots: the dev server never said where it was serving. It printed no local URL, and the ' +
          'repo gives it no `{{port}}` in its command and no Server URL in its settings.',
      };
    }
    if (answer.state === 'no-answer') {
      return { screenshots: `No screenshots: the dev server at ${answer.url} never answered.` };
    }
    if (answer.state === 'stopped') {
      return { screenshots: `No screenshots: the dev server stopped before it answered${answer.reason ? ` (${answer.reason})` : ''}.` };
    }

    const result = await captureTargets({ baseUrl: answer.url, targets });
    if (result.unavailable) return { screenshots: `No screenshots: ${result.unavailable}` };

    // This run's pictures replace the last run's, so the tab never shows two
    // versions of the same state with no way to tell which is current.
    replaceScreenshots(db, ctx.card.id, runId);
    const lines: string[] = [];
    for (const shot of result.captures) {
      const id = crypto.randomUUID();
      const rel = relativeAssetPath(ctx.card.id, id, 'image/png');
      writeAsset(rel, shot.bytes);
      insertAsset(db, {
        cardId: ctx.card.id, runId, kind: 'screenshot',
        label: shot.label, url: shot.path, viewport: shot.viewport,
        path: rel, contentType: 'image/png', width: shot.width, height: shot.height,
      });
      const mockup = mockups.find((m) => m.label === shot.label);
      const drawn = mockup?.runId ? ' (drawn by Claude while planning)' : '';
      lines.push(
        `- **${shot.label}** (${shot.path} at ${shot.viewport}px)\n  - build: \`${absoluteAssetPath(rel)}\`` +
          (mockup ? `\n  - mockup${drawn}: \`${absoluteAssetPath(mockup.path)}\`` : '\n  - no mockup to compare against'),
      );
    }
    for (const f of result.failures) lines.push(`- **${f.label}** could not be captured: ${f.reason}`);

    return {
      screenshots: lines.length
        ? `These are on disk. Read the image files — both of each pair — and compare them.\n\n${lines.join('\n')}`
        : 'No screenshots could be taken.',
    };
  },

  buildPrompt(ctx, prepared) {
    const criteria = ctx.criteria?.length
      ? ctx.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : '_This card has no acceptance criteria. Judge it against the plan instead._';
    return renderPrompt('testing', {
      worktreePath: ctx.worktreePath,
      title: ctx.card.title,
      criteria,
      plan: ctx.priorArtifacts?.find((a) => a.kind === 'plan')?.content ?? '_No plan was recorded._',
      implementation: ctx.priorArtifacts?.find((a) => a.kind === 'summary')?.content ?? '_No notes were recorded._',
      screenshots: prepared?.['screenshots'] ?? 'No screenshots were taken.',
      testCommand: ctx.repo.testCommand
        ? `Run \`${ctx.repo.testCommand}\`.`
        : 'This repo defines no test command, so verify by reading and by the screenshots.',
      suggesting: renderSuggesting(),
      reviewNotes: ctx.reviewNotes ? renderPrompt('revision', { notes: blockquote(ctx.reviewNotes) }) : '',
      notes: renderNotes(ctx.notes),
    });
  },

  onComplete(_ctx, output) {
    return [{ kind: 'test_report', content: composeReport(output), path: '.reeve/test-report.md' }];
  },

  /**
   * The verdicts land on the criteria rows, which is what makes the brief's
   * checklist and the rail's "6 of 6 verified" the same fact rather than two.
   * Cleared first, so a criterion this run did not reach reads as unjudged
   * rather than keeping a stale pass from the run before.
   */
  onPersist(db, ctx, output, runId) {
    clearVerdicts(db, ctx.card.id);
    recordVerdicts(db, ctx.card.id, runId, output.criteria);

    const shots = assetsFor(db, ctx.card.id);
    // A person's mockup over one Claude drew, as in `prepare`.
    const byLabel = (kind: 'mockup' | 'screenshot', label: string) => {
      const matches = shots.filter((a) => a.kind === kind && a.label === label);
      return (matches.find((a) => a.runId === null) ?? matches[0])?.id ?? null;
    };
    replaceDifferences(
      db,
      ctx.card.id,
      runId,
      output.differences.map((d) => ({
        claim: d.claim,
        note: d.note,
        mockupAssetId: byLabel('mockup', d.capture_label),
        screenshotAssetId: byLabel('screenshot', d.capture_label),
      })),
    );
    recordSuggestions(db, ctx, output.suggested_tasks);
  },

  summarise(output) {
    const failed = output.criteria.filter((c) => c.verdict === 'fail').length;
    const total = output.criteria.length;
    const shortfall = failed ? `${total - failed} of ${total} criteria verified` : `${total} of ${total} verified`;
    return `${output.passed ? 'Tests green' : 'Tests failing'} · ${shortfall}`;
  },
};

/**
 * What to photograph: every mockup, plus whatever the plan asked for.
 *
 * Mockups come first and win on a label clash, because a mockup naming a state
 * is a stronger signal than a plan mentioning it — and a screenshot only pairs
 * with a mockup if their labels match exactly.
 */
function captureTargetsFor(
  mockups: Array<{ label: string; url: string | null; viewport: number | null }>,
  planned: CaptureTarget[],
): CaptureTarget[] {
  const targets: CaptureTarget[] = [];
  const seen = new Set<string>();
  for (const m of mockups) {
    if (!m.url || seen.has(m.label)) continue;
    seen.add(m.label);
    targets.push({ label: m.label, path: m.url, viewport: m.viewport ?? 1280 });
  }
  for (const c of planned) {
    if (seen.has(c.label)) continue;
    seen.add(c.label);
    targets.push(c);
  }
  return targets;
}

/**
 * The states the plan thought were worth a picture, read off the planning run's
 * structured output rather than parsed back out of the plan document. The data
 * is still sitting there; re-deriving it from prose would be inventing a
 * round trip in order to get it wrong occasionally.
 */
function plannedCaptures(db: Parameters<typeof assetsFor>[0], cardId: string): CaptureTarget[] {
  const run = latestClaudeRunForStage(db, cardId, 'planning');
  if (!run || run.status !== 'succeeded') return [];
  const parsed = planningOutput.safeParse(run.structuredOutput);
  if (!parsed.success) return [];
  return parsed.data.captures.map((c) => ({ label: c.label, path: c.path, viewport: c.viewport }));
}

/** `.reeve/test-report.md` — the durable record of what this run checked. */
function composeReport(output: TestingOutput): string {
  const out: string[] = [`> ${output.summary}`, '>', `> **Tests:** ${output.passed ? 'green' : 'failing'}`, ''];

  if (output.criteria.length) {
    out.push('## Acceptance criteria', '');
    for (const c of output.criteria) {
      out.push(`- [${c.verdict === 'pass' ? 'x' : ' '}] ${c.index}. ${c.evidence}`);
    }
    out.push('');
  }
  if (output.failures.length) {
    out.push('## Failures', '');
    for (const f of output.failures) out.push(`- \`${f.test}\` — ${f.reason}${f.fixed ? ' (fixed in this run)' : ''}`);
    out.push('');
  }
  if (output.fixes_applied.length) {
    out.push('## Fixes applied', '');
    for (const f of output.fixes_applied) out.push(`- ${f}`);
    out.push('');
  }
  if (output.differences.length) {
    out.push('## Differences from the mockups', '');
    output.differences.forEach((d, i) => out.push(`${i + 1}. **${d.claim}** ${d.note}`));
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
