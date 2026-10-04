import type { Context, MiddlewareHandler } from 'hono';

/**
 * Loopback binding alone does not stop a page open in the same browser as
 * Reeve from reaching the API: a plain `<form>` or `fetch` fires a "simple
 * request" (GET or POST, no custom header) with no preflight to fail, and
 * ordinary cross-site CSRF is blind only because there is no CORS header to
 * read the answer with. DNS rebinding removes even that limit — a rebound
 * page is same-origin and reads every response — so the gate here is on the
 * request itself, not on what the response discloses.
 *
 * Checked against the raw `Host`/`Origin` headers, which is what a browser
 * sends and a forged request cannot pick: a reverse proxy could rewrite
 * them, but Reeve has none, and the Vite dev proxy forwards them unchanged
 * (`changeOrigin: false` in packages/web/vite.config.ts).
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * `host` as a browser would send it, `host:port` or a bare IPv6 literal in
 * brackets. Parsed through a dummy URL rather than split on ':', so an IPv6
 * address's own colons do not break the port off in the wrong place.
 */
function loopbackHostname(host: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/**
 * The `Host` a real request carries, falling back to the request's own URL
 * for the one caller with no header to read: a spike's in-process
 * `app.request('/api/...')`, which Hono answers against a bare `localhost`
 * URL rather than a socket with headers at all. A request `serve()` actually
 * accepted always has a `Host` — HTTP/1.1 requires one — so this fallback
 * never masks a real header a browser sent.
 */
function hostOf(c: Context): string {
  return c.req.header('host') ?? new URL(c.req.url).host;
}

/**
 * Refuses any `/api` request whose `Host` is not a loopback name, on any
 * port — a card's own dev server and Testing's screenshots run on whatever
 * port the repo was given, so the port itself says nothing — and any request
 * that carries an `Origin` that is not loopback either. A request with no
 * `Origin` at all is let through rather than refused: the CLI's and the
 * stage runs' own `fetch` send none, and treating a missing header as
 * hostile would break them, not an attacker.
 *
 * `Origin: null`, which a sandboxed iframe or a `file://` page sends, fails
 * the same parse a forged hostname would and is refused with it.
 */
export function originAndHostGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!loopbackHostname(hostOf(c))) {
      return c.json({ error: 'refused', detail: `Host '${hostOf(c)}' is not Reeve's own` }, 403);
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && !loopbackHostname(safeHostname(origin))) {
      return c.json({ error: 'refused', detail: `Origin '${origin}' is not Reeve's own` }, 403);
    }
    await next();
  };
}

/** The hostname of an Origin header, or '' for one that cannot be parsed as a URL — `null` included. */
function safeHostname(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

/**
 * Requires `content-type: application/json` on a route that otherwise parses
 * whatever bytes made it into the body regardless of what the request
 * declared — `c.req.json().catch(() => ({}))`'s whole point is that absent or
 * malformed JSON becomes `{}`, which also waves through a `text/plain` body a
 * plain `<form>` can send with no preflight to fail. Matched on the media
 * type alone, so `application/json; charset=utf-8` still passes.
 */
export function requireJsonContentType(c: Context): Response | null {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json') return null;
  return c.json(
    { error: 'unsupported content-type', detail: `expected application/json, got '${contentType || 'none'}'` },
    415,
  );
}
