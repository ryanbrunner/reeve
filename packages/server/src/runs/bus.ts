import { EventEmitter } from 'node:events';

export interface EmittedEvent {
  runId: string;
  seq: number;
  kind: string;
  payload: string;
  at: number;
}

type Listener = (e: EmittedEvent) => void;

/**
 * Fan-out to attached SSE clients.
 *
 * Deliberately NOT the source of truth: the writer persists every event and
 * only then publishes here, so a run with nobody watching needs no special
 * case, and a subscriber can never see an event that isn't already in the
 * database (which would break replay de-duplication).
 *
 * A plain EventEmitter is right for one user on localhost. A broadcast channel
 * would introduce a bounded-buffer lag problem the database already solves.
 */
class RunBus {
  private readonly emitters = new Map<string, EventEmitter>();

  private emitterFor(runId: string): EventEmitter {
    let e = this.emitters.get(runId);
    if (!e) {
      e = new EventEmitter();
      // Several browser tabs on one run is normal; the default of 10 is not a
      // leak signal here.
      e.setMaxListeners(64);
      this.emitters.set(runId, e);
    }
    return e;
  }

  publish(event: EmittedEvent): void {
    this.emitters.get(event.runId)?.emit('event', event);
  }

  /** Returns the unsubscribe function. Callers MUST invoke it on disconnect. */
  subscribe(runId: string, listener: Listener): () => void {
    const emitter = this.emitterFor(runId);
    emitter.on('event', listener);
    return () => {
      emitter.off('event', listener);
      if (emitter.listenerCount('event') === 0) this.emitters.delete(runId);
    };
  }

  listenerCount(runId: string): number {
    return this.emitters.get(runId)?.listenerCount('event') ?? 0;
  }
}

export const runBus = new RunBus();
