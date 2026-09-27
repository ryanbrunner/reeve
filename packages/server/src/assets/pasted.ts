import { readFileSync } from 'node:fs';
import type { Db } from '../db/client.js';
import { getAsset, insertAsset } from '../db/queries.js';
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
