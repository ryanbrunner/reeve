#!/usr/bin/env node
// The CLI is TypeScript run by tsx, like the server. Registered here rather
// than through a `#!/usr/bin/env tsx` line so tsx resolves from this package
// instead of from PATH, where it usually is not.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
