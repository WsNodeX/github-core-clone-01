// The HTTP server and the trial lifecycle: one Node process serves git smart HTTP,
// REST v3, GraphQL and MCP from the shared store. On boot it binds an ephemeral port,
// POSTs {"port": N} to $MAKEFUN_ENV_URL/register, then polls $MAKEFUN_ENV_URL/done and
// exits 0 when the suite is over. Without MAKEFUN_ENV_URL it just serves (local runs).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import type { Ctx } from './ctx.ts';
import { BadJsonError } from './ctx.ts';
import { advertiseReceivePack, advertiseUploadPack, fetchV0, fetchV2, lsRefs, receivePack } from './gitproto.ts';
import { routeRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

class RequestCtx implements Ctx {
  readonly store: Store;
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: Buffer;
  readonly origin: string;
  private readonly res: ServerResponse;
  private jsonCache: unknown = undefined;
  private jsonParsed = false;

  constructor(store: Store, req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer) {
    this.store = store;
    this.method = req.method ?? 'GET';
    this.segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
    this.query = url.searchParams;
    this.body = body;
    this.origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    this.res = res;
  }

  json(): unknown {
    if (!this.jsonParsed) {
      this.jsonParsed = true;
      try {
        this.jsonCache = JSON.parse(this.body.toString('utf8'));
      } catch {
        throw new BadJsonError();
      }
    }
    return this.jsonCache;
  }

  respond(status: number, contentType: string, body: string | Buffer, headers: Record<string, string> = {}): void {
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    this.res.writeHead(status, {
      'content-type': contentType,
      'content-length': bytes.length,
      'x-github-request-id': this.store.nextRequestId(),
      ...headers,
    });
    this.res.end(bytes);
  }

  jsonBody(status: number, value: unknown, headers: Record<string, string> = {}): void {
    this.respond(status, 'application/json; charset=utf-8', JSON.stringify(value), headers);
  }

  error(status: number, message: string): void {
    this.jsonBody(status, { message });
  }
}

function authorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return true;
  return req.headers.authorization === `Bearer ${expectedToken}`;
}

async function handle(store: Store, expectedToken: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge');
  const body = await readBody(req);
  const ctx = new RequestCtx(store, req, res, url, body);
  const seg = ctx.segments;

  if (url.pathname === '/healthz') {
    ctx.jsonBody(200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (seg.length >= 2 && seg[1].endsWith('.git')) {
    if (!authorized(req, expectedToken)) return ctx.error(401, 'Bad credentials');
    const owner = seg[0];
    const repoName = seg[1].slice(0, -'.git'.length);
    const repo = store.repoFor(owner, repoName);
    if (repo === null) {
      ctx.respond(404, 'text/plain; charset=utf-8', 'repository not found');
      return;
    }
    const tail = seg.slice(2).join('/');
    try {
      if (tail === 'info/refs' && ctx.method === 'GET') {
        const service = ctx.query.get('service');
        const version2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
        if (service === 'git-upload-pack') {
          ctx.respond(200, 'application/x-git-upload-pack-advertisement', advertiseUploadPack(repo, version2));
          return;
        }
        if (service === 'git-receive-pack') {
          ctx.respond(200, 'application/x-git-receive-pack-advertisement', advertiseReceivePack(repo));
          return;
        }
        ctx.respond(400, 'text/plain; charset=utf-8', 'unknown service');
        return;
      }
      if (tail === 'git-upload-pack' && ctx.method === 'POST') {
        const version2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
        let out: Buffer;
        if (version2) {
          const commandLine = firstCommandLine(body);
          out = commandLine === 'command=ls-refs' ? lsRefs(repo, body) : fetchV2(repo, body);
        } else {
          out = fetchV0(repo, body);
        }
        ctx.respond(200, 'application/x-git-upload-pack-result', out);
        return;
      }
      if (tail === 'git-receive-pack' && ctx.method === 'POST') {
        ctx.respond(200, 'application/x-git-receive-pack-result', receivePack(repo, body));
        return;
      }
    } catch {
      // A malformed protocol body is a 400; the server stays up.
      ctx.respond(400, 'text/plain; charset=utf-8', 'malformed git request');
      return;
    }
    ctx.respond(404, 'text/plain; charset=utf-8', 'not found');
    return;
  }

  if (seg[0] === 'api' && seg[1] === 'graphql') {
    if (!authorized(req, expectedToken)) return ctx.error(401, 'Bad credentials');
    if (ctx.method !== 'POST') return ctx.error(404, 'Not Found');
    handleGraphql(ctx);
    return;
  }

  if (seg[0] === 'api' && seg[1] === 'v3') {
    if (!authorized(req, expectedToken)) return ctx.error(401, 'Bad credentials');
    routeRest(ctx);
    return;
  }

  if (seg[0] === 'mcp') {
    if (!authorized(req, expectedToken)) return ctx.error(401, 'Bad credentials');
    handleMcp(ctx);
    return;
  }

  ctx.error(404, 'Not Found');
}

/** The first data packet's text of a v2 request, e.g. "command=ls-refs". */
function firstCommandLine(body: Buffer): string {
  if (body.length < 4) return '';
  const length = Number.parseInt(body.subarray(0, 4).toString('ascii'), 16);
  if (!Number.isFinite(length) || length < 4 || length > body.length) return '';
  return body.subarray(4, length).toString('utf8').replace(/\n$/, '');
}

async function postJson(url: string, value: unknown): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  await response.arrayBuffer().catch(() => undefined);
  return response.status;
}

async function registerAndPoll(envUrl: string, port: number): Promise<void> {
  const base = envUrl.replace(/\/+$/, '');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const status = await postJson(`${base}/register`, { port });
      if (status >= 200 && status < 300) break;
    } catch {
      // The env may not be listening yet; keep trying inside the boot budget.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const poll = async (): Promise<void> => {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      try {
        const response = await fetch(`${base}/done`);
        const data = (await response.json()) as { done?: unknown };
        if (data.done === true) {
          process.exit(0);
        }
      } catch {
        // A failed poll says nothing; the next one may know more.
      }
    }
  };
  void poll();
}

/** Start the forge: bind an ephemeral port, register with the env when there is one. */
export async function startForge(): Promise<void> {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer((req, res) => {
    handle(store, expectedToken, req, res).catch(() => {
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Internal error' }));
      } catch {
        // The peer is gone; nothing sensible left to do.
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  process.stdout.write(`FORGE_LISTENING ${port}\n`);
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl !== undefined && envUrl !== '') {
    await registerAndPoll(envUrl, port);
  }
}
