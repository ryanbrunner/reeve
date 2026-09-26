#!/usr/bin/env node
// Plain JS so node can run it before anything can compile TypeScript. tsx is
// resolved from here rather than from the cwd, so `reeve` works in any directory.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
