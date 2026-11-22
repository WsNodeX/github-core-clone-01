// The git smart-HTTP surface: ref advertisement (protocol v2 for upload-pack when the
// client asks, v0 otherwise; receive-pack is v0 only), the v2 ls-refs and fetch commands,
// a v0 fetch fallback, and receive-pack pushes with per-ref fast-forward validation and
// a report-status answer framed in side-band-64k when the client negotiated it.

import type { Repo } from './store.ts';
import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  putObject,
  readPack,
  writePack,
} from './gitobj.ts';
import type { GitObject } from './store.ts';
import { DELIM_PKT, FLUSH_PKT, PKT_MAX_PAYLOAD, PktReader, encodePkt } from './pktline.ts';

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 = `multi_ack_detailed side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

/** The v2 capability advertisement is the same bytes for every repository; build once. */
const V2_ADVERTISEMENT = Buffer.concat([
  encodePkt('version 2\n'),
  encodePkt(`agent=${AGENT}\n`),
  encodePkt('ls-refs=unborn\n'),
  encodePkt('fetch=shallow\n'),
  encodePkt('object-format=sha1\n'),
  FLUSH_PKT,
]);

/**
 * Depth-1 clone packs, cached per repository and tip. Objects are content-addressed and
 * immutable, so the pack for a given tip at a given depth can never change; the
 * benchmark's fifty concurrent clones of one tip all reuse the first one's bytes.
 */
const clonePackCache = new WeakMap<Repo, Map<string, Buffer>>();

function cachedClonePack(repo: Repo, tip: string): Buffer | null {
  if (repo.refs.get(`refs/heads/${repo.defaultBranch}`) !== tip && !repo.objects.has(tip)) return null;
  const cache = clonePackCache.get(repo);
  return cache?.get(tip) ?? null;
}

function storeClonePack(repo: Repo, tip: string, pack: Buffer): void {
  let cache = clonePackCache.get(repo);
  if (cache === undefined) {
    cache = new Map();
    clonePackCache.set(repo, cache);
  }
  if (cache.size > 64) cache.clear();
  cache.set(tip, pack);
}

/** Sorted ref names of the repository (HEAD is synthesized by the callers). */
function refNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The commit a ref's target peels to through annotated tags, when it is a tag object. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// ------------------------------------------------------------------ advertisements

/** GET info/refs for git-upload-pack: a v2 capability list, or the v0 ref listing. */
export function advertiseUploadPack(repo: Repo, version2: boolean): Buffer {
  if (version2) return V2_ADVERTISEMENT;
  const parts: Buffer[] = [encodePkt('# service=git-upload-pack\n'), FLUSH_PKT];
  parts.push(...v0RefListing(repo, UPLOAD_CAPS_V0));
  return Buffer.concat(parts);
}

/** GET info/refs for git-receive-pack: always the v0 ref listing. */
export function advertiseReceivePack(repo: Repo): Buffer {
  const parts: Buffer[] = [encodePkt('# service=git-receive-pack\n'), FLUSH_PKT];
  parts.push(...v0RefListing(repo, RECEIVE_CAPS));
  return Buffer.concat(parts);
}

function v0RefListing(repo: Repo, capabilities: string): Buffer[] {
  const names = refNames(repo);
  if (names.length === 0) {
    // An empty repository still has to end the listing. Without this flush the
    // client blocks waiting for the rest of the advertisement and never sends
    // its POST, so a push dies as "the remote end hung up".
    return [encodePkt(`${ZERO_OID} capabilities^{}\0${capabilities}\n`), FLUSH_PKT];
  }
  const parts: Buffer[] = [];
  const headOid = defaultTip(repo) ?? ZERO_OID;
  parts.push(encodePkt(`${headOid} HEAD\0${capabilities}\n`));
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    parts.push(encodePkt(`${oid} ${name}\n`));
    const peeled = peeledOf(repo, oid);
    if (peeled !== null) parts.push(encodePkt(`${peeled} ${name}^{}\n`));
  }
  parts.push(FLUSH_PKT);
  return parts;
}

// ------------------------------------------------------------------ ls-refs (v2)

/** ls-refs answers, cached per repository by refs version and request variant. */
const lsRefsCache = new WeakMap<Repo, Map<string, Buffer>>();

export function lsRefs(repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  let sawDelim = false;
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (let packet = reader.next(); packet !== null; packet = reader.next()) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!sawDelim) continue; // command=ls-refs and capability arguments
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const cacheKey = `${repo.refsVersion}|${peel}|${symrefs}|${prefixes.join(',')}`;
  let cache = lsRefsCache.get(repo);
  const cached = cache?.get(cacheKey);
  if (cached !== undefined) return cached;
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  if (matches('HEAD')) {
    const tip = defaultTip(repo);
    if (tip === null) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    } else {
      lines.push(`${tip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    }
  }
  for (const name of refNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (symrefs && name === headRef) {
      // only HEAD carries a symref target in this forge
    }
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const parts = lines.map((line) => encodePkt(`${line}\n`));
  parts.push(FLUSH_PKT);
  const answer = Buffer.concat(parts);
  if (cache === undefined) {
    cache = new Map();
    lsRefsCache.set(repo, cache);
  }
  if (cache.size > 32) cache.clear();
  cache.set(cacheKey, answer);
  return answer;
}

