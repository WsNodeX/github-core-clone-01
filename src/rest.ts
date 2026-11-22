// The REST v3 surface (/api/v3): repositories, contents, git refs, branches, commits,
// labels, issues, comments and pull requests with GitHub's shapes and status codes.
// Everything sits on the shared store and the domain operations, so git pushes, GraphQL
// mutations and MCP calls all see the same state.

import type { Ctx } from './ctx.ts';
import { BadJsonError } from './ctx.ts';
import type { Issue, Repo } from './store.ts';
import {
  commentJson,
  createIssue,
  createPull,
  issueJson,
  listCommits,
  listDirAt,
  mergePull,
  pullFiles,
  pullJson,
  readFileAt,
  repoJson,
  writeContents,
} from './domain.ts';
import { isOid } from './gitobj.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function pagination(ctx: Ctx): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

/** Slice one page out of a list and add the Link header chain GitHub clients follow. */
function paged<T>(ctx: Ctx, items: T[], path: string): T[] {
  const { perPage, page } = pagination(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = `${ctx.origin}${path}?per_page=${perPage}&page=${page + 1}`;
    const lastPage = Math.ceil(items.length / perPage);
    const last = `${ctx.origin}${path}?per_page=${perPage}&page=${lastPage}`;
    headers.Link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  ctx.jsonBody(200, slice, headers);
  return slice;
}

/** Entry point: routes everything under /api/v3. Returns false for other prefixes. */
export function routeRest(ctx: Ctx): boolean {
  const seg = ctx.segments;
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;
  try {
    dispatch(ctx, seg.slice(2));
  } catch (err) {
    if (err instanceof BadJsonError) ctx.error(400, 'Problems parsing JSON');
    else throw err;
  }
  return true;
}

function dispatch(ctx: Ctx, rest: string[]): void {
  const { store, method } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      ctx.jsonBody(200, { current_user_url: `${ctx.origin}/api/v3/user` }, { 'X-OAuth-Scopes': 'repo, read:org' });
      return;
    }
    return notFound(ctx);
  }
  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    ctx.jsonBody(200, { installed_version: '1.0.0', github_services_sha: 'forge' });
    return;
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    const viewer = store.viewer();
    if (viewer === null) return ctx.error(404, 'Not Found');
    ctx.jsonBody(200, { login: viewer, type: 'User' });
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const all = [...store.repos.values()].map((repo) => repoJson(store, repo));
      paged(ctx, all, '/api/v3/user/repos');
      return;
    }
    if (method === 'POST') return createRepo(ctx);
    return notFound(ctx);
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const name = rest[2];
    const repo = store.repoFor(owner, name);
    if (repo === null) return ctx.error(404, 'Not Found');
    return repoRoute(ctx, repo, rest.slice(3));
  }
  return notFound(ctx);
}

function notFound(ctx: Ctx): void {
  ctx.error(404, 'Not Found');
}

function createRepo(ctx: Ctx): void {
  const { store } = ctx;
  const body = ctx.json();
  if (!isRecord(body)) return ctx.error(422, 'Repository creation failed');
  const name = str(body.name);
  if (name === undefined || name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return ctx.error(422, 'Repository creation failed: name is invalid');
  }
  if (store.repos.has(name)) {
    return ctx.error(422, 'Repository creation failed: name already exists on this account');
  }
  const repo = store.createRepo(name, body.private === true, str(body.description) ?? '');
  if (body.auto_init === true) {
    writeContents(store, repo, {
      path: 'README.md',
      content: Buffer.from(`# ${name}\n`, 'utf8'),
      branch: repo.defaultBranch,
      message: 'Initial commit',
    });
  }
  ctx.jsonBody(201, repoJson(store, repo));
}

function repoRoute(ctx: Ctx, repo: Repo, rest: string[]): void {
  const { store, method } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') return ctx.jsonBody(200, repoJson(store, repo));
    if (method === 'PATCH') {
      const body = ctx.json();
      if (isRecord(body)) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      }
      return ctx.jsonBody(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.name);
      return ctx.respond(204, 'application/json', '');
    }
    return notFound(ctx);
  }
  const head = rest[0];
  if (head === 'branches') return branchesRoute(ctx, repo, rest.slice(1));
  if (head === 'git' && rest[1] === 'refs') return gitRefsRoute(ctx, repo, rest.slice(2));
  if (head === 'commits' && rest.length === 1 && method === 'GET') return commitsRoute(ctx, repo);
  if (head === 'contents') return contentsRoute(ctx, repo, rest.slice(1));
  if (head === 'labels') return labelsRoute(ctx, repo, rest.slice(1));
  if (head === 'issues') return issuesRoute(ctx, repo, rest.slice(1));
  if (head === 'pulls') return pullsRoute(ctx, repo, rest.slice(1));
  return notFound(ctx);
}

