import { useCallback, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'reeve:collapsed-lanes';

/**
 * Which lanes are shut, keyed by project id, or `'none'` for No project.
 *
 * Kept in this browser's localStorage rather than on the server: which lanes
 * someone is watching is a view preference, not card data, and a column for
 * it would cost a migration and a route to remember a toggle. Not in the URL
 * either — unlike `?card=`, nobody wants to send a link to a set of folded
 * lanes.
 *
 * Ids of archived projects are left in storage. They match no lane, so they do
 * nothing, and pruning them would tie this hook to the board's data.
 */
export function useCollapsedLanes() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(read);

  // Written from an effect rather than inside the updater, which StrictMode
  // calls twice and which should not have side effects anyway.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
    } catch {
      // Storage full or blocked: the toggle still works, it just won't survive a reload.
    }
  }, [collapsed]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const isCollapsed = useCallback((key: string) => collapsed.has(key), [collapsed]);

  return useMemo(() => ({ isCollapsed, toggle }), [isCollapsed, toggle]);
}

/**
 * Whatever was stored, or nothing shut. A value that is not a list of strings —
 * hand-edited, or left by some later version — falls back to every lane open
 * rather than taking the board down with it.
 */
function read(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (Array.isArray(parsed) && parsed.every((k) => typeof k === 'string')) return new Set(parsed);
  } catch {
    // Unparseable: treated the same as absent.
  }
  return new Set();
}