// ------------------------------------------------------------------ fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  deepen: number | null;
  /** The client sent "done": it is stateless and expects a packfile, not a negotiation. */
  done: boolean;
}

function parseFetchArgs(body: Buffer, version2: boolean): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], deepen: null, done: false };
  const reader = new PktReader(body);
  let section = 0; // v2: 0 = command args (before delim); v0: 0 = wants, 1 = negotiation
  for (let packet = reader.next(); packet !== null; packet = reader.next()) {
    if (packet.kind === 'delim') {
      section = 1;
      continue;
    }
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (version2 && section === 0) continue; // command=fetch, agent=, object-format=
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1).split(' ')[0];
    if (key === 'done') args.done = true;
    else if (key === 'want' && isOid(value)) args.wants.push(value);
    else if (key === 'have' && isOid(value)) args.haves.push(value);
    else if (key === 'shallow' && isOid(value)) args.clientShallow.push(value);
    else if (key === 'deepen') args.deepen = Number.parseInt(value, 10) || null;
  }
  return args;
}

interface FetchPlan {
  objects: GitObject[];
  boundary: string[];
  unshallow: string[];
  commonHave: string | null;
}

/**
 * What the client provably holds: everything reachable from its haves, except that a
 * commit on the client's own shallow boundary is held without its parents (the client
 * never received them, so they must not be treated as held when deepening).
 */
function heldObjects(repo: Repo, haves: string[], clientShallow: Set<string>): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!clientShallow.has(oid)) queue.push(...commit.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
  return held;
}

function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const clientShallow = new Set(args.clientShallow);
  const haveClosure = heldObjects(repo, args.haves, clientShallow);
  const commonHave = args.haves.find((have) => repo.objects.has(have)) ?? null;

  // Commit inclusion: BFS generations from the want roots. A deepen N keeps generations
  // 0..N-1; without one, everything is kept except that a client-declared shallow
  // boundary cuts the walk (its parents are not traversed).
  const depthLimit = args.deepen;
  const includedCommits = new Set<string>();
  const tagObjects: string[] = [];
  const distances = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  const seedCommit = (oid: string, distance: number): void => {
    if (!distances.has(oid) || distances.get(oid)! > distance) {
      distances.set(oid, distance);
      queue.push([oid, distance]);
    }
  };
  for (const want of args.wants) {
    let current = want;
    // A want may name a tag: include the tag chain, root the walk at its commit.
    for (let hops = 0; hops < 32; hops += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) break;
      if (object.type === 'tag') {
        tagObjects.push(current);
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') seedCommit(current, 0);
      break;
    }
  }
  while (queue.length > 0) {
    const [oid, distance] = queue.shift()!;
    if (depthLimit !== null && distance >= depthLimit) continue;
    if (includedCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    includedCommits.add(oid);
    if (depthLimit === null && clientShallow.has(oid)) continue; // held boundary: stop here
    for (const parent of parseCommit(object.data).parents) seedCommit(parent, distance + 1);
  }

  // The new shallow boundary: included commits with a parent left outside the walk.
  const boundary: string[] = [];
  if (depthLimit !== null || clientShallow.size > 0) {
    for (const oid of includedCommits) {
      const object = repo.objects.get(oid)!;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !includedCommits.has(parent) && repo.objects.has(parent))) boundary.push(oid);
    }
  }
  const unshallow = [...clientShallow].filter((oid) => includedCommits.has(oid) && !boundary.includes(oid));

  // Objects to send: the included commits and tag chain, plus their trees and blobs,
  // minus everything the client provably already holds.
  const send = new Set<string>();
  for (const oid of tagObjects) send.add(oid);
  for (const oid of includedCommits) send.add(oid);
  for (const oid of [...send]) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const reachable of collectReachable(repo, [parseCommit(object.data).tree])) send.add(reachable);
    }
  }
  for (const oid of haveClosure) send.delete(oid);
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, boundary, unshallow, commonHave };
}

