import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { VibeState } from '@reeve/shared';
import { api } from '../lib/api.js';

/**
 * `off` and `on` are the stored setting. `arming` is the two seconds between
 * the click and the consequences: the board is already in SICKO MODE — the
 * server was told the moment the switch was pressed — but the sweep has not
 * been watched yet and the overlay is still reading out which guardrails have
 * just come off.
 */
export type SickoPhase = 'off' | 'arming' | 'on';

/** How long the arming overlay holds. The only confirmation step this has. */
const ARM_MS = 2_000;

/** How long "you were out" stays on screen after the switch goes off. */
const TOAST_MS = 7_000;

/** Back-to-back merges are common; the screen going white twice in a blink is not. */
const FLASH_MS = 700;

export interface Sicko {
  phase: SickoPhase;
  /** Dressed as SICKO MODE — true through `arming` as well as `on`. */
  sick: boolean;
  /** Whether cards are actually being moved without anyone asking. */
  live: boolean;
  state: VibeState | null;
  /** Flipped on each merge so a CSS animation can be restarted by changing class. */
  shake: boolean;
  pop: boolean;
  /** Null except for the half-second after something landed on main. */
  flash: boolean | null;
  /** Cards that landed since the last board poll, by id: these get the stamp. */
  justMerged: ReadonlySet<string>;
  toast: string | null;
  toggle: () => void;
  pending: boolean;
}

/**
 * The client half of SICKO MODE: the arming overlay, the goodbye toast, and the
 * three one-shot flourishes a merge sets off.
 *
 * Everything durable — since when, and every number the HUD shows — comes off
 * the board response, so a reload lands back in the same place with the same
 * totals. Only what is inherently momentary lives here.
 */
export function useSicko(
  state: VibeState | null,
  mergedIds: readonly string[],
  /**
   * Whether a board has arrived at all. Without it the loading render — no
   * data, so no merged cards — counts as the first reading, and the real board
   * that follows reads as every card in Done having just landed: a reload with
   * SICKO MODE on would stamp old cards MERGED, flash the screen and shake the
   * stage for work that finished days ago.
   */
  ready: boolean,
): Sicko {
  const qc = useQueryClient();
  const [arming, setArming] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [pop, setPop] = useState(false);
  const [flash, setFlash] = useState<boolean | null>(null);
  const [justMerged, setJustMerged] = useState<ReadonlySet<string>>(() => new Set());
  const lastFlashAt = useRef(0);
  // What the board said last, read by `toggle` to fill in the toast. A ref
  // rather than a dependency so the callback stays stable across polls.
  const latest = useRef(state);
  latest.current = state;

  const set = useMutation({
    mutationFn: (vibe: boolean) => api.updateSettings({ vibe }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['board'] }),
  });

  const on = state !== null;
  const phase: SickoPhase = arming && on ? 'arming' : on ? 'on' : 'off';

  // The switch going off elsewhere — Settings, another tab, a server restart —
  // must not leave the overlay up over a calm board.
  useEffect(() => {
    if (!on) setArming(false);
  }, [on]);

  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(false), ARM_MS);
    return () => clearTimeout(t);
  }, [arming]);

  useEffect(() => {
    if (toast === null) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  /*
   * A merge is three things at once: the board jumps, the screen flashes, and
   * the counter pops. Driven off the ids the board reports rather than off the
   * count, so a poll that brings two merges still fires once and the stamp
   * knows which cards to sit on.
   */
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    const before = seen.current;
    const now = new Set(mergedIds);
    seen.current = now;
    // The first real board: everything already merged is old news.
    if (before === null) return;
    const fresh = mergedIds.filter((id) => !before.has(id));
    if (fresh.length === 0) return;
    setJustMerged(new Set(fresh));
    setShake((s) => !s);
    setPop((p) => !p);
    const at = Date.now();
    if (at - lastFlashAt.current > FLASH_MS) {
      lastFlashAt.current = at;
      setFlash((f) => (f === null ? true : !f));
    }
  }, [mergedIds, ready]);

  // The stamp is a moment, not a state: it slams on, holds, and goes, leaving
  // the card wearing its merged glow.
  useEffect(() => {
    if (justMerged.size === 0) return;
    const t = setTimeout(() => setJustMerged(new Set()), 2_600);
    return () => clearTimeout(t);
  }, [justMerged]);

  const toggle = useCallback(() => {
    if (latest.current === null) {
      setToast(null);
      setArming(true);
      set.mutate(true);
      return;
    }
    const { moves, merged } = latest.current;
    setArming(false);
    setToast(
      `You’re back in the loop · ${count(moves, 'move')} and ${count(merged, 'merge')} while you were out`,
    );
    set.mutate(false);
  }, [set]);

  return {
    phase,
    sick: phase !== 'off',
    live: phase === 'on',
    state,
    shake,
    pop,
    flash,
    justMerged,
    toast,
    toggle,
    pending: set.isPending,
  };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
