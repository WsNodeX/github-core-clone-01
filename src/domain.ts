// Domain operations shared by the REST, GraphQL and MCP surfaces: repository/issue/pull
// JSON shapes, contents writes (which are real git commits), pull-request creation and
// merging, and the changed-file computation. One implementation, three surfaces, so an
// object created over MCP is byte-for-byte the object REST reads back.

import type { Issue, Repo, Store } from './store.ts';
import {
  buildCommit,
  commitTree,
  diffFlat,
  flattenTree,
  identityLine,
  materializeTree,
  mergeBase,
  mergeTrees,
  parseCommit,
  peelToCommit,
  putObject,
} from './gitobj.ts';

// ------------------------------------------------------------------ JSON shapes

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.viewer() ?? '';
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: owner },
    html_url: `/${owner}/${repo.name}`,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = store.viewer() ?? '';
  return {
    id: repo.dbId * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    user: { login: owner },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Issue): Record<string, unknown> {
  const owner = store.viewer() ?? '';
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  return {
    id: repo.dbId * 100000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${owner}:${pull.baseRef}` },
    user: { login: owner },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

export function commentJson(store: Store, comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: store.viewer() ?? '' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

// ------------------------------------------------------------------ commits

/** Author a commit on a branch with the given tree; returns the new commit id. */
export function commitOnBranch(store: Store, repo: Repo, branch: string, treeOid: string, message: string): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const timeSec = store.tick();
  const line = identityLine(timeSec);
  const commit = buildCommit({
    tree: treeOid,
    parents: parent === undefined ? [] : [parent],
    // The message is stored verbatim: the REST commits view must echo exactly what the
    // contents caller sent, with no newline added or removed.
    message,
    authorLine: line,
    committerLine: line,
  });
  const oid = putObject(repo, 'commit', commit);
  repo.refs.set(ref, oid);
    repo.refsVersion += 1;
  return oid;
}

/** Commits reachable from a tip, newest first (committer time, then discovery order). */
export function listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string; timeSec: number; parents: string[] }> {
  const seen = new Set<string>();
  const out: Array<{ sha: string; message: string; timeSec: number; parents: string[] }> = [];
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message, timeSec: commit.timeSec, parents: commit.parents });
    queue.push(...commit.parents);
  }
  out.sort((a, b) => b.timeSec - a.timeSec);
  return out;
}

// ------------------------------------------------------------------ contents

export interface ContentsWriteResult {
  commitSha: string;
  blobSha: string | null;
}

/**
 * Create, update or delete (content === null) one file on a branch, as a real commit.
 * `expectedSha` is the caller's view of the current blob id: a mismatch is a conflict.
 * The branch is created (with a root commit) when it does not exist yet.
 */
export function writeContents(
  store: Store,
  repo: Repo,
  options: { path: string; content: Buffer | null; branch: string; message: string; expectedSha?: string },
): ContentsWriteResult | { conflict: true } {
  const branch = options.branch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const flat = tip === undefined ? new Map() : flattenTree(repo, commitTree(repo, tip));
  const existing = flat.get(options.path);
  if (options.expectedSha !== undefined && (existing?.oid ?? null) !== options.expectedSha) {
    return { conflict: true };
  }
  let blobSha: string | null = null;
  if (options.content === null) {
    flat.delete(options.path);
  } else {
    blobSha = putObject(repo, 'blob', options.content);
    flat.set(options.path, { mode: existing?.mode ?? '100644', oid: blobSha });
  }
  const treeOid = materializeTree(repo, flat);
  const commitSha = commitOnBranch(store, repo, branch, treeOid, options.message);
  return { commitSha, blobSha };
}

/** The file at `path` on a ref (branch name or commit id), or null. */
export function readFileAt(repo: Repo, refName: string, path: string): { oid: string; data: Buffer } | null {
  const tip = repo.refs.get(`refs/heads/${refName}`) ?? (repo.objects.has(refName) ? refName : undefined);
  if (tip === undefined) return null;
  const commit = peelToCommit(repo, tip);
  if (commit === null) return null;
  const flat = flattenTree(repo, commitTree(repo, commit));
  const entry = flat.get(path);
  if (entry === undefined) return null;
  const object = repo.objects.get(entry.oid);
  if (object === undefined || object.type !== 'blob') return null;
  return { oid: entry.oid, data: object.data };
}

/** Directory listing at `path` ('' is the root) on a ref, or null when absent. */
export function listDirAt(repo: Repo, refName: string, path: string): Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string }> | null {
  const tip = repo.refs.get(`refs/heads/${refName}`) ?? (repo.objects.has(refName) ? refName : undefined);
  if (tip === undefined) return null;
  const commit = peelToCommit(repo, tip);
  if (commit === null) return null;
  const flat = flattenTree(repo, commitTree(repo, commit));
  const prefix = path === '' ? '' : `${path}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; sha: string }>();
  let found = path === '';
  for (const [filePath, entry] of flat) {
    if (prefix !== '' && !filePath.startsWith(prefix)) continue;
    found = true;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) entries.set(rest, { type: 'file', sha: entry.oid });
    else {
      const dirName = rest.slice(0, slash);
      if (!entries.has(dirName)) entries.set(dirName, { type: 'dir', sha: '' });
    }
  }
  if (!found) return null;
  // Directory ids: recompute the subtree id so listings carry a stable sha.
  return [...entries.entries()].map(([name, entry]) => ({
    name,
    path: prefix + name,
    type: entry.type,
    sha: entry.type === 'file' ? entry.sha : dirTreeSha(repo, commit, prefix + name),
  }));
}

