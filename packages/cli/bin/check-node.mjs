// Below the engines floor, registering tsx or dynamically importing the
// bundle can fail with a loader or syntax error that gives no hint what is
// wrong. Checked here, as a side effect of importing this file, so both
// `reeve.js` entries — bin/reeve.js in a checkout, dist-entry.mjs once
// published — run the same guard before either of them reaches the import
// that can blow up: a static import of this file is safe on any Node that
// can parse `import`, since it touches nothing but `node:module` and this
// package's own `package.json`. Guarded by a try/catch: a range this
// doesn't recognize, or a missing package.json, should fail open rather
// than block every `reeve` command on a check meant to help.
//
// `../package.json` resolves to `packages/cli/package.json` from both
// `bin/` (a checkout) and `dist/` (published), the same file main.ts reads
// for `reeve --version`.
import { createRequire } from 'node:module';

try {
  const require = createRequire(import.meta.url);
  const { engines } = require('../package.json');
  const match = /^>=(\d+(?:\.\d+)*)$/.exec(engines.node);
  if (match) {
    const toParts = (version) => version.split('.').map(Number);
    const required = toParts(match[1]);
    const actual = toParts(process.versions.node);
    let isNewEnough = true;
    for (let i = 0; i < required.length; i++) {
      const have = actual[i] || 0;
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
