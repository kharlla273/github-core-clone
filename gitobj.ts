// gitobj.ts — the git object model: loose-object hashing, commit/tree/tag codecs, packfiles,
// pkt-lines, reachability and shallow-fetch selection. No git binary, only node:crypto and
// node:zlib. This is the layer the smart-HTTP handlers and the REST contents/merge paths share.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// commits, trees, tags
// ---------------------------------------------------------------------------------------------

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly timestamp: number;
  readonly message: string;
}

/** Build a commit object. `author`/`committer` are `Name <email>`; the timestamp is appended. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('');
  lines.push(fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from `roots` (commits walk parents+trees, tags peel, trees recurse). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // a gitlink names a commit the repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equals it), following commit parents only. */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the first commit reachable from `head` that is also an ancestor of `base`. */
export function mergeBase(head: string, base: string, lookup: ObjectLookup): string | null {
  if (head === base) return head;
  const baseAncestors = new Set<string>();
  const queue = [base];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (baseAncestors.has(oid)) continue;
    baseAncestors.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  const seen = new Set<string>();
  const headQueue = [head];
  while (headQueue.length) {
    const oid = headQueue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (baseAncestors.has(oid)) return oid;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) headQueue.push(parent);
  }
  return null;
}

/** Peel a tag (recursively) to the commit it names; a commit oid passes through. */
export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = lookup(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
}

/** Peel any object to its ultimate non-tag target (for ls-refs `peeled:`). */
export function peelTag(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    const object = lookup(current);
    if (!object || object.type !== 'tag' || seen.has(current)) return object?.type === 'tag' ? null : current;
    seen.add(current);
    current = parseTag(object.data).object;
  }
}

// ---------------------------------------------------------------------------------------------
// file maps (a commit's tree flattened to path -> blob)
// ---------------------------------------------------------------------------------------------

export interface FileEntry {
  readonly oid: string;
  readonly mode: string;
}

/** Flatten a commit's tree into a path -> {oid, mode} map (blobs only; gitlinks skipped). */
export function treeToFiles(treeOid: string, lookup: ObjectLookup): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') files.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return files;
}

/** A commit's file map (empty when the commit is unknown). */
export function commitFiles(commitOid: string, lookup: ObjectLookup): Map<string, FileEntry> {
  const object = lookup(commitOid);
  if (!object || object.type !== 'commit') return new Map();
  return treeToFiles(parseCommit(object.data).tree, lookup);
}

/** Build the tree objects for a file map, storing them via `put`; returns the root tree oid. */
export function filesToTree(
  files: ReadonlyMap<string, FileEntry>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type] as number;
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

/**
 * Build a packfile from plain objects (no deltas): the client resolves any valid pack, and
 * delta-free packs keep the fetch path fast and deterministic. Trailer is SHA-1 over the rest.
 */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Buffer): string {
  if (pack.length < 20) throw new Error('pack is shorter than its trailer');
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly count: number;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and REF_DELTA
 * (a thin pack's base may come from `resolveBase`, the store the pack lands in).
 */
export function readPack(pack: Buffer, resolveBase?: ObjectLookup): PackReadResult {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  if (packChecksum(pack) !== trailer) throw new Error('pack trailer does not match its bytes');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const deltas: Array<{ offset: number; baseOid: string | null; baseOffset: number | null; data: Buffer; size: number }> = [];
  let offset = 12;
  const end = pack.length - 20;
  for (let index = 0; index < declaredCount; index += 1) {
    if (offset >= end) throw new Error('pack ends before its declared object count');
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(pack, offset);
    const typeCode = (first >> 4) & 0x07;
    offset = next;
    if (typeCode === 6) {
      const { baseOffset, next: afterBase } = readOfsDeltaBase(pack, offset);
      offset = afterBase;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      deltas.push({ offset: entryOffset, baseOid: null, baseOffset: entryOffset - baseOffset, data: inflated.data, size });
    } else if (typeCode === 7) {
      if (offset + 20 > end) throw new Error('ref-delta has no base object id');
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      deltas.push({ offset: entryOffset, baseOid, baseOffset: null, data: inflated.data, size });
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`pack entry has unknown type code ${typeCode}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack entry size does not match its inflated bytes');
      const oid = hashObject(type, inflated.data);
      const object: GitObject = { type, data: inflated.data };
      objects.set(oid, object);
      byOffset.set(entryOffset, object);
    }
  }
  // Resolve deltas in offset order (a delta's base always precedes it in a well-formed pack).
  for (const delta of deltas) {
    let base: GitObject | undefined;
    if (delta.baseOffset !== null) base = byOffset.get(delta.baseOffset);
    else if (delta.baseOid !== null) base = objects.get(delta.baseOid) ?? resolveBase?.(delta.baseOid);
    if (!base) throw new Error('delta base is not available');
    const data = applyDelta(base.data, delta.data);
    if (data.length !== delta.size) throw new Error('delta size does not match its resolved bytes');
    const oid = hashObject(base.type, data);
    const object: GitObject = { type: base.type, data };
    objects.set(oid, object);
    byOffset.set(delta.offset, object);
  }
  return { objects, count: declaredCount };
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;

export type GitPacket =
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' }
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer };

/** Encode one pkt-line (payload + 4-byte hex length). */
export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line of ${length} bytes exceeds ${PKT_LINE_MAX}`);
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Decode a complete buffer into packets; throws on malformed or trailing bytes. */
export function decodePktLines(bytes: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error(`truncated pkt-line: ${bytes.length - offset} trailing byte(s)`);
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > bytes.length) throw new Error(`truncated pkt-line: ${length} announced, ${bytes.length - offset} available`);
    const raw = bytes.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw: Buffer.from(raw) });
    offset += length;
  }
  return packets;
}

