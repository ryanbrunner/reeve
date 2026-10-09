/**
 * What a run has spent while it is still going.
 *
 * The SDK reports cost exactly, but only when a turn ends, and a turn of In
 * Progress, or a worker's whole build, can run for twenty minutes without
 * one. In between, the tokens each assistant message reports are priced here,
 * and the card says "≈". The exact figure replaces the estimate at the next
 * turn's end, so a price that drifts out of date only ever skews the part of
 * a run since its last result.
 *
 * List prices per million tokens, Anthropic first party, as of 2026-09. A
 * model this does not recognise gets no estimate rather than a wrong one.
 */
export interface ModelPrice {
  input: number;
  output: number;
  /** Five-minute cache writes. */
  cacheWrite: number;
  cacheRead: number;
}

const price = (input: number, output: number, cacheRead = input / 10): ModelPrice => ({
  input,
  output,
  cacheWrite: input * 1.25,
  cacheRead,
});

/**
 * Matched in order against the model string a run was sent or a message
 * names: an alias (`opus`), a full id (`claude-opus-5-5`), or either with a
 * suffix (`[1m]`). The first pattern that matches wins, so the newer versions
 * come before the family's catch-all.
 */
const PRICES: Array<[RegExp, ModelPrice]> = [
  [/fable|mythos/, price(10, 50, 0.25)],
  // A bare alias is the current generation of its family.
  [/^opus(\[|$)|opus-5-5/, price(4, 20, 0.2)],
  [/opus/, price(5, 25)],
  [/^sonnet(\[|$)|sonnet-5/, price(2, 10, 0.2)],
  [/sonnet/, price(3, 15)],
  [/haiku/, price(1, 5)],
];

export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const m = model.toLowerCase();
  return PRICES.find(([pattern]) => pattern.test(m))?.[1] ?? null;
}

/** The token counts an assistant message's `usage` carries. */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Dollars for one message's usage, or null for a model with no known price. */
export function costOf(model: string | null | undefined, usage: TokenUsage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  return (
    ((usage.input_tokens ?? 0) * p.input +
      (usage.output_tokens ?? 0) * p.output +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead) /
    1_000_000
  );
}
