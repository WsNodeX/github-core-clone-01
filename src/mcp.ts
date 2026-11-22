// The MCP surface (POST /mcp): JSON-RPC 2.0 over streamable HTTP. The server speaks the
// modern revision (server/discover, no handshake) and the legacy initialize handshake.
// Six tools — create_repo, get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request — run on the same store and domain operations as REST, so objects
// are identical across surfaces. Tool failures are isError results; protocol failures are
// JSON-RPC errors (-32700 parse, -32602 unknown tool / bad params), never HTTP 500.

import type { Ctx } from './ctx.ts';
import type { Repo } from './store.ts';
import { createIssue, createPull, issueJson, mergePull, pullJson, repoJson } from './domain.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, string>>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList(): unknown[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> | { rpcError: { code: number; message: string } } {
  const { store } = ctx;
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return { rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return toolError(`missing required arguments: ${missing.join(', ')}`);
  const repoOf = (): Repo | null => store.repoFor(String(args.owner ?? ''), String(args.repo ?? ''));
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = store.repos.get(repoName);
      if (existing !== undefined) return toolResult(repoJson(store, existing));
      const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return toolResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = repoOf();
      if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = repoOf();
      if (repo === null) return toolError('repository not found');
      const issue = createIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      }, store);
      return toolResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === null) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => issue.kind === 'issue' && (state === 'all' || issue.state === state))
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(store, repo, issue));
      return toolResult(issues);
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (repo === null) return toolError('repository not found');
      const created = createPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head),
        base: String(args.base),
      }, store);
      if ('error' in created) return toolError(created.error);
      return toolResult(pullJson(store, repo, created));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === null) return toolError('repository not found');
      const pull = repo.issues.get(Number(args.pull_number));
      if (pull === undefined || pull.kind !== 'pull') return toolError('pull request not found');
      const result = mergePull(store, repo, pull, 'squash');
      if ('conflict' in result) return toolError('Pull Request is not mergeable');
      if ('error' in result) return toolError(result.error);
      return toolResult(pullJson(store, repo, pull));
    }
  }
  return { rpcError: { code: -32602, message: `unknown tool: ${name}` } };
}

interface RpcOutcome {
  status: number;
  payload: unknown;
  empty?: boolean;
}

function handleRpc(ctx: Ctx, request: unknown): RpcOutcome {
  if (!isRecord(request) || typeof request.method !== 'string') {
    return { status: 200, payload: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } } };
  }
  const id = 'id' in request ? request.id : null;
  const method = request.method;
  const params = isRecord(request.params) ? request.params : {};
  if (method.startsWith('notifications/')) return { status: 202, payload: null, empty: true };
  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        payload: {
          jsonrpc: '2.0',
          id,
          result: {
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          },
        },
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return {
        status: 200,
        payload: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        },
      };
    }
    case 'ping':
      return { status: 200, payload: { jsonrpc: '2.0', id, result: {} } };
    case 'tools/list':
      return { status: 200, payload: { jsonrpc: '2.0', id, result: { tools: toolsList() } } };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const outcome = callTool(ctx, toolName, args);
      if ('rpcError' in outcome) {
        return { status: 200, payload: { jsonrpc: '2.0', id, error: outcome.rpcError } };
      }
      return { status: 200, payload: { jsonrpc: '2.0', id, result: outcome } };
    }
    default:
      return { status: 200, payload: { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } } };
  }
}

/** POST /mcp. A body that is not JSON is HTTP 400 with a -32700 parse error. */
export function handleMcp(ctx: Ctx): void {
  if (ctx.method !== 'POST') {
    ctx.jsonBody(405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'the MCP endpoint takes POST' } });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    ctx.jsonBody(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(body)) {
    const payloads = body.map((entry) => handleRpc(ctx, entry).payload);
    ctx.jsonBody(200, payloads);
    return;
  }
  const outcome = handleRpc(ctx, body);
  if (outcome.empty === true) {
    ctx.respond(202, 'application/json', '');
    return;
  }
  ctx.jsonBody(outcome.status, outcome.payload);
}
