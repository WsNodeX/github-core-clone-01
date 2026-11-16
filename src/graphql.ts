// The GraphQL v4 surface (POST /api/graphql): a small lexer/parser for the document
// subset gh and github-mcp-server send (operations with variables, aliases, inline and
// named fragments, enum/list/object argument values, operation batching as a JSON array)
// and an executor over the shared store, with the introspection shape feature-detection
// probes read. Unknown fields are a 200 with an errors array, never an HTTP error.

import type { Ctx } from './ctx.ts';
import { BadJsonError } from './ctx.ts';
import type { Issue, Repo, Store } from './store.ts';
import { createIssue, createPull, mergePull, pullFiles, pullMergeable } from './domain.ts';

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!$=@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (match === null) throw new Error('bad number');
      tokens.push({ kind: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      if (match === null) throw new Error('bad name');
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  readonly fragments = new Map<string, { typeCondition: string; selection: SelectionNode[] }>();
  readonly operations: Operation[] = [];

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): void {
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'punct' && token.value === '{') {
        this.operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation');
      if (token.value === 'query' || token.value === 'mutation') {
        const type = token.value;
        this.next();
        let name: string | null = null;
        const after = this.peek();
        if (after !== undefined && after.kind === 'name') name = this.expectName();
        if (this.atPunct('(')) this.skipVariableDefinitions();
        this.skipDirectives();
        this.operations.push({ type, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        this.fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) {
        this.expectPunct('(');
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        const after = this.peek();
        if (after !== undefined && after.kind === 'name' && after.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'fragmentSpread', name: this.expectName() });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.atPunct(':')) {
        this.next();
        alias = name;
        name = this.expectName();
      }
      const args = new Map<string, ValueNode>();
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.set(argName, this.parseValue());
        }
        this.next();
      }
      this.skipDirectives();
      const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    this.next();
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value');
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema tables

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'isPrivate',
  ],
  Ref: ['name', 'target'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt',
    'closed', 'url', 'repository',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'author', 'createdAt', 'updatedAt', 'closed', 'url', 'repository',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Type: ['kind', 'name', 'description', 'fields', 'inputFields', 'interfaces', 'enumValues', 'possibleTypes', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection',
    pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection',
  },
  Issue: { author: 'User', repository: 'Repository' },
  PullRequest: { author: 'User', repository: 'Repository', files: 'PullRequestChangedFileConnection' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
  CommentEdge: { node: 'IssueComment' },
  IssueComment: { author: 'User' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

// ------------------------------------------------------------------ global ids

function globalId(kind: string, repoDbId: number, number?: number): string {
  const raw = number === undefined ? `${kind}:${repoDbId}` : `${kind}:${repoDbId}:${number}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

interface DecodedId {
  kind: string;
  repoDbId: number;
  number: number | null;
  commentId: number | null;
}

function decodeGlobalId(id: string): DecodedId | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 2) return null;
    const repoDbId = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(repoDbId)) return null;
    return {
      kind: parts[0],
      repoDbId,
      number: parts.length >= 3 ? Number.parseInt(parts[2], 10) : null,
      commentId: parts.length >= 4 ? Number.parseInt(parts[3], 10) : null,
    };
  } catch {
    return null;
  }
}

function repoByDbId(store: Store, dbId: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

// ------------------------------------------------------------------ execution

type Source = Record<string, unknown> & { __typename: string };

interface ExecState {
  store: Store;
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
  errors: Array<{ message: string }>;
}

function userSource(store: Store): Source {
  return { __typename: 'User', login: store.viewer() ?? '' };
}

function repoSource(repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: Repo, issue: Issue): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: Issue): Source {
  return { __typename: 'PullRequest', repo, issue: pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    if (!raw.startsWith('cursor:')) return null;
    const value = Number.parseInt(raw.slice('cursor:'.length), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

interface Connection {
  nodes: Source[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function issuesConnection(state: ExecState, repo: Repo, args: Map<string, unknown>): Connection {
  let list = [...repo.issues.values()].filter((issue) => issue.kind === 'issue');
  const states = args.get('states');
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((entry) => String(entry).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  let descending = false;
  const orderBy = args.get('orderBy');
  if (isRecordArg(orderBy) && orderBy.direction === 'DESC') descending = true;
  list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  return pageOf(list.map((issue) => issueSource(repo, issue)), list.map((issue) => issue.number), args);
}

function pageOf(nodes: Source[], numbers: number[], args: Map<string, unknown>): Connection {
  let start = 0;
  const after = args.get('after');
  if (typeof after === 'string' && after !== '') {
    const afterNumber = numberFromCursor(after);
    if (afterNumber !== null) {
      const index = numbers.indexOf(afterNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const firstRaw = args.get('first');
  const first = typeof firstRaw === 'number' ? firstRaw : nodes.length;
  const slice = nodes.slice(start, start + first);
  return {
    nodes: slice,
    hasNextPage: start + slice.length < nodes.length,
    endCursor: slice.length > 0 ? cursorFor(numbers[start + slice.length - 1]) : null,
  };
}

function isRecordArg(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveField(state: ExecState, source: Source, field: string, args: Map<string, unknown>): unknown {
  const { store } = state;
  const type = source.__typename;
  if (field === '__typename') return type;
  switch (type) {
    case 'Query': {
      if (field === 'viewer') return userSource(store);
      if (field === 'repository') {
        const owner = String(args.get('owner') ?? '');
        const name = String(args.get('name') ?? '');
        const repo = store.repoFor(owner, name);
        return repo === null ? null : repoSource(repo);
      }
      if (field === 'node') {
        const decoded = decodeGlobalId(String(args.get('id') ?? ''));
        if (decoded === null) return null;
        const repo = repoByDbId(store, decoded.repoDbId);
        if (repo === null) return null;
        if (decoded.kind === 'Repository') return repoSource(repo);
        if (decoded.kind === 'Issue' && decoded.number !== null) {
          const issue = repo.issues.get(decoded.number);
          return issue !== undefined && issue.kind === 'issue' ? issueSource(repo, issue) : null;
        }
        if (decoded.kind === 'PullRequest' && decoded.number !== null) {
          const pull = repo.issues.get(decoded.number);
          return pull !== undefined && pull.kind === 'pull' ? pullSource(repo, pull) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args.get('name') ?? '');
        if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
        return { __typename: '__Type', typeName: name };
      }
      if (field === '__schema') return { __typename: '__Schema' };
      break;
    }
    case 'User': {
      if (field === 'login') return source.login;
      if (field === 'id') return Buffer.from(`User:${String(source.login)}`, 'utf8').toString('base64');
      if (field === 'name') return source.login;
      if (field === 'url') return `/${String(source.login)}`;
      break;
    }
    case 'Repository': {
      const repo = source.repo as Repo;
      switch (field) {
        case 'id': return globalId('Repository', repo.dbId);
        case 'databaseId': return repo.dbId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${store.viewer() ?? ''}/${repo.name}`;
        case 'owner': return userSource(store);
        case 'defaultBranchRef': {
          const ref = `refs/heads/${repo.defaultBranch}`;
          return repo.refs.has(ref) ? { __typename: 'Ref', name: repo.defaultBranch } : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'isPrivate': return repo.isPrivate;
        case 'url': return `/${store.viewer() ?? ''}/${repo.name}`;
        case 'issue': {
          const issue = repo.issues.get(Number(args.get('number')));
          return issue !== undefined && issue.kind === 'issue' ? issueSource(repo, issue) : null;
        }
        case 'issues': {
          const connection = issuesConnection(state, repo, args);
          return { __typename: 'IssueConnection', connection, repo };
        }
        case 'pullRequest': {
          const pull = repo.issues.get(Number(args.get('number')));
          return pull !== undefined && pull.kind === 'pull' ? pullSource(repo, pull) : null;
        }
        case 'pullRequests': {
          const pulls = [...repo.issues.values()].filter((entry) => entry.kind === 'pull').sort((a, b) => a.number - b.number);
          const connection = pageOf(pulls.map((pull) => pullSource(repo, pull)), pulls.map((pull) => pull.number), args);
          return { __typename: 'PullRequestConnection', connection, repo };
        }
      }
      break;
    }
    case 'Issue': {
      const issue = source.issue as Issue;
      const repo = source.repo as Repo;
      switch (field) {
        case 'id': return globalId('Issue', repo.dbId, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'closed': return issue.state === 'closed';
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'author': return userSource(store);
        case 'repository': return repoSource(repo);
        case 'url': return `/${store.viewer() ?? ''}/${repo.name}/issues/${issue.number}`;
      }
      break;
    }
    case 'PullRequest': {
      const pull = source.issue as Issue;
      const repo = source.repo as Repo;
      switch (field) {
        case 'id': return globalId('PullRequest', repo.dbId, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'closed': return pull.state === 'closed';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return pullMergeable(repo, pull);
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'author': return userSource(store);
        case 'repository': return repoSource(repo);
        case 'url': return `/${store.viewer() ?? ''}/${repo.name}/pull/${pull.number}`;
        case 'files': {
          const firstRaw = args.get('first');
          const first = typeof firstRaw === 'number' ? firstRaw : 10;
          const files = pullFiles(repo, pull).slice(0, first).map((file) => ({
            __typename: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
          }));
          return { __typename: 'PullRequestChangedFileConnection', connection: { nodes: files, hasNextPage: false, endCursor: null } };
        }
      }
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      const connection = source.connection as Connection;
      if (field === 'nodes') return connection.nodes;
      if (field === 'totalCount') return connection.nodes.length;
      if (field === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          hasNextPage: connection.hasNextPage,
          hasPreviousPage: false,
          startCursor: connection.endCursor,
          endCursor: connection.endCursor,
        };
      }
      if (field === 'edges') return connection.nodes.map((node) => ({ node }));
      break;
    }
    case 'PageInfo': {
      if (field in source) return source[field];
      break;
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return source.path;
      if (field === 'additions') return source.additions;
      if (field === 'deletions') return source.deletions;
      break;
    }
    case 'Ref': {
      if (field === 'name') return source.name;
      break;
    }
    case '__Type': {
      const typeName = String(source.typeName);
      if (field === 'name') return typeName;
      if (field === 'kind') return ENUM_VALUES[typeName] !== undefined ? 'ENUM' : 'OBJECT';
      if (field === 'fields') return (TYPE_FIELDS[typeName] ?? []).map((name) => ({ __typename: '__Field', name }));
      if (field === 'enumValues') return (ENUM_VALUES[typeName] ?? []).map((name) => ({ __typename: '__EnumValue', name }));
      if (field === 'description') return null;
      if (field === 'possibleTypes') return [];
      if (field === 'interfaces') return [];
      if (field === 'inputFields') return [];
      if (field === 'ofType') return null;
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (field === 'name') return source.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      if (field === 'args') return [];
      if (field === 'type') return null;
      break;
    }
    case 'Mutation': {
      return resolveMutation(state, field, args);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return source.issue;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return source.pullRequest;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return source.commentEdge;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'CommentEdge': {
      if (field === 'node') return source.node;
      if (field === 'cursor') return 'cursor';
      break;
    }
    case 'IssueComment': {
      if (field === 'id') return source.id;
      if (field === 'body') return source.body;
      if (field === 'author') return userSource(store);
      if (field === 'createdAt' || field === 'updatedAt') return source.createdAt;
      break;
    }
  }
  state.errors.push({ message: `Field '${field}' doesn't exist on type '${type}'` });
  return null;
}

function resolveMutation(state: ExecState, field: string, args: Map<string, unknown>): unknown {
  const { store } = state;
  const input = args.get('input');
  if (!isRecordArg(input)) {
    state.errors.push({ message: `Field '${field}' requires an input object` });
    return null;
  }
  if (field === 'createIssue') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded === null ? null : repoByDbId(store, decoded.repoDbId);
    if (repo === null) {
      state.errors.push({ message: 'repository not found' });
      return null;
    }
    const issue = createIssue(repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      labels: [],
    }, store);
    return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue) };
  }
  if (field === 'closeIssue') {
    const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
    if (found === null) {
      state.errors.push({ message: 'issue not found' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.updatedAt = store.isoNow();
    return { __typename: 'CloseIssuePayload', issue: issueSource(found.repo, found.issue) };
  }
  if (field === 'createPullRequest') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded === null ? null : repoByDbId(store, decoded.repoDbId);
    if (repo === null) {
      state.errors.push({ message: 'repository not found' });
      return null;
    }
    const created = createPull(repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
    }, store);
    if ('error' in created) {
      state.errors.push({ message: created.error });
      return null;
    }
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, created) };
  }
  if (field === 'mergePullRequest') {
    const found = findIssueByGlobalId(store, String(input.pullRequestId ?? ''), 'pull');
    if (found === null) {
      state.errors.push({ message: 'pull request not found' });
      return null;
    }
    const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
    const result = mergePull(store, found.repo, found.issue, method);
    if ('conflict' in result) {
      state.errors.push({ message: 'Pull Request is not mergeable' });
      return null;
    }
    if ('error' in result) {
      state.errors.push({ message: result.error });
      return null;
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(found.repo, found.issue) };
  }
  if (field === 'addComment') {
    const found = findIssueByGlobalId(store, String(input.subjectId ?? ''), 'issue');
    if (found === null) {
      state.errors.push({ message: 'subject not found' });
      return null;
    }
    const comment = {
      id: found.repo.nextCommentId,
      body: String(input.body ?? ''),
      author: store.viewer() ?? '',
      createdAt: store.isoNow(),
    };
    found.repo.nextCommentId += 1;
    found.issue.comments.push(comment);
    const node: Source = {
      __typename: 'IssueComment',
      id: Buffer.from(`IssueComment:${found.repo.dbId}:${found.issue.number}:${comment.id}`, 'utf8').toString('base64'),
      body: comment.body,
      createdAt: comment.createdAt,
    };
    return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node } };
  }
  state.errors.push({ message: `Field '${field}' doesn't exist on type 'Mutation'` });
  return null;
}

