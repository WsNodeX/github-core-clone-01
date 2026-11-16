// In-memory data store shared by every surface of the forge (git smart HTTP, REST v3,
// GraphQL and MCP all read and write the same objects, so an id minted on one surface is
// the same object on every other).
//
// Tenancy model: the bearer token is opaque, so the forge cannot know the viewer's login
// up front. The store is single-tenant: repositories are keyed by name alone, and the
// first request that addresses an existing repository through an owner segment adopts
// that owner as the canonical viewer login. After adoption, any other owner segment is
// a 404, which is exactly how the suite probes a repository "under another owner".
//
// Determinism: no wall clock and no randomness anywhere. Timestamps come from a logical
// clock that ticks once per mutation, so two identical runs produce identical bytes.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface Issue {
  kind: 'issue' | 'pull';
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  // pull-request-only fields
  headRef: string;
  baseRef: string;
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  name: string;
  dbId: number;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  /** Bump on every ref change; keys the ls-refs response cache. */
  refsVersion: number;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextNumber: number;
  nextCommentId: number;
}

const CLOCK_START_SEC = 1735689600; // 2025-01-01T00:00:00Z

export class Store {
  repos: Map<string, Repo> = new Map();
  viewerLogin: string | null = null;
  private nextDbId = 1;
  private clockSec = CLOCK_START_SEC;
  private requestSeq = 0;

  /** Advance the logical clock and answer the new epoch second. */
  tick(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  /** The current logical time as an ISO string (ticks once, like a real write would). */
  isoNow(): string {
    return new Date(this.tick() * 1000).toISOString();
  }

  /** A stable, non-empty request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `forge-${String(this.requestSeq).padStart(6, '0')}`;
  }

  /** Adopt `login` as the canonical viewer when none is known yet. */
  adoptViewer(login: string): void {
    if (this.viewerLogin === null && login !== '') this.viewerLogin = login;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      name,
      dbId: this.nextDbId,
      isPrivate,
      description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      refsVersion: 0,
      labels: new Map(),
      issues: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextDbId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  /**
   * Resolve a repository addressed as owner/name. Returns null when the repository does
   * not exist, or when a canonical viewer is known and `owner` is someone else. A hit
   * through an owner segment adopts that owner when none is known yet.
   */
  repoFor(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (this.viewerLogin === null) {
      this.adoptViewer(owner);
      return repo;
    }
    return owner === this.viewerLogin ? repo : null;
  }

  /** The viewer login to report, once known (repo creation alone does not teach it). */
  viewer(): string | null {
    return this.viewerLogin;
  }
}
