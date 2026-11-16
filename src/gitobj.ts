// Git object model: SHA-1 ids, commit/tree/tag parsing and building, packfile reading
// (plain, OFS_DELTA and REF_DELTA entries) and writing (plain entries), reachability
// walks, tree flattening/diffing and the three-way tree merge a squash needs.
// Node standard library only; no git binary is ever invoked.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the raw bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object in the repo and answer its id. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ------------------------------------------------------------------ commits & tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  timeSec: number;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  const timeMatch = / (\d+) [+-]\d{4}$/.exec(committer);
  return { tree, parents, author, committer, message, timeSec: timeMatch ? Number(timeMatch[1]) : 0 };
}

export function buildCommit(fields: {
  tree: string;
  parents: string[];
  message: string;
  authorLine: string;
  committerLine: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.authorLine}`, `committer ${fields.committerLine}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** An identity line `Name <email> <unix> +0000` for commits the forge itself authors. */
export function identityLine(timeSec: number): string {
  return `Forge <forge@make.fun> ${timeSec} +0000`;
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const fields = new Map<string, string>();
  for (const line of head.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = fields.get('type');
  return {
    object: fields.get('object') ?? '',
    type: type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit',
    tag: fields.get('tag') ?? '',
  };
}

/** Follow tag objects until a commit; null when the chain does not end at one. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** The commit a ref tip peels to, or null. */
export function refCommit(repo: Repo, oid: string): string | null {
  return peelToCommit(repo, oid);
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every file under a tree, keyed by slash-joined path. A null tree is the empty tree. */
export function flattenTree(repo: Repo, treeOid: string | null): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  if (treeOid !== null) walk(treeOid, '');
  return out;
}

/** Write a flattened file map back into tree objects; answers the root tree id. */
export function materializeTree(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of flat) {
    const segments = path.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1], file);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: write(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return write(root);
}

/** The tree of a commit, or null when the commit is unknown. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

export interface TreeChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Path-level differences between two flattened trees. */
export function diffFlat(
  base: Map<string, { mode: string; oid: string }>,
  head: Map<string, { mode: string; oid: string }>,
): TreeChange[] {
  const changes: TreeChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before === undefined && after !== undefined) changes.push({ path, status: 'added', oldOid: null, newOid: after.oid });
    else if (before !== undefined && after === undefined) changes.push({ path, status: 'removed', oldOid: before.oid, newOid: null });
    else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
      changes.push({ path, status: 'modified', oldOid: before.oid, newOid: after.oid });
    }
  }
  return changes;
}

// ------------------------------------------------------------------ history walks

/** Every object reachable from the roots (commits, their trees and parents, tags). */
export function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
  return seen;
}

/** All ancestor commits of `tip` (including itself), with their generation distance. */
export function ancestorDistances(repo: Repo, tip: string): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<[string, number]> = [[tip, 0]];
  while (queue.length > 0) {
    const [oid, distance] = queue.shift()!;
    if (distances.has(oid) && distances.get(oid)! <= distance) continue;
    distances.set(oid, distance);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push([parent, distance + 1]);
  }
  return distances;
}

/**
 * True when `ancestor` is `descendant` itself or one of its ancestors (fast-forward).
 * Depth-first with an early exit: a push's old tip is normally the new tip's parent, so
 * this answers in one step instead of mapping the whole history on every push.
 */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** The best common ancestor of two commits, or null when their histories are disjoint. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = ancestorDistances(repo, a);
  const fromB = ancestorDistances(repo, b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, distance] of fromA) {
    const other = fromB.get(oid);
    if (other === undefined) continue;
    const score = distance + other;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/**
 * Three-way tree merge for a squash: changes the head side made since the fork point are
 * applied onto the current base tree. A path both sides changed to different bytes (or
 * one side deleted while the other modified) is a conflict.
 */
export function mergeTrees(
  repo: Repo,
  baseTip: string,
  headTip: string,
): { treeOid: string } | { conflict: string } {
  const fork = mergeBase(repo, baseTip, headTip);
  const forkFlat = fork === null ? new Map() : flattenTree(repo, commitTree(repo, fork));
  const baseFlat = flattenTree(repo, commitTree(repo, baseTip));
  const headFlat = flattenTree(repo, commitTree(repo, headTip));
  const merged = new Map(baseFlat);
  const paths = new Set<string>([...forkFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const forkEntry = forkFlat.get(path);
    const headEntry = headFlat.get(path);
    if (forkEntry?.oid === headEntry?.oid) continue; // the head side did not change it
    const baseEntry = baseFlat.get(path);
    const baseUnchanged = baseEntry?.oid === forkEntry?.oid && baseEntry?.mode === forkEntry?.mode;
    if (!baseUnchanged) {
      const sameOutcome = baseEntry?.oid === headEntry?.oid;
      if (!sameOutcome) return { conflict: path };
      continue;
    }
    if (headEntry === undefined) merged.delete(path);
    else merged.set(path, headEntry);
  }
  return { treeOid: materializeTree(repo, merged) };
}

// ------------------------------------------------------------------ packfiles

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset];
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset];
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta stream to its base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/**
 * Read a whole packfile held in memory, resolving deltas against pack-internal bases and
 * (for a thin pack) the repo's own store. Returns every resolved object.
 */
export function readPack(repo: Repo, pack: Buffer): GitObject[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset: number;
    baseOid: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0), baseOffset: -1, baseOid: '' };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolvedByOid = new Map<string, GitObject>();
  const resolveEntry = (entry: Raw, depth: number): GitObject => {
    if (depth > 64) throw new Error('delta chain too deep');
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing');
        base = resolveEntry(baseEntry, depth + 1);
      } else {
        base = resolvedByOid.get(entry.baseOid) ?? repo.objects.get(entry.baseOid);
        if (base === undefined) {
          for (const candidate of raw) {
            const resolved = resolveEntry(candidate, depth + 1);
            resolvedByOid.set(hashObject(resolved.type, resolved.data), resolved);
          }
          base = resolvedByOid.get(entry.baseOid);
        }
        if (base === undefined) throw new Error('ref-delta base missing');
      }
      return { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    const type = CODE_TYPE[entry.typeCode];
    if (type === undefined) throw new Error(`unknown pack type ${entry.typeCode}`);
    return { type, data: entry.data };
  };
  const objects: GitObject[] = [];
  for (const entry of raw) {
    const object = resolveEntry(entry, 0);
    resolvedByOid.set(hashObject(object.type, object.data), object);
    objects.push(object);
  }
  return objects;
}

function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain objects (no deltas), with its SHA-1 trailer. */
export function writePack(objects: GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
