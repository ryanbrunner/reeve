import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';

/**
 * Where a card's images live: `data/assets/<cardId>/<assetId>.<ext>`.
 *
 * Stored relative to `config.assetsDir` so the data directory can move without
 * rewriting every row, and namespaced by card so deleting a card's files is one
 * directory rather than a query.
 */

export const CONTENT_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Generous for a screenshot, small enough that a stray upload can't fill a disk. */
export const MAX_ASSET_BYTES = 12 * 1024 * 1024;

/**
 * What every asset's route starts with, ahead of its id. Exported for the one
 * place that cannot call `assetSrc`: `prunePastedAssets` asks SQLite which
 * briefs link an image, row by row, so it builds the link there. A prune whose
 * idea of the route had drifted from the page's would find every pasted image
 * unlinked, and delete each an hour after it was pasted.
 */
export const ASSET_ROUTE = '/api/assets/';

/** The route the page is given for an asset; its path on disk never leaves the server. */
export const assetSrc = (assetId: string) => `${ASSET_ROUTE}${assetId}`;

/**
 * An image the brief's editor pasted in, by the `src` the page was given for
 * it: `![alt](/api/assets/<id>)`, with the alt and the id captured. Beside
 * `assetSrc` so the route and the pattern that reads it back change together,
 * and one constant so Claude's brief and the pull request's description cannot
 * disagree about which links are images.
 *
 * Global, so it is for `matchAll` and `replace`, which start from the top
 * every time; `test` or `exec` on it would carry `lastIndex` from one call to
 * the next.
 */
export const PASTED_IMAGE = /!\[([^\]\n]*)\]\(\/api\/assets\/([\w-]+)\)/g;

export function relativeAssetPath(cardId: string, assetId: string, contentType: string): string {
  return join(cardId, `${assetId}.${CONTENT_TYPES[contentType] ?? 'bin'}`);
}

export function absoluteAssetPath(relative: string): string {
  return join(config.assetsDir, relative);
}

export function writeAsset(relative: string, bytes: Buffer): void {
  const full = absoluteAssetPath(relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
}

/** Best effort: a row without its file is worse than a file without its row. */
export function deleteAsset(relative: string): void {
  try {
    rmSync(absoluteAssetPath(relative), { force: true });
  } catch {
    // The row is going either way.
  }
}

/**
 * Pixel dimensions, read out of the file's own header.
 *
 * Thirty lines against a dependency: the modal needs an aspect ratio so a
 * thumbnail doesn't reflow when the image loads, and that is all it needs.
 * Anything unrecognised returns null and the UI falls back to a fixed box.
 */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  // PNG: an 8-byte signature, then IHDR with width and height as big-endian u32.
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  // WebP: RIFF container. Only the common VP8X/VP8L/VP8 lossy headers.
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return { width: (bytes.readUIntLE(24, 3) & 0xffffff) + 1, height: (bytes.readUIntLE(27, 3) & 0xffffff) + 1 };
    }
    if (chunk === 'VP8 ') {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
  }

  // JPEG: walk the segment markers to whichever SOF carries the dimensions.
  if (bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1]!;
      // SOF0-SOF15, skipping the four that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }

  return null;
}
