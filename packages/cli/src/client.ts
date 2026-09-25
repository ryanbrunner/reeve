/**
 * How every command that talks to a running server finds it and asks it
 * things. Only `serve` imports the server itself; the rest go over HTTP, so
 * they work against a server started any other way and never open the
 * database behind its back.
 */

/** Where a plain `reeve serve` listens: `hostname` and the default port in the server's config.ts. */
export const DEFAULT_URL = 'http://127.0.0.1:4317';

/** `--url`, then `REEVE_URL`, then the default. */
export function serverUrl(flag?: string): string {
  return (flag ?? process.env.REEVE_URL ?? DEFAULT_URL).replace(/\/+$/, '');
}

/** Nothing answered at all, as opposed to a server that answered with an error. */
export class ServerUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    super(`no Reeve server at ${url} (${reason(cause)})`, { cause });
  }
}

export interface Client {
  url: string;
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

export function connect(url: string): Client {
  return {
    url,
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      let res: Response;
      try {
        res = await fetch(`${url}${path}`, init);
      } catch (e) {
        throw new ServerUnreachableError(url, e);
      }
      if (!res.ok) {
        // The same shape the web client reads (packages/web/src/lib/api.ts):
        // `detail` is the sentence worth showing, `error` the label for it.
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        const message = body.detail ? `${body.error}: ${body.detail}` : body.error;
        throw new Error(message ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    },
  };
}

/**
 * Whether a Reeve server is answering at `client.url`. Bounded, so a port held
 * by something that accepts connections and never replies cannot hang a script.
 */
export async function health(client: Client, timeoutMs = 2_000): Promise<void> {
  const notReeve = new Error(`something at ${client.url} answered, but not as Reeve`);
  const body = await client
    .request<{ ok?: boolean }>('/healthz', { signal: AbortSignal.timeout(timeoutMs) })
    .catch((e: unknown) => {
      throw e instanceof ServerUnreachableError ? e : notReeve;
    });
  if (body.ok !== true) throw notReeve;
}

// fetch reports every network failure as a bare "fetch failed" and keeps the
// useful part, ECONNREFUSED or "bad port", on its cause.
function reason(e: unknown): string {
  if (e instanceof DOMException && e.name === 'TimeoutError') return 'timed out';
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause as { code?: unknown; message?: unknown } | undefined;
  if (typeof cause?.code === 'string') return cause.code;
  if (typeof cause?.message === 'string') return cause.message;
  return e.message;
}
