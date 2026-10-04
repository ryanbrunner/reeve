import { Hono } from 'hono';
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { Db } from '../db/client.js';
import { getAsset } from '../db/queries.js';
import { absoluteAssetPath } from '../assets/store.js';

/**
 * Serving the bytes of a mockup or screenshot.
 *
 * Its own tiny router because it hangs off `/api/assets/:id` rather than a
 * card, which is what lets an `<img src>` reference one without the page
 * knowing which card it came from.
 */
export function assetRoutes(db: Db) {
  const routes = new Hono();

  // Defense in depth: the upload route already checks that an asset's bytes
  // match its declared type, but nosniff means a browser never second-guesses
  // that type from the bytes itself, on this response or the 404/410 beside it.
  routes.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
  });

  routes.get('/:id', (c) => {
    const row = getAsset(db, c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);

    // The path is server-generated and never user input, but a row whose file
    // has been removed is a real state — say so rather than throwing.
    const full = absoluteAssetPath(row.path);
    if (!existsSync(full)) return c.json({ error: 'asset file is missing', detail: row.path }, 410);

    return new Response(Readable.toWeb(createReadStream(full)) as ReadableStream, {
      headers: {
        'content-type': row.contentType,
        // Bytes at an id never change: a new picture is a new row.
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  });

  return routes;
}
