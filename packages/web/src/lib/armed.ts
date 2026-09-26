import { useEffect, useState } from 'react';

/** How long an armed button waits for the second press before it forgets the first. */
const ARMED_MS = 3_000;

/**
 * A press that only counts as the second of two close together, for a button
 * whose work cannot be taken back from the board — the Merge buttons. It
 * disarms on its own, so a first press left standing is not a merge waiting
 * for whatever click lands on it next.
 */
export function useArmed(): [armed: boolean, setArmed: (armed: boolean) => void] {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  return [armed, setArmed];
}
