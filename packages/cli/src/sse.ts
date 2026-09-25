/**
 * Server-sent events off a fetch body. Node has no EventSource, and the part
 * of the format Reeve's stream uses — `id`, `event`, `data`, a blank line to
 * end each — is small enough that a dependency would be the larger thing.
 * Reconnecting is the caller's, which knows the last id it saw.
 */

export interface SseEvent {
  /** The run's event seq, as the server numbers them. Null for `ping` and `end`, which carry none. */
  id: string | null;
  event: string;
  data: string;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let id: string | null = null;
  let event = '';
  let data: string[] = [];

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    // Hono ends lines with `\n`. A `\r` before one is dropped; a bare `\r`,
    // which the spec also allows, is never sent.
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);

      if (line === '') {
        // An event with no data is not dispatched, per the spec, and the
        // stream never sends one that matters without any.
        if (data.length > 0) yield { id, event: event || 'message', data: data.join('\n') };
        id = null;
        event = '';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id') id = value;
    }
  }
}
