// forge: a GitHub-compatible git forge in a single Node process.
// Surfaces: git smart HTTP (protocol v2 upload-pack, v0 receive-pack), REST v3,
// GraphQL v4 and MCP, all over one in-memory store. Node standard library only.
//
// Lifecycle: bind an ephemeral port and print it. If $FORGE_ENV_URL names a
// supervisor, register with it and exit when it reports the run is done.

import { startForge } from './src/http.ts';

startForge().catch((err: unknown) => {
  process.stderr.write(`forge failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
