#!/usr/bin/env node
// Bundles this workspace, @reeve/server and @reeve/shared into the one
// package npm actually publishes, and copies beside the bundle the files it
// reads off disk at runtime instead of importing: the drizzle migrations,
// the stage prompts and the built web app. config.ts (packages/server/src)
// looks for all three next to dist/ once it decides it is not in a checkout.
//
// Run by `npm run build` here, and by `prepack` before `npm pack`/`publish`
// so a forgotten build never ships a stale or missing dist/.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // packages/cli
const repoRoot = resolve(pkgRoot, '../..');

for (const dir of ['dist', 'drizzle', 'web', 'prompts']) {
  rmSync(resolve(pkgRoot, dir), { recursive: true, force: true });
}

// Built fresh every time rather than only when missing, so a stale
// packages/web/dist from an earlier session can never ship silently; this is
// also what lets `npm pack`/`publish` work from a clean clone with no manual
// build step first.
execFileSync('npm', ['run', 'build', '--workspace', '@reeve/web'], { cwd: repoRoot, stdio: 'inherit' });

// Left external so npm installs them the normal way: better-sqlite3 and
// Playwright both carry native/browser binaries bundling would not help
// with, and the Agent SDK locates its own cli.js relative to its own
// package, which only holds if that package is actually on disk.
const EXTERNAL = [
  '@anthropic-ai/claude-agent-sdk',
  '@hono/node-server',
  'better-sqlite3',
  'drizzle-orm',
  'hono',
  'playwright',
  'zod',
];

await build({
  entryPoints: [resolve(pkgRoot, 'src/main.ts')],
  outdir: resolve(pkgRoot, 'dist'),
  // Named 'app' rather than 'reeve', which package.json's `bin` field
  // points at instead: dist/reeve.js is bin/dist-entry.mjs, copied in
  // below, a plain unbundled shim that checks the Node version before
  // dynamically importing this bundle. A static import of the bundle from
  // that shim would be hoisted above its check, defeating it.
  entryNames: 'app',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Code-split rather than one file: serve.ts reaches @reeve/server only
  // through a dynamic import, so every other command starts without paying
  // to load better-sqlite3, Playwright and the Agent SDK. A single output
  // file would hoist those imports to the top regardless of which command
  // ran; splitting keeps the dynamic import lazy in the bundle too.
  splitting: true,
  external: EXTERNAL,
  logLevel: 'info',
});

cpSync(resolve(repoRoot, 'packages/server/src/stages/prompts'), resolve(pkgRoot, 'prompts'), { recursive: true });
cpSync(resolve(repoRoot, 'packages/server/drizzle'), resolve(pkgRoot, 'drizzle'), { recursive: true });
cpSync(resolve(repoRoot, 'packages/web/dist'), resolve(pkgRoot, 'web/dist'), { recursive: true });

// The file package.json's `bin` field actually points at: a shim that
// guards dist/app.js the way bin/reeve.js guards tsx and src/main.ts in a
// checkout, by statically importing check-node.mjs, which has to travel
// with it since `bin/` is not in `files` and so ships only via this copy.
// Both are plain JS old enough Nodes can parse, copied rather than built.
// cpSync doesn't reliably carry over the execute bit, so it's set
// explicitly on the one file npm actually runs.
cpSync(resolve(pkgRoot, 'bin/check-node.mjs'), resolve(pkgRoot, 'dist/check-node.mjs'));
cpSync(resolve(pkgRoot, 'bin/dist-entry.mjs'), resolve(pkgRoot, 'dist/reeve.js'));
chmodSync(resolve(pkgRoot, 'dist/reeve.js'), 0o755);