function findIssueByGlobalId(store: Store, id: string, kind?: 'issue' | 'pull'): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.number === null) return null;
  const repo = repoByDbId(store, decoded.repoDbId);
  if (repo === null) return null;
  const issue = repo.issues.get(decoded.number);
  if (issue === undefined) return null;
  if (kind !== undefined && issue.kind !== kind) return null;
  return { repo, issue };
}

function executeSelection(
  state: ExecState,
  source: Source,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === source.__typename) {
        Object.assign(out, executeSelection(state, source, selection.selection, variables));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = state.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === source.__typename) {
        Object.assign(out, executeSelection(state, source, fragment.selection, variables));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const args = new Map<string, unknown>();
    for (const [name, value] of selection.args) args.set(name, resolveValue(value, variables));
    const raw = selection.name === '__typename'
      ? source.__typename
      : resolveField(state, source, selection.name, args);
    out[key] = completeValue(state, source.__typename, selection, raw, variables);
  }
  return out;
}

function completeValue(
  state: ExecState,
  parentType: string,
  field: FieldNode,
  raw: unknown,
  variables: Record<string, unknown>,
): unknown {
  if (raw === null || raw === undefined) return null;
  if (field.selection === null) return raw;
  const childType = FIELD_TYPES[parentType]?.[field.name] ?? (raw as Source).__typename ?? parentType;
  if (Array.isArray(raw)) {
    return raw.map((entry) => (isSource(entry) ? executeSelection(state, entry, field.selection!, variables) : entry));
  }
  if (isSource(raw)) {
    // The child's own typename governs its fields; childType is only a fallback label.
    void childType;
    return executeSelection(state, raw, field.selection, variables);
  }
  return raw;
}