/**
 * Split a receive-pack body into its command pkt-lines and the trailing raw pack bytes: the
 * commands end at the first flush packet, everything after it is the packfile.
 */
export function splitReceivePackBody(body: Buffer): { commandPackets: GitPacket[]; pack: Buffer } {
  let offset = 0;
  const packets: GitPacket[] = [];
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('receive-pack command section is truncated');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      return { commandPackets: packets, pack: body.subarray(offset) };
    }
    if (length < 4 || length > PKT_LINE_MAX || offset + length > body.length) {
      throw new Error('receive-pack command pkt-line is malformed');
    }
    const raw = body.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw: Buffer.from(raw) });
    offset += length;
  }
  throw new Error('receive-pack body has no flush after its commands');
}

/** The text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// fetch selection (wants / haves / shallow / depth)
// ---------------------------------------------------------------------------------------------

export interface FetchSelection {
  /** Objects to send (oids). */
  readonly deliver: Set<string>;
  /** The new shallow boundary commits (depth-limited fetches). */
  readonly shallow: string[];
  /** Client shallow boundaries whose parents are now delivered. */
  readonly unshallow: string[];
}

/**
 * What a fetch sends: the closure of `wants` (depth-limited when `depth` is set) minus what the
 * client already holds (the closure of `haves`, not traversed past the client's shallow
 * boundaries — their parents are precisely what the client does not have).
 */
export function selectFetch(
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
  lookup: ObjectLookup,
): FetchSelection {
  const shallowSet = new Set(clientShallow);
  // What the client holds: closure of haves, stopping at shallow boundaries (the boundary commit
  // itself is held; its parents are not).
  const held = new Set<string>();
  {
    const queue: string[] = [...haves];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!shallowSet.has(oid)) for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }
  // What the fetch covers: full closure, or depth-limited (commits within `depth` generations of
  // a want; a commit at distance depth-1 is the new shallow boundary).
  const wanted = new Set<string>();
  const boundary: string[] = [];
  if (depth === null || depth === undefined) {
    for (const oid of collectReachable(wants, lookup, { allowMissing: true })) wanted.add(oid);
  } else {
    const commitDistance = new Map<string, number>();
    const queue: Array<{ oid: string; distance: number }> = wants.map((oid) => ({ oid, distance: 0 }));
    const seenCommits = new Set<string>();
    while (queue.length) {
      const { oid, distance } = queue.shift() as { oid: string; distance: number };
      const peeled = peelToCommit(oid, lookup);
      const commitOid = peeled ?? oid;
      if (seenCommits.has(commitOid)) continue;
      const object = lookup(commitOid);
      if (!object || object.type !== 'commit') continue; // a non-commit want: handled below
      seenCommits.add(commitOid);
      commitDistance.set(commitOid, distance);
      if (distance >= depth) continue;
      const commit = parseCommit(object.data);
      if (distance === depth - 1) {
        if (commit.parents.length > 0) boundary.push(commitOid);
      } else {
        for (const parent of commit.parents) queue.push({ oid: parent, distance: distance + 1 });
      }
    }
    // Included commits + the tree/blob closure of each included commit.
    for (const commitOid of seenCommits) {
      const distance = commitDistance.get(commitOid) as number;
      if (distance >= depth) continue;
      const object = lookup(commitOid) as GitObject;
      wanted.add(commitOid);
      const commit = parseCommit(object.data);
      const treeClosure = collectReachable([commit.tree], lookup, { allowMissing: true });
      for (const oid of treeClosure) wanted.add(oid);
    }
    // Tag wants themselves are always included; a non-commit, non-tag want includes its closure.
    for (const oid of wants) {
      const object = lookup(oid);
      if (object?.type === 'tag') wanted.add(oid);
      else if (object && object.type !== 'commit') {
        for (const reachable of collectReachable([oid], lookup, { allowMissing: true })) wanted.add(reachable);
      }
    }
  }
  const deliver = new Set<string>();
  for (const oid of wanted) if (!held.has(oid)) deliver.add(oid);
  // Unshallow: a client boundary whose parents are all now held or delivered.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (boundary.includes(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    if (parents.every((parent) => held.has(parent) || deliver.has(parent))) unshallow.push(oid);
  }
  return { deliver, shallow: boundary, unshallow };
}
