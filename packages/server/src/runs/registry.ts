import type { RunKind, StopReason } from '@reeve/shared';

export interface ActiveRun {
  runId: string;
  kind: RunKind;
  cardId: string;
  /** A task beside the card's stage, which does not hold the card's run lock. See ClaudeTask.outOfBand. */
  outOfBand?: boolean;
  /** Best-effort graceful stop, then force. Resolves once the run is terminal. */
  stop: (reason: StopReason) => Promise<void>;
}

/**
 * In-memory index of runs this process owns. Anything in here but not running
 * is a bug; anything running but not in here survived a restart and belongs to
 * the boot reaper instead.
 */
class RunRegistry {
  private readonly active = new Map<string, ActiveRun>();

  register(run: ActiveRun): void {
    this.active.set(run.runId, run);
  }

  unregister(runId: string): void {
    this.active.delete(runId);
  }

  get(runId: string): ActiveRun | undefined {
    return this.active.get(runId);
  }

  all(): ActiveRun[] {
    return [...this.active.values()];
  }

  countByKind(kind: RunKind): number {
    return this.all().filter((r) => r.kind === kind).length;
  }
}

export const runRegistry = new RunRegistry();
