#!/usr/bin/env node
// Plain JS so node can run it before anything can compile TypeScript. tsx is
// resolved from here rather than from the cwd, so `reeve` works in any directory.
//
// check-node.mjs's version guard runs as a side effect of this static
// import — safe below the engines floor, since it touches nothing but
// node:module and a package.json. tsx/esm/api is a dynamic import instead,
// so that register() and the import that follows run only once the guard
// has passed; a static import of either would be hoisted above the check
// the way this one isn't.
import './check-node.mjs';

const { register } = await import('tsx/esm/api');

register();
await import('../src/main.ts');
