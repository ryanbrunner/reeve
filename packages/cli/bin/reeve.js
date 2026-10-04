#!/usr/bin/env node
// Plain JS so node can run it before anything can compile TypeScript. tsx is
// resolved from here rather than from the cwd, so `reeve` works in any directory.
import { createRequire } from 'node:module';

// Below the engines floor, `register()` or the import that follows can fail
// with a loader or syntax error that gives no hint what is wrong. Check first
// so an old Node gets a sentence instead of a stack trace. Guarded by a
// try/catch: a range this doesn't recognize, or a missing root package.json,
// should fail open rather than block every `reeve` command on this check.
try {
  const require = createRequire(import.meta.url);
  const { engines } = require('../../../package.json');
  const match = /^>=(\d+(?:\.\d+)*)$/.exec(engines.node);
  if (match) {
    const toParts = (version) => version.split('.').map(Number);
    const required = toParts(match[1]);
    const actual = toParts(process.versions.node);
    let isNewEnough = true;
    for (let i = 0; i < required.length; i++) {
      const have = actual[i] ?? 0;
      const want = required[i];
      if (have !== want) {
        isNewEnough = have > want;
        break;
      }
    }
    if (!isNewEnough) {
      console.error(`Reeve needs Node ${engines.node} (found ${process.versions.node}).`);
      process.exit(1);
    }
  }
} catch {
  // Can't tell, so don't block the command on it.
}

// A dynamic import, so the version check above runs before tsx's own loader
// does, rather than being hoisted above it the way a static import would be.
const { register } = await import('tsx/esm/api');

register();
await import('../src/main.ts');
