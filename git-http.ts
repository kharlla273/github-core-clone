// git-http.ts — git smart HTTP: the upload-pack / receive-pack endpoints the suite's git
// client speaks. Protocol v2 for upload-pack (ls-refs + fetch, with the v0 fallback the
// client still exercises) and v0 for receive-pack.
//
// The wire rules that matter, all from the kit's git-client:
//  - v2 ads open with `version 2`; v0 ads open with a `# service=...` preamble + flush.
//  - v2 ls-refs answers HEAD with symref-target even on an unborn repo, and peels annotated
//    tags when `peel` is asked for; ref-prefix filters server-side.
//  - v2 fetch answers its sections in order (acknowledgments, shallow-info, packfile), the
//    pack as sideband band-1 packets; an empty fetch still sends a 0-object pack.
//  - v0 fetch answers shallow/unshallow/ACK/NAK lines, then sideband packets, no flush
//    between the ACKs and the pack (the client tells them apart by the first byte).
//  - receive-pack unpacks the pack before any ref check, then reports one line per command:
//    `unpack ok` first, then `ok <ref>` / `ng <ref> <reason>` inside sideband band 1.
//  - a malformed body never crashes the server: it is a 400, and the repo survives.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  decodePktLines,
  encodePktLine,
  isAncestor,
  isObjectId,
  peelToCommit,
  pktLineFlush,
  readPack,
  selectFetch,
  splitReceivePackBody,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitPacket,
} from './gitobj.ts';
import { trialNowIso, type Repo } from './store.ts';
import { isAuthorized, sendError, sendRaw, type ForgeContext } from './http-util.ts';

