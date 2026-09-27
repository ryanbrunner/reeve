import { readFileSync } from 'node:fs';
import type { Db } from '../db/client.js';
import { cardsLinkingOthersPastedAssets, getAsset, insertAsset, rewriteCardBody } from '../db/queries.js';
import { PASTED_IMAGE, absoluteAssetPath, assetSrc, relativeAssetPath, writeAsset } from './store.js';

/**
 * A card's brief with each pasted image it links that belongs to another card
 * swapped for a copy of its own, file and row.
 *
 * Claude writes a task's brief from the project's, links and all, and a link
 * left alone points at the project's row. That row cascades off the project,
 * so deleting the project would break the picture in every task, on the page
 * and in the files a run is told the brief's images are. A copy belongs to the
 * card, and goes when the card does.
 *
 * A link to anything but a pasted image is left as it was written, and so is
 * one whose file has gone: a copy of nothing would only move the break. So is
 * a link to one of the card's own, which is what makes calling this twice on
 * the same card copy nothing the second time. An image linked twice is copied
 * once.
 */
export function copyPastedImages(db: Db, cardId: string, body: string): string {
  const copies = new Map<string, string>();
  for (const [, , id] of body.matchAll(PASTED_IMAGE)) {
    if (!id || copies.has(id)) continue;
    const row = getAsset(db, id);
    if (row?.kind !== 'pasted' || row.cardId === cardId) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(absoluteAssetPath(row.path));
    } catch {
      continue;
    }
    const rel = relativeAssetPath(cardId, crypto.randomUUID(), row.contentType);
    writeAsset(rel, bytes);
    const copy = insertAsset(db, {
      cardId,
      kind: 'pasted',
      label: row.label,
      path: rel,
      contentType: row.contentType,
      width: row.width,
      height: row.height,
    });
    copies.set(id, copy.id);
  }
  if (!copies.size) return body;
  return body.replace(PASTED_IMAGE, (link, alt: string, id: string) => {
    const copy = copies.get(id);
    return copy ? `![${alt}](${assetSrc(copy)})` : link;
  });
}

/**
 * Give every card still linking another card's pasted image a copy of its
 * own, and return how many briefs were rewritten.
 *
 * For the tasks split before the split made copies, whose briefs still point
 * at the project's rows. Nothing hard-deletes a project with tasks today, and
 * pruning keeps an image any brief links, so nothing has broken yet; this is
 * so that nothing does once something deletes one.
 *
 * Run at every boot rather than once, because it costs one select when there
 * is nothing to do, and because a split is not the only way a brief can come
 * to link another card's image: a link is only Markdown, and can be written
 * from the CLI or pasted into the editor as text.
 * A link whose file has gone is left, and found again on the next boot to be
 * left again.
 */
export function adoptPastedImages(db: Db): number {
  let rewritten = 0;
  for (const c of cardsLinkingOthersPastedAssets(db)) {
    const body = copyPastedImages(db, c.id, c.body);
    if (body === c.body) continue;
    rewriteCardBody(db, c.id, body);
    rewritten++;
  }
  return rewritten;
}
