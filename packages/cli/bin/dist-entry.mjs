#!/usr/bin/env node
// The published `bin` entry: package.json's `bin` field points `reeve` at
// dist/reeve.js, this file once scripts/build.mjs has copied it there.
// It guards dist/app.js, the actual bundle, the same way bin/reeve.js
// guards tsx and src/main.ts in a checkout — check-node.mjs's version
// guard runs as a side effect of the static import below, and app.js is
// a dynamic one so it loads only once that guard has passed. build.mjs
// names the bundle's entry point 'app' precisely so it never collides
// with this file.
import './check-node.mjs';

await import('./app.js');
