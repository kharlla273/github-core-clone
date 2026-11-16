// store.ts — the forge's in-memory store: one process, no database. Repositories hold their git
// objects and refs plus their issues, pull requests, labels and comments; every surface (REST,
// GraphQL, MCP, git smart HTTP) reads and writes the same objects, so a change over one surface
// is visible over the others immediately.
//
// Determinism: timestamps come from MAKEFUN_TRIAL_NOW (the trial's fixed opening time) when the
// environment sets it, else the scenario epoch; ordering never depends on the clock — every
// created thing carries a monotonic sequence number, and lists sort by it.

import {
  buildCommit,
  buildTree,
  commitFiles,
  filesToTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  ZERO_OID,
  type FileEntry,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { VIEWER } from './scenario.ts';

export const DEFAULT_BRANCH = 'main';

/** The trial's fixed "now": MAKEFUN_TRIAL_NOW when set (epoch seconds or an ISO date), else the scenario epoch. */
export function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      if (Number.isFinite(value)) return value > 1e12 ? Math.floor(value / 1000) : value;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario epoch
}

export function trialNowIso(): string {
  return new Date(trialNowSec() * 1000).toISOString();
}

/** The identity commits and comments are authored under: the token owner. */
export function authorIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

// ---------------------------------------------------------------------------------------------
// global ids (GraphQL Relay ids, opaque and stable)
// ---------------------------------------------------------------------------------------------

type GlobalKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';

function encodeGlobalId(kind: GlobalKind, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(value: string): { kind: GlobalKind; id: number } | null {
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    const match = /^(Repository|Issue|PullRequest|IssueComment):(\d+)$/.exec(text);
    if (!match) return null;
    return { kind: match[1] as GlobalKind, id: Number(match[2]) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------------------------

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly id: number; // the REST numeric id (global across repos)
  readonly number: number; // the per-repo number, shared with pull requests
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly comments: IssueComment[];
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number; // the databaseId, global across repos
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
  /** git objects by oid */
  readonly objects: Map<string, GitObject>;
  /** refs by full name (refs/heads/..., refs/tags/...) */
  readonly refs: Map<string, string>;
  /** issues by number */
  readonly issues: Map<number, Issue>;
  /** pull requests by number */
  readonly pulls: Map<number, PullRequest>;
  /** labels by name */
  readonly labels: Map<string, Label>;
  /** the next shared issue/PR number */
  nextNumber: number;
  /** the next comment id within this repo (global ids come from the store counter) */
  nextCommentSeq: number;
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

export class Store {
  readonly repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextLabelId = 1;
  private nextCommentId = 1;
  private seq = 1;

  private nextSeq(): number {
    const value = this.seq;
    this.seq += 1;
    return value;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = trialNowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentSeq: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // -- git objects -----------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  // -- refs ------------------------------------------------------------------

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  // -- labels ----------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { id: this.nextLabelId++, name, color };
    repo.labels.set(name, label);
    return label;
  }

  // -- issues ----------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const now = trialNowIso();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssueById(id: number): { repo: Repo; issue: Issue } | null {
    for (const repo of this.repos.values()) {
      for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
    }
    return null;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const now = trialNowIso();
    const comment: IssueComment = {
      id: this.nextCommentId++,
      body,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    issue.comments.push(comment);
    repo.nextCommentSeq += 1;
    return comment;
  }

  // -- pull requests ---------------------------------------------------------

  createPullRequest(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest {
    const now = trialNowIso();
    const pull: PullRequest = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  getPullById(id: number): { repo: Repo; pull: PullRequest } | null {
    for (const repo of this.repos.values()) {
      for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
    }
    return null;
  }

  openPullForBranches(repo: Repo, headRef: string, baseRef: string): PullRequest | undefined {
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
    }
    return undefined;
  }

  // -- global ids ------------------------------------------------------------

  repoGlobalId(repo: Repo): string {
    return encodeGlobalId('Repository', repo.id);
  }

  issueGlobalId(issue: Issue): string {
    return encodeGlobalId('Issue', issue.id);
  }

  pullGlobalId(pull: PullRequest): string {
    return encodeGlobalId('PullRequest', pull.id);
  }

  commentGlobalId(comment: IssueComment): string {
    return encodeGlobalId('IssueComment', comment.id);
  }
}

// ---------------------------------------------------------------------------------------------
// commits created by the forge itself (contents writes, squash merges)
// ---------------------------------------------------------------------------------------------

/**
 * Commit a file map on a branch: builds the trees, writes the commit, moves the ref.
 * `parents` defaults to the branch's current tip (or none for an unborn branch).
 */
export function commitFileMap(
  store: Store,
  repo: Repo,
  branch: string,
  files: ReadonlyMap<string, FileEntry>,
  message: string,
  parents?: readonly string[],
): string {
  const put = (type: GitObjectType, data: Buffer): string => store.putObject(repo, type, data);
  const treeOid = filesToTree(files, put);
  const tip = store.branchTip(repo, branch);
  const parentList = parents ?? (tip !== undefined ? [tip] : []);
  const identity = authorIdentity();
  const commitOid = store.putObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents: parentList, author: identity, committer: identity, timestamp: trialNowSec(), message }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

/** Read one file from a commit (or null when the path is not a blob there). */
export function readFileAtCommit(
  store: Store,
  repo: Repo,
  commitOid: string,
  path: string,
): { oid: string; mode: string; data: Buffer } | null {
  const files = commitFiles(commitOid, store.lookup(repo));
  const entry = files.get(path);
  if (!entry) return null;
  const object = store.getObject(repo, entry.oid);
  if (!object || object.type !== 'blob') return null;
  return { oid: entry.oid, mode: entry.mode, data: object.data };
}

/** List one directory of a commit's tree (null when the path is not a directory there). */
export function listDirAtCommit(
  store: Store,
  repo: Repo,
  commitOid: string,
  dirPath: string,
): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string; size?: number }> | null {
  const commit = store.getObject(repo, commitOid);
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  if (dirPath !== '') {
    const segments = dirPath.split('/');
    for (const segment of segments) {
      const treeObject = store.getObject(repo, treeOid);
      if (!treeObject || treeObject.type !== 'tree') return null;
      const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
  }
  const treeObject = store.getObject(repo, treeOid);
  if (!treeObject || treeObject.type !== 'tree') return null;
  const out: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string; size?: number }> = [];
  for (const entry of parseTree(treeObject.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid });
    } else if (entry.mode !== '160000') {
      const blob = store.getObject(repo, entry.oid);
      out.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 });
    }
  }
  return out;
}

