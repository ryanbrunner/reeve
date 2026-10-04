import type { MiddlewareHandler } from 'hono';

/**
 * The server binds loopback and has no auth, so a browser same-origin check
 * is the only thing between a page on another site and every mutating route
 * — and DNS rebinding (a name that resolves to 127.0.0.1 only after that
 * check passed) gets around even that. `Host` and `Origin` are what is left
 * to ask: a browser sets both from the page's own navigation and neither can
 * be overridden by script, unlike a header a `fetch` call chooses itself.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuses a mutating request whose `Host` is not loopback, or whose `Origin`
 * — when a browser sent one — is not either. Mounted once, ahead of every
 * route: GETs (the board, the SSE stream, assets) pass through untouched,
 * since nothing short of reading the board is at stake there and the CLI's
 * polling has no reason to carry an Origin at all.
 *
 * `c.req.url` is what `@hono/node-server` built from the `Host` header, not
 * the header read back, so a request with no `Host` at all — `app.request()`
 * in a spike — resolves to `localhost` and passes rather than being refused
 * for a header nothing but a real browser sends.
 */
export const sameOriginGuard: MiddlewareHandler = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const host = new URL(c.req.url).hostname;
  if (!isLoopback(host)) {
    return c.json({ error: 'refused', detail: `Host must be loopback, not ${host}` }, 403);
  }

  // Absent for the CLI and the spikes, which carry no Origin at all; a
  // literal "null" (an opaque origin, such as a sandboxed iframe) is refused
  // same as a foreign one. Dev's Vite proxy forwards the browser's own
  // Origin unchanged, so this allows any loopback port rather than only the
  // server's.
  const origin = c.req.header('origin');
  if (origin !== undefined) {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return c.json({ error: 'refused', detail: `Origin must be loopback, not ${origin}` }, 403);
    }
    if (!isLoopback(originHost)) {
      return c.json({ error: 'refused', detail: `Origin must be loopback, not ${origin}` }, 403);
    }
  }

  return next();
};

/**
 * Chained onto routes that call `c.req.json()`, since Hono does not check
 * the content type for them itself: a plain cross-site `<form method=post>`
 * reaches a route with no CORS preflight at all, sending `text/plain` or
 * `application/x-www-form-urlencoded`. A request with no body is let through
 * regardless — a bodyless `POST` the web app or the CLI sends to a route
 * that happens to parse JSON falls back to each handler's own `({})` — so
 * this only ever rejects a body of the wrong kind, never a missing one.
 */
export const requireJson: MiddlewareHandler = async (c, next) => {
  const length = c.req.header('content-length');
  const chunked = c.req.header('transfer-encoding');
  if ((!length || length === '0') && !chunked) return next();

  const type = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    return c.json({ error: 'unsupported content type', detail: 'expected application/json' }, 415);
  }
  return next();
};
