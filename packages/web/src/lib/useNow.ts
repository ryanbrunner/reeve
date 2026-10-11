import { useEffect, useState } from 'react';

/**
 * The time, moving on by itself every `ms` while `enabled`: for a clock that
 * has to count up between polls, as an elapsed time on a call still running.
 */
export function useNow(enabled: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [enabled, ms]);
  return now;
}
