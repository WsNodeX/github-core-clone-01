// makefun-forge: a GitHub-compatible git forge in a single Node process.
// Surfaces: git smart HTTP (protocol v2 upload-pack, v0 receive-pack), REST v3,
// GraphQL v4 and MCP, all over one in-memory store. Node standard library only.
//
// Lifecycle (the contest contract): bind an ephemeral port, POST {"port": N} to
// $MAKEFUN_ENV_URL/register, poll $MAKEFUN_ENV_URL/done, exit 0 when the suite ends.

import { startForge } from './src/http.ts';

startForge().catch((err: unknown) => {
  process.stderr.write(`forge failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