function dirTreeSha(repo: Repo, commit: string, dirPath: string): string {
  const flat = flattenTree(repo, commitTree(repo, commit));
  const prefix = `${dirPath}/`;
  const sub = new Map<string, { mode: string; oid: string }>();
  for (const [path, entry] of flat) if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), entry);
  return materializeTree(repo, sub);
}

// ------------------------------------------------------------------ issues & pulls

export function createIssue(repo: Repo, fields: { title: string; body: string; labels: string[] }, store: Store): Issue {
  const now = store.isoNow();
  const issue: Issue = {
    kind: 'issue',
    number: repo.nextNumber,
    title: fields.title,
    body: fields.body,
    state: 'open',
    labels: [...fields.labels],
    comments: [],
    createdAt: now,
    updatedAt: now,
    headRef: '',
    baseRef: '',
    baseShaAtCreate: '',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(
  repo: Repo,
  fields: { title: string; body: string; head: string; base: string },
  store: Store,
): Issue | { error: string } {
  const headTip = repo.refs.get(`refs/heads/${fields.head}`);
  const baseTip = repo.refs.get(`refs/heads/${fields.base}`);
  if (headTip === undefined) return { error: `head branch ${fields.head} does not exist` };
  if (baseTip === undefined) return { error: `base branch ${fields.base} does not exist` };
  if (fields.head === fields.base) return { error: 'head and base are the same branch' };
  const now = store.isoNow();
  const pull: Issue = {
    kind: 'pull',
    number: repo.nextNumber,
    title: fields.title,
    body: fields.body,
    state: 'open',
    labels: [],
    comments: [],
    createdAt: now,
    updatedAt: now,
    headRef: fields.head,
    baseRef: fields.base,
    baseShaAtCreate: baseTip,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(pull.number, pull);
  return pull;
}

/** Line-level add/delete counts between two blob texts (LCS over lines; inputs are small). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * (n + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** The changed files of a pull request: fork-point tree versus the head branch's tip tree. */
export function pullFiles(repo: Repo, pull: Issue): PullFile[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (headTip === undefined) return [];
  const headCommit = peelToCommit(repo, headTip);
  if (headCommit === null) return [];
  const baseAtCreate = pull.baseShaAtCreate;
  const forkCommit = baseAtCreate !== '' && repo.objects.has(baseAtCreate)
    ? mergeBase(repo, baseAtCreate, headCommit)
    : null;
  const baseTree = forkCommit !== null ? commitTree(repo, forkCommit) : commitTree(repo, baseAtCreate);
  const baseFlat = flattenTree(repo, baseTree);
  const headFlat = flattenTree(repo, commitTree(repo, headCommit));
  return diffFlat(baseFlat, headFlat).map((change) => {
    const oldText = change.oldOid !== null ? (repo.objects.get(change.oldOid)?.data.toString('utf8') ?? '') : '';
    const newText = change.newOid !== null ? (repo.objects.get(change.newOid)?.data.toString('utf8') ?? '') : '';
    const counts = lineDiffCounts(oldText, newText);
    return {
      filename: change.path,
      status: change.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    };
  });
}

/**
 * Merge a pull request. Squash lands one commit on the base branch carrying the head
 * side's changes since the fork point; merge lands a two-parent commit with the same
 * tree. A conflicting change set is refused, as is a pull that is not open.
 */
export function mergePull(
  store: Store,
  repo: Repo,
  pull: Issue,
  method: string,
): { sha: string } | { conflict: true } | { error: string } {
  if (pull.state !== 'open' || pull.merged) return { error: 'pull request is not open' };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { error: 'a branch is missing' };
  const headCommit = peelToCommit(repo, headTip);
  const baseCommit = peelToCommit(repo, baseTip);
  if (headCommit === null || baseCommit === null) return { error: 'branch tips are not commits' };
  const merged = mergeTrees(repo, baseCommit, headCommit);
  if ('conflict' in merged) return { conflict: true };
  const timeSec = store.tick();
  const line = identityLine(timeSec);
  const isMergeCommit = method === 'merge';
  const commit = buildCommit({
    tree: merged.treeOid,
    parents: isMergeCommit ? [baseCommit, headCommit] : [baseCommit],
    message: isMergeCommit ? `Merge pull request #${pull.number} from ${pull.headRef}\n` : `${pull.title}\n`,
    authorLine: line,
    committerLine: line,
  });
  const sha = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    repo.refsVersion += 1;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date(timeSec * 1000).toISOString();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { sha };
}

/** Whether a pull request would merge cleanly onto the current base tip. */
export function pullMergeable(repo: Repo, pull: Issue): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const headCommit = peelToCommit(repo, headTip);
  const baseCommit = peelToCommit(repo, baseTip);
  if (headCommit === null || baseCommit === null) return 'UNKNOWN';
  const merged = mergeTrees(repo, baseCommit, headCommit);
  return 'conflict' in merged ? 'CONFLICTING' : 'MERGEABLE';
}