/** List a repo's commits reachable from a tip, newest first (children before parents). */
export function listCommits(store: Store, repo: Repo, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.getObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// pull-request diffs and merges
// ---------------------------------------------------------------------------------------------

export interface PullFileChange {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed' | 'changed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/** Count the lines of a blob (a trailing newline does not add an empty line). */
function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** A cheap line-diff count between two blobs: common prefix/suffix trimmed, the rest changed. */
function diffLineCounts(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = before.toString('utf8').split('\n');
  const b = after.toString('utf8').split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { additions: b.length - prefix - suffix, deletions: a.length - prefix - suffix };
}

/** The files a pull request changes: merge-base tree vs head tree. */
export function pullRequestFiles(store: Store, repo: Repo, pull: PullRequest): PullFileChange[] {
  const headTip = store.branchTip(repo, pull.headRef);
  const baseTip = store.branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return [];
  const lookup = store.lookup(repo);
  const base = mergeBase(headTip, baseTip, lookup) ?? baseTip;
  const baseFiles = commitFiles(base, lookup);
  const headFiles = commitFiles(headTip, lookup);
  const changes: PullFileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before && !after) {
      const data = store.getObject(repo, before.oid)?.data ?? Buffer.alloc(0);
      const deletions = countLines(data);
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!before && after) {
      const data = store.getObject(repo, after.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(data);
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before && after && before.oid !== after.oid) {
      const beforeData = store.getObject(repo, before.oid)?.data ?? Buffer.alloc(0);
      const afterData = store.getObject(repo, after.oid)?.data ?? Buffer.alloc(0);
      const { additions, deletions } = diffLineCounts(beforeData, afterData);
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

export interface MergePlan {
  readonly conflict: boolean;
  /** The merged file map (only meaningful when conflict is false). */
  readonly files: Map<string, FileEntry>;
}

/** A three-way merge of file maps: base (merge-base), head, and the base branch tip. */
export function planMerge(store: Store, repo: Repo, pull: PullRequest): MergePlan | null {
  const headTip = store.branchTip(repo, pull.headRef);
  const baseTip = store.branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return null;
  const lookup = store.lookup(repo);
  const base = mergeBase(headTip, baseTip, lookup) ?? baseTip;
  const baseFiles = commitFiles(base, lookup);
  const headFiles = commitFiles(headTip, lookup);
  const tipFiles = commitFiles(baseTip, lookup);
  const merged = new Map<string, FileEntry>(tipFiles);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of paths) {
    const ancestor = baseFiles.get(path);
    const head = headFiles.get(path);
    const tip = tipFiles.get(path);
    const headChanged = (head?.oid ?? null) !== (ancestor?.oid ?? null);
    const tipChanged = (tip?.oid ?? null) !== (ancestor?.oid ?? null);
    if (headChanged && tipChanged) {
      // Both sides changed it: a conflict unless they changed it the same way.
      if ((head?.oid ?? null) !== (tip?.oid ?? null)) return { conflict: true, files: merged };
      continue;
    }
    if (headChanged) {
      if (head) merged.set(path, head);
      else merged.delete(path);
    }
  }
  return { conflict: false, files: merged };
}

/** Squash-merge a pull request onto its base branch; returns the merge commit sha, or null on conflict. */
export function squashMerge(store: Store, repo: Repo, pull: PullRequest): string | null {
  const plan = planMerge(store, repo, pull);
  if (plan === null || plan.conflict) return null;
  const baseTip = store.branchTip(repo, pull.baseRef) as string;
  const message = `${pull.title} (#${pull.number})`;
  const sha = commitFileMap(store, repo, pull.baseRef, plan.files, message, [baseTip]);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = trialNowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = trialNowIso();
  return sha;
}

/** Whether a pull request's head is a fast-forward of (or equal to) its base — for mergeability. */
export function pullIsFastForward(store: Store, repo: Repo, pull: PullRequest): boolean {
  const headTip = store.branchTip(repo, pull.headRef);
  const baseTip = store.branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return false;
  return headTip === baseTip || isAncestor(baseTip, headTip, store.lookup(repo));
}

// Keep the tree builder import used for the contents path's empty-tree case.
export function emptyTreeOid(store: Store, repo: Repo): string {
  return store.putObject(repo, 'tree', buildTree([]));
}

export { ZERO_OID };
export type { TreeEntry };
