import { startServer } from './index.js';

// The boot script behind `npm run dev` and `npm run start`. `reeve` boots the
// same way from the CLI; both go through startServer so they cannot drift.
await startServer();
