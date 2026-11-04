import { useQuery } from '@tanstack/react-query';
import { DEFAULT_VIBES_OPTIONS, type VibesOptions } from '@reeve/shared';
import { api } from '../lib/api.js';

/**
 * Settings' VIBES MODE options, for everything that names what VIBES MODE
 * does: the overlay, the ticker, the taped-off wells, the chips and switches.
 * Until Settings answers, the reading a board with no settings row has, which
 * is also what the server does then, so nothing promises the wrong thing.
 */
export function useVibesOptions(): VibesOptions {
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  return data?.vibesOptions ?? DEFAULT_VIBES_OPTIONS;
}

/** "approves, answers and merges", or without the merge when Settings keeps that for a person. */
export function whatClaudeDoes(options: VibesOptions, answers = false): string {
  const verbs = ['approves', ...(answers ? ['answers'] : []), ...(options.autoMerge ? ['merges'] : [])];
  return verbs.length === 1 ? verbs[0]! : `${verbs.slice(0, -1).join(', ')} and ${verbs.at(-1)}`;
}