/** Wrap pack bytes in side-band-64k band-1 packets. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunkSize = PKT_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, offset + chunkSize);
    parts.push(encodePkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

export function fetchV2(repo: Repo, body: Buffer): Buffer {
  const args = parseFetchArgs(body, true);
  // A depth-1 clone from nothing is the benchmark's hot path; its pack is cached per tip.
  const cacheable = args.deepen === 1 && args.wants.length === 1 && args.haves.length === 0 && args.clientShallow.length === 0;
  let pack: Buffer | null = cacheable ? cachedClonePack(repo, args.wants[0]) : null;
  let boundary: string[] = [];
  let unshallow: string[] = [];
  let commonHave: string | null = null;
  if (pack !== null) {
    const commit = peelToCommit(repo, args.wants[0]);
    if (commit !== null) {
      const parents = parseCommit(repo.objects.get(commit)!.data).parents;
      if (parents.some((parent) => repo.objects.has(parent))) boundary = [commit];
    }
  } else {
    const plan = planFetch(repo, args);
    pack = writePack(plan.objects);
    boundary = plan.boundary;
    unshallow = plan.unshallow;
    commonHave = plan.commonHave;
    if (cacheable) storeClonePack(repo, args.wants[0], pack);
  }
  const parts: Buffer[] = [];
  // A client that sent "done" is not negotiating: it is waiting for the packfile
  // section and reads an acknowledgments section as a protocol error. Only a
  // client that is still narrowing down haves wants the ACK/NAK round.
  if (!args.done) {
    parts.push(encodePkt('acknowledgments\n'));
    if (commonHave !== null) {
      parts.push(encodePkt(`ACK ${commonHave} common\n`));
      parts.push(encodePkt('ready\n'));
    } else {
      parts.push(encodePkt('NAK\n'));
    }
    parts.push(FLUSH_PKT);
  }
  if (boundary.length > 0 || unshallow.length > 0) {
    parts.push(encodePkt('shallow-info\n'));
    for (const oid of boundary) parts.push(encodePkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
    parts.push(FLUSH_PKT);
  }
  parts.push(encodePkt('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

export function fetchV0(repo: Repo, body: Buffer): Buffer {
  const args = parseFetchArgs(body, false);
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.commonHave !== null) {
    parts.push(encodePkt(`ACK ${plan.commonHave} common\n`));
    parts.push(encodePkt(`ACK ${plan.commonHave} ready\n`));
  } else {
    parts.push(encodePkt('NAK\n'));
  }
  for (const oid of plan.boundary) parts.push(encodePkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (let packet = reader.next(); packet !== null; packet = reader.next()) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length >= 3 && isOid(fields[0]) && isOid(fields[1])) {
      commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
    }
  }
  const packBytes = reader.rest();
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(repo, packBytes);
      for (const object of objects) putObject(repo, object.type, object.data);
    } catch {
      unpackOk = false;
      unpackDetail = 'unparseable pack';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    results.push(applyPushCommand(repo, command, unpackOk));
  }

  const reportStatus = capabilities.includes('report-status');
  if (!reportStatus) return Buffer.alloc(0);
  const lines: Buffer[] = [encodePkt(`unpack ${unpackDetail}\n`)];
  for (const result of results) {
    lines.push(encodePkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  lines.push(FLUSH_PKT);
  const report = Buffer.concat(lines);
  if (capabilities.includes('side-band-64k')) {
    // The report stream is itself pkt-lined inside band 1.
    const wrapped: Buffer[] = [];
    const chunkSize = PKT_MAX_PAYLOAD - 1;
    for (let offset = 0; offset < report.length; offset += chunkSize) {
      wrapped.push(encodePkt(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + chunkSize)])));
    }
    wrapped.push(FLUSH_PKT);
    return Buffer.concat(wrapped);
  }
  return report;
}

function applyPushCommand(repo: Repo, command: PushCommand, unpackOk: boolean): { ref: string; ok: boolean; reason: string } {
  const { ref, oldOid, newOid } = command;
  if (!unpackOk) return { ref, ok: false, reason: 'unpack failed' };
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    if (current === ZERO_OID) return { ref, ok: false, reason: 'reference does not exist' };
    repo.refs.delete(ref);
    repo.refsVersion += 1;
    return { ref, ok: true, reason: '' };
  }
  if (!repo.objects.has(newOid)) return { ref, ok: false, reason: 'missing object' };
  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID && current !== newOid) return { ref, ok: false, reason: 'reference already exists' };
    repo.refs.set(ref, newOid);
    repo.refsVersion += 1;
    return { ref, ok: true, reason: '' };
  }
  if (current !== oldOid) return { ref, ok: false, reason: 'reference update failed' };
  const oldCommit = peelToCommit(repo, oldOid);
  const newCommit = peelToCommit(repo, newOid);
  if (oldCommit !== null && newCommit !== null && oldCommit !== newCommit && !isAncestor(repo, oldCommit, newCommit)) {
    return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
    repo.refsVersion += 1;
  return { ref, ok: true, reason: '' };
}