function branchesRoute(ctx: Ctx, repo: Repo, rest: string[]): void {
  const { method } = ctx;
  if (rest.length === 0 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return ctx.jsonBody(200, branches);
  }
  if (rest.length >= 1 && method === 'GET') {
    const name = rest.join('/');
    const sha = repo.refs.get(`refs/heads/${name}`);
    if (sha === undefined) return ctx.error(404, 'Branch not found');
    return ctx.jsonBody(200, { name, commit: { sha } });
  }
  return notFound(ctx);
}

function gitRefsRoute(ctx: Ctx, repo: Repo, rest: string[]): void {
  const { method } = ctx;
  if (rest.length === 0 && method === 'POST') {
    const body = ctx.json();
    if (!isRecord(body)) return ctx.error(422, 'Invalid ref');
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !repo.objects.has(sha)) {
      return ctx.error(422, 'Invalid object requested');
    }
    repo.refs.set(ref, sha);
    repo.refsVersion += 1;
    return ctx.jsonBody(201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
  }
  if (rest.length >= 1 && method === 'GET') {
    const ref = `refs/${rest.join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return ctx.error(404, 'Reference not found');
    return ctx.jsonBody(200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
  }
  return notFound(ctx);
}

function commitsRoute(ctx: Ctx, repo: Repo): void {
  const shaParam = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (isOid(shaParam) && repo.objects.has(shaParam) ? shaParam : undefined);
  if (tip === undefined) return ctx.error(404, 'No commit found');
  const commits = listCommits(repo, tip).map((entry) => ({
    sha: entry.sha,
    commit: {
      message: entry.message,
      author: { name: 'Forge', email: 'forge@localhost', date: new Date(entry.timeSec * 1000).toISOString() },
      committer: { name: 'Forge', email: 'forge@localhost', date: new Date(entry.timeSec * 1000).toISOString() },
    },
    parents: entry.parents.map((parent) => ({ sha: parent })),
  }));
  paged(ctx, commits, `/api/v3/repos/${ctx.segments[3]}/${repo.name}/commits`);
}

function contentsRoute(ctx: Ctx, repo: Repo, rest: string[]): void {
  const { store, method } = ctx;
  const path = rest.join('/');
  if (method === 'GET') {
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    if (path !== '') {
      const file = readFileAt(repo, ref, path);
      if (file !== null) {
        return ctx.jsonBody(200, {
          type: 'file',
          name: path.split('/').pop(),
          path,
          sha: file.oid,
          size: file.data.length,
          encoding: 'base64',
          content: file.data.toString('base64'),
        });
      }
    }
    const dir = listDirAt(repo, ref, path);
    if (dir !== null) {
      return ctx.jsonBody(200, dir.map((entry) => ({
        type: entry.type,
        name: entry.name,
        path: entry.path,
        sha: entry.sha,
        size: 0,
      })));
    }
    return ctx.error(404, 'Not Found');
  }
  if (method === 'PUT' || method === 'DELETE') {
    const body = ctx.json();
    if (!isRecord(body)) return ctx.error(422, 'Invalid request');
    const message = str(body.message) ?? (method === 'PUT' ? 'Update file' : 'Delete file');
    const branch = str(body.branch) ?? repo.defaultBranch;
    const existed = readFileAt(repo, branch, path) !== null;
    if (method === 'DELETE' && !existed) return ctx.error(404, 'Not Found');
    const expectedSha = str(body.sha);
    const content = method === 'PUT'
      ? Buffer.from((str(body.content) ?? '').replace(/\s+/g, ''), 'base64')
      : null;
    const result = writeContents(store, repo, { path, content, branch, message, expectedSha });
    if ('conflict' in result) return ctx.error(409, 'sha does not match');
    if (method === 'DELETE') {
      return ctx.jsonBody(200, { content: null, commit: { sha: result.commitSha } });
    }
    return ctx.jsonBody(existed ? 200 : 201, {
      content: {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: result.blobSha,
        size: content?.length ?? 0,
        encoding: 'base64',
        content: content?.toString('base64') ?? '',
      },
      commit: { sha: result.commitSha },
    });
  }
  return notFound(ctx);
}

function labelsRoute(ctx: Ctx, repo: Repo, rest: string[]): void {
  const { method } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      return ctx.jsonBody(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    if (method === 'POST') {
      const body = ctx.json();
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
        return ctx.error(422, 'Validation Failed');
      }
      if (repo.labels.has(body.name)) return ctx.error(422, 'Validation Failed: label already exists');
      const label = { name: body.name, color: typeof body.color === 'string' ? body.color : '000000' };
      repo.labels.set(label.name, label);
      return ctx.jsonBody(201, { name: label.name, color: label.color });
    }
  }
  if (rest.length === 1 && method === 'GET') {
    const label = repo.labels.get(rest[0]);
    if (label === undefined) return ctx.error(404, 'Label not found');
    return ctx.jsonBody(200, { name: label.name, color: label.color });
  }
  return notFound(ctx);
}

function issuesRoute(ctx: Ctx, repo: Repo, rest: string[]): void {
  const { store, method } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()].filter((issue) => issue.kind === 'issue');
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return void paged(ctx, issues.map((issue) => issueJson(store, repo, issue)), pagePath(ctx, repo, 'issues'));
    }
    if (method === 'POST') {
      const body = ctx.json();
      if (!isRecord(body) || typeof body.title !== 'string' || body.title === '') {
        return ctx.error(422, 'Validation Failed: title is required');
      }
      const labelNames = Array.isArray(body.labels)
        ? body.labels.filter((label): label is string => typeof label === 'string')
        : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return ctx.error(422, `Validation Failed: label ${name} does not exist`);
      }
      const issue = createIssue(repo, { title: body.title, body: str(body.body) ?? '', labels: labelNames }, store);
      return ctx.jsonBody(201, issueJson(store, repo, issue));
    }
    return notFound(ctx);
  }
  const number = Number.parseInt(rest[0], 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (issue === undefined || issue.kind !== 'issue') return ctx.error(404, 'Issue not found');
    if (method === 'GET') return ctx.jsonBody(200, issueJson(store, repo, issue));
    if (method === 'PATCH') {
      const body = ctx.json();
      if (isRecord(body)) {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (Array.isArray(body.labels)) {
          issue.labels = body.labels.filter((label): label is string => typeof label === 'string');
        }
        issue.updatedAt = store.isoNow();
      }
      return ctx.jsonBody(200, issueJson(store, repo, issue));
    }
    return notFound(ctx);
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return ctx.error(404, 'Issue not found');
    if (method === 'GET') {
      return ctx.jsonBody(200, issue.comments.map((comment) => commentJson(store, comment)));
    }
    if (method === 'POST') {
      const body = ctx.json();
      if (!isRecord(body) || typeof body.body !== 'string') return ctx.error(422, 'Validation Failed: body is required');
      const comment = {
        id: repo.nextCommentId,
        body: body.body,
        author: store.viewer() ?? '',
        createdAt: store.isoNow(),
      };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return ctx.jsonBody(201, commentJson(store, comment));
    }
  }
  return notFound(ctx);
}

function pullsRoute(ctx: Ctx, repo: Repo, rest: string[]): void {
  const { store, method } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.issues.values()].filter((issue) => issue.kind === 'pull');
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => a.number - b.number);
      return void paged(ctx, pulls.map((pull) => pullJson(store, repo, pull)), pagePath(ctx, repo, 'pulls'));
    }
    if (method === 'POST') {
      const body = ctx.json();
      if (!isRecord(body)) return ctx.error(422, 'Validation Failed');
      const head = str(body.head);
      const base = str(body.base);
      const title = str(body.title);
      if (head === undefined || base === undefined || title === undefined) {
        return ctx.error(422, 'Validation Failed: head, base and title are required');
      }
      // A head may arrive as owner:branch; the forge is single-tenant, so strip the prefix.
      const headBranch = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head;
      const created = createPull(repo, { title, body: str(body.body) ?? '', head: headBranch, base }, store);
      if ('error' in created) return ctx.error(422, `Validation Failed: ${created.error}`);
      return ctx.jsonBody(201, pullJson(store, repo, created));
    }
    return notFound(ctx);
  }
  const number = Number.parseInt(rest[0], 10);
  const pull: Issue | undefined = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (pull === undefined || pull.kind !== 'pull') {
    if (rest[0] !== undefined && method === 'PUT') return ctx.error(404, 'Not Found');
    return ctx.error(404, 'Pull request not found');
  }
  if (rest.length === 1 && method === 'GET') return ctx.jsonBody(200, pullJson(store, repo, pull));
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const files = pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    return void paged(ctx, files, pagePath(ctx, repo, `pulls/${pull.number}/files`));
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const body = ctx.json();
    const mergeMethod = isRecord(body) ? str(body.merge_method) ?? 'merge' : 'merge';
    const result = mergePull(store, repo, pull, mergeMethod);
    if ('conflict' in result) return ctx.error(405, 'Pull Request is not mergeable');
    if ('error' in result) return ctx.error(405, result.error);
    return ctx.jsonBody(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return notFound(ctx);
}

function pagePath(ctx: Ctx, repo: Repo, tail: string): string {
  return `/api/v3/repos/${ctx.segments[3]}/${repo.name}/${tail}`;
}
