/**
 * Put text on the clipboard, and say whether it got there.
 *
 * `navigator.clipboard` only exists in a secure context. The server binds to
 * 127.0.0.1, which counts, so in practice it is always there. But a browser
 * can still refuse the write, and a caller that `await`s a rejection it never
 * expected would show nothing at all. So this never throws; it answers
 * `false`, and the caller decides what a failure looks like.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