const AGENT = 'github-forge/1.0.0';
const UPLOAD_V0_CAPS =
  `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
/** A sideband packet's payload is 1 band byte + data; the pkt-line cap is 65520. */
const SIDEBAND_CHUNK = 65515;

// ---------------------------------------------------------------------------------------------
// ref listings
// ---------------------------------------------------------------------------------------------

interface RefLine {
  readonly oid: string;
  readonly ref: string;
  /** The commit an annotated tag peels to (absent for lightweight tags and branches). */
  readonly peeled: string | null;
}

/** Every ref, sorted: heads first, then tags (HEAD itself is added by the callers). */
function listRefs(repo: Repo): RefLine[] {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const refs: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    let peeled: string | null = null;
    const object = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && object?.type === 'tag') {
      peeled = peelToCommit(oid, lookup);
    }
    refs.push({ oid, ref: name, peeled });
  }
  return refs;
}

function headOid(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// ---------------------------------------------------------------------------------------------
// sideband + pack framing
// ---------------------------------------------------------------------------------------------

/** A pack as sideband band-1 packets (at least one packet, even for an empty pack). */
function packSideband(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  if (pack.length === 0) {
    packets.push(encodePktLine(Buffer.from([1])));
    return packets;
  }
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, offset + SIDEBAND_CHUNK);
    packets.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

/** The objects a fetch delivers, as a deterministic (oid-sorted) delta-free pack. */
function buildPack(repo: Repo, oids: ReadonlySet<string>): Buffer {
  const objects: GitObject[] = [];
  for (const oid of [...oids].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return writePack(objects);
}

/** ACK lines for the haves the server actually holds (v2 marks the last one `ready`). */
function ackLines(repo: Repo, haves: readonly string[], v2: boolean): string[] {
  const held = haves.filter((oid) => repo.objects.has(oid));
  if (held.length === 0) return ['NAK'];
  return held.map((oid, index) => (v2 && index === held.length - 1 ? `ACK ${oid} ready` : `ACK ${oid}`));
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine(`# service=git-${service}\n`));
  parts.push(pktLineFlush());
  const caps = service === 'upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const head = headOid(repo);
  const refs = listRefs(repo);
  if (head === null && refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const line = (oid: string, ref: string): void => {
      parts.push(encodePktLine(first ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`));
      first = false;
    };
    if (head !== null) line(head, 'HEAD');
    for (const ref of refs) {
      line(ref.oid, ref.ref);
      if (ref.peeled !== null) parts.push(encodePktLine(`${ref.peeled} ${ref.ref}^{}\n`));
    }
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow thin-pack ofs-delta\n'),
    encodePktLine('object-format=sha1\n'),
    pktLineFlush(),
  ];
  return Buffer.concat(parts);
}

function wantsV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  const values = Array.isArray(header) ? header : [header ?? ''];
  return values.some((value) => value.split(',').map((part) => part.trim()).includes('version=2'));
}

export function handleGitInfoRefs(
  ctx: ForgeContext,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo | undefined,
  service: string | null,
): void {
  if (repo === undefined) {
    sendError(res, ctx, 404, 'Not Found');
    return;
  }
  if (!isAuthorized(req, ctx)) {
    sendError(res, ctx, 401, 'Bad credentials');
    return;
  }
  if (service === 'git-upload-pack') {
    if (wantsV2(req)) {
      sendRaw(res, ctx, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    } else {
      sendRaw(res, ctx, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'upload-pack'));
    }
    return;
  }
  if (service === 'git-receive-pack') {
    sendRaw(res, ctx, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'receive-pack'));
    return;
  }
  sendError(res, ctx, 400, `Unknown service ${service ?? ''}`);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: protocol v2
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth: number | null;
}

function parseV2FetchArgs(lines: readonly string[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('want ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
    // thin-pack, no-progress, ofs-delta, agent=, object-format=, done: nothing to do.
  }
  return { wants, haves, shallow, depth };
}

function handleV2LsRefs(repo: Repo, lines: readonly string[]): Buffer {
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === 'peel') peel = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    // symrefs, agent=, object-format=: the reply always carries the HEAD symref.
  }
  const matches = (ref: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  if (matches('HEAD')) {
    if (head !== null) {
      parts.push(encodePktLine(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else if (unborn) {
      parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const ref of listRefs(repo)) {
    if (!matches(ref.ref)) continue;
    let line = `${ref.oid} ${ref.ref}`;
    if (peel && ref.peeled !== null) line += ` peeled:${ref.peeled}`;
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function handleV2Fetch(repo: Repo, lines: readonly string[]): Buffer {
  const request = parseV2FetchArgs(lines);
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const selection = selectFetch(request.wants, request.haves, request.shallow, request.depth, lookup);
  const pack = buildPack(repo, selection.deliver);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  for (const line of ackLines(repo, request.haves, true)) parts.push(encodePktLine(`${line}\n`));
  parts.push(pktLineFlush());
  parts.push(encodePktLine('shallow-info\n'));
  for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(pktLineFlush());
  parts.push(encodePktLine('packfile\n'));
  for (const packet of packSideband(pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function handleV2UploadPack(repo: Repo, packets: readonly GitPacket[]): Buffer {
  const lines: string[] = [];
  let command: string | null = null;
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trimEnd();
    if (command === null && text.startsWith('command=')) {
      command = text.slice('command='.length);
      continue;
    }
    if (sawDelim) lines.push(text);
  }
  if (command === 'ls-refs') return handleV2LsRefs(repo, lines);
  if (command === 'fetch') return handleV2Fetch(repo, lines);
  throw new Error(`unsupported protocol v2 command ${JSON.stringify(command)}`);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: protocol v0
// ---------------------------------------------------------------------------------------------

function handleV0Fetch(repo: Repo, packets: readonly GitPacket[]): Buffer {
  const beforeFlush: string[] = [];
  const afterFlush: string[] = [];
  let flushed = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      flushed = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trimEnd();
    if (flushed) afterFlush.push(text);
    else beforeFlush.push(text);
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of beforeFlush) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      if (isObjectId(oid)) wants.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  for (const line of afterFlush) {
    if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    }
    // done: nothing to do.
  }
  const request: FetchRequest = { wants, haves, shallow, depth };
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const selection = selectFetch(request.wants, request.haves, request.shallow, request.depth, lookup);
  const pack = buildPack(repo, selection.deliver);
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const line of ackLines(repo, request.haves, false)) parts.push(encodePktLine(`${line}\n`));
  for (const packet of packSideband(pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

export function handleGitUploadPack(
  ctx: ForgeContext,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo | undefined,
  body: Buffer,
): void {
  if (repo === undefined) {
    sendError(res, ctx, 404, 'Not Found');
    return;
  }
  if (!isAuthorized(req, ctx)) {
    sendError(res, ctx, 401, 'Bad credentials');
    return;
  }
  let packets: GitPacket[];
  try {
    packets = decodePktLines(body);
  } catch (err) {
    sendError(res, ctx, 400, `Malformed git request: ${(err as Error).message}`);
    return;
  }
  // v2 when the client asked for it, or when the body opens with a command= line.
  const firstData = packets.find((packet) => packet.kind === 'data');
  const firstText = firstData?.kind === 'data' ? firstData.payload.toString('utf8') : '';
  const isV2 = wantsV2(req) || firstText.startsWith('command=');
  try {
    const response = isV2 ? handleV2UploadPack(repo, packets) : handleV0Fetch(repo, packets);
    sendRaw(res, ctx, 200, 'application/x-git-upload-pack-result', response);
  } catch (err) {
    sendError(res, ctx, 400, `Malformed git request: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack (protocol v0 only)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function parsePushCommand(line: string): PushCommand | null {
  const withoutCaps = line.split('\0')[0] as string;
  const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(withoutCaps.trimEnd());
  if (!match) return null;
  return { oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string };
}

export function handleGitReceivePack(
  ctx: ForgeContext,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo | undefined,
  body: Buffer,
): void {
  if (repo === undefined) {
    sendError(res, ctx, 404, 'Not Found');
    return;
  }
  if (!isAuthorized(req, ctx)) {
    sendError(res, ctx, 401, 'Bad credentials');
    return;
  }
  const report = (lines: string[], sideband: boolean): void => {
    const parts: Buffer[] = [];
    for (const line of lines) {
      parts.push(
        sideband
          ? encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')]))
          : encodePktLine(line),
      );
    }
    parts.push(pktLineFlush());
    sendRaw(res, ctx, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
  };
  let commandPackets: GitPacket[];
  let packBytes: Buffer;
  try {
    const split = splitReceivePackBody(body);
    commandPackets = split.commandPackets;
    packBytes = split.pack;
  } catch {
    // A body that is not pkt-lines at all: a clean 400, the repo untouched.
    sendError(res, ctx, 400, 'Malformed git request: the command section is not pkt-lines');
    return;
  }
  const lines: string[] = [];
  let sideband = false;
  for (const packet of commandPackets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0 && text.slice(nul + 1).split(' ').includes('side-band-64k')) sideband = true;
    lines.push(text);
  }
  const commands: PushCommand[] = [];
  for (const line of lines) {
    const command = parsePushCommand(line);
    if (command === null) {
      sendError(res, ctx, 400, 'Malformed git request: a push command did not parse');
      return;
    }
    commands.push(command);
  }
  // Unpack first: even a refused push reports `unpack ok` when its pack is sound.
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) repo.objects.set(oid, object);
    } catch (err) {
      const reportLines = [`unpack ${(err as Error).message}\n`];
      for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
      report(reportLines, sideband);
      return;
    }
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // Validate every command against the pre-push state, then apply the accepted ones.
  const results: Array<{ command: PushCommand; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    const isBranch = command.ref.startsWith('refs/heads/');
    const isTag = command.ref.startsWith('refs/tags/');
    if (!isBranch && !isTag) {
      results.push({ command, ok: false, reason: 'invalid ref' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete: the old tip must match what the server holds.
      if (current === undefined || current !== command.oldOid) {
        results.push({ command, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      results.push({ command, ok: true, reason: '' });
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      results.push({ command, ok: false, reason: 'object not found' });
      continue;
    }
    if (isBranch) {
      // A branch must point at a commit (directly, or through an annotated tag).
      if (peelToCommit(command.newOid, lookup) === null) {
        results.push({ command, ok: false, reason: 'not a commit' });
        continue;
      }
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ command, ok: false, reason: 'already exists' });
        continue;
      }
      results.push({ command, ok: true, reason: '' });
      continue;
    }
    // Update: the client's old tip must be the server's tip, and the new tip must descend.
    if (current === undefined || current !== command.oldOid) {
      results.push({ command, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === command.oldOid) {
      results.push({ command, ok: true, reason: '' });
      continue;
    }
    const oldCommit = peelToCommit(command.oldOid, lookup);
    const newCommit = peelToCommit(command.newOid, lookup);
    if (oldCommit === null || newCommit === null || !isAncestor(oldCommit, newCommit, lookup)) {
      results.push({ command, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    results.push({ command, ok: true, reason: '' });
  }
  let applied = false;
  for (const result of results) {
    if (!result.ok) continue;
    if (result.command.newOid === ZERO_OID) repo.refs.delete(result.command.ref);
    else repo.refs.set(result.command.ref, result.command.newOid);
    applied = true;
  }
  if (applied) repo.updatedAt = trialNowIso();
  const reportLines = ['unpack ok\n'];
  for (const result of results) {
    reportLines.push(
      result.ok ? `ok ${result.command.ref}\n` : `ng ${result.command.ref} ${result.reason}\n`,
    );
  }
  report(reportLines, sideband);
}