function isSource(value: unknown): value is Source {
  return value !== null && typeof value === 'object' && typeof (value as Source).__typename === 'string';
}

// ------------------------------------------------------------------ HTTP entry

interface OperationResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function runOperation(store: Store, queryText: string, variables: Record<string, unknown>, operationName: string | null): OperationResult {
  const parser = new Parser(queryText);
  try {
    parser.parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = operationName !== null
    ? parser.operations.find((entry) => entry.name === operationName) ?? parser.operations[0]
    : parser.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  const state: ExecState = { store, fragments: parser.fragments, errors: [] };
  const root: Source = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(state, root, operation.selection, variables);
  const result: OperationResult = { data };
  if (state.errors.length > 0) result.errors = state.errors;
  return result;
}

/** POST /api/graphql. A JSON array body is GitHub's operation batching. */
export function handleGraphql(ctx: Ctx): void {
  let body: unknown;
  try {
    body = ctx.json();
  } catch (err) {
    if (err instanceof BadJsonError) {
      ctx.jsonBody(400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    throw err;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => runOne(ctx.store, entry));
    ctx.jsonBody(200, results);
    return;
  }
  ctx.jsonBody(200, runOne(ctx.store, body));
}

function runOne(store: Store, entry: unknown): OperationResult {
  if (!isRecordArg(entry) || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'a GraphQL request needs a query string' }] };
  }
  const variables = isRecordArg(entry.variables) ? entry.variables : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  return runOperation(store, entry.query, variables, operationName);
}
