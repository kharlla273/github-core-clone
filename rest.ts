// rest.ts — the GitHub REST v3 surface (/api/v3): repositories, branches, commits, contents,
// labels, issues, comments and pull requests. Every reply is application/json with a
// non-empty X-GitHub-Request-Id; errors carry a string `message`. A request without the suite's
// bearer token is 401; a repository under any owner but the token owner's is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitFileMap,
  listCommits,
  listDirAtCommit,
  planMerge,
  pullRequestFiles,
  readFileAtCommit,
  squashMerge,
  trialNowIso,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';
import {
  commitFiles,
  isObjectId,
  parseCommit,
  ZERO_OID,
} from './gitobj.ts';
import { VIEWER } from './scenario.ts';
import {
  isAuthorized,
  isRecord,
  linkHeader,
  pageParams,
  paginate,
  parseJsonBody,
  sendError,
  sendJson,
  type ForgeContext,
} from './http-util.ts';

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function userView(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function repoView(repo: Repo, origin: string): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: full,
    owner: userView(),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    html_url: `${origin}/${full}`,
    url: `${origin}/api/v3/repos/${full}`,
    clone_url: `${origin}/${full}.git`,
    git_url: `${origin}/${full}.git`,
    ssh_url: `git@example.invalid:${full}.git`,
  };
}

function labelView(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, default: false, description: '' };
}

function issueView(issue: Issue, repo: Repo, origin: string): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map(labelView),
    user: userView(),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: `${origin}/${full}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${full}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${full}`,
    comments_url: `${origin}/api/v3/repos/${full}/issues/${issue.number}/comments`,
  };
}

function commentView(comment: { id: number; body: string; createdAt: string; updatedAt: string }, repo: Repo, number: number, origin: string): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    body: comment.body,
    user: userView(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `${origin}/${full}/issues/${number}#issuecomment-${comment.id}`,
    url: `${origin}/api/v3/repos/${full}/issues/comments/${comment.id}`,
    author_association: 'OWNER',
  };
}

function pullView(ctx: ForgeContext, pull: PullRequest, repo: Repo, origin: string): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const headSha = ctx.store.branchTip(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = ctx.store.branchTip(repo, pull.baseRef) ?? ZERO_OID;
  let mergeable: boolean | null = null;
  if (pull.state === 'open') {
    const plan = planMerge(ctx.store, repo, pull);
    mergeable = plan !== null && !plan.conflict;
  }
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userView(),
    assignee: null,
    assignees: [],
    milestone: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? (pull.mergedAt ?? pull.updatedAt) : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.state === 'open' ? (mergeable ? 'clean' : 'dirty') : 'unknown',
    merged_by: pull.merged ? userView() : null,
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userView(),
      repo: repoView(repo, origin),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userView(),
      repo: repoView(repo, origin),
    },
    author_association: 'OWNER',
    html_url: `${origin}/${full}/pull/${pull.number}`,
    url: `${origin}/api/v3/repos/${full}/pulls/${pull.number}`,
  };
}

/** Parse `Name <email> <epoch> +0000` into its parts. */
function parseIdentityLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: trialNowIso() };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

function commitView(ctx: ForgeContext, repo: Repo, sha: string, origin: string): Record<string, unknown> | null {
  const object = ctx.store.getObject(repo, sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdentityLine(commit.author);
  const committer = parseIdentityLine(commit.committer);
  const full = `${repo.owner}/${repo.name}`;
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`, 'utf8').toString('base64url'),
    commit: {
      // GitHub returns the message without the trailing newline the object stores.
      message: commit.message.replace(/\n$/, ''),
      author,
      committer,
      tree: { sha: commit.tree },
      url: `${origin}/api/v3/repos/${full}/git/commits/${sha}`,
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `${origin}/api/v3/repos/${full}/commits/${sha}`,
    html_url: `${origin}/${full}/commit/${sha}`,
  };
}

/** Resolve a ref query (?ref= / ?sha=): a branch name, a 40-hex commit, or the default branch. */
function resolveRef(ctx: ForgeContext, repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return ctx.store.defaultTip(repo);
  const branch = ctx.store.branchTip(repo, ref);
  if (branch !== undefined) return branch;
  if (isObjectId(ref)) {
    const object = ctx.store.getObject(repo, ref);
    if (object?.type === 'commit') return ref;
  }
  return undefined;
}

function sendNoContent(res: ServerResponse, ctx: ForgeContext): void {
  res.writeHead(204, {
    'x-github-request-id': ctx.nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
  });
  res.end();
}

/**
 * Handle one REST request. `segments` are the path segments after /api/v3 (decoded); `query` is
 * the parsed query string; `body` is the raw request body (empty for GET/DELETE without one).
 */
export async function handleRest(
  ctx: ForgeContext,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  body: Buffer,
): Promise<void> {
  const method = req.method ?? 'GET';
  const origin = `http://${req.headers.host ?? 'localhost'}`;
  const store = ctx.store;

  // The API root and meta answer without a token (GitHub's root is public); everything else
  // under /api/v3 requires the suite's bearer token.
  const isRoot = segments.length === 0;
  const isMeta = segments.length === 1 && segments[0] === 'meta';
  if (!isRoot && !isMeta && !isAuthorized(req, ctx)) {
    sendError(res, ctx, 401, 'Bad credentials');
    return;
  }

  const jsonBody = async (): Promise<Record<string, unknown> | null> => {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, ctx, 400, 'Problems parsing JSON');
      return null;
    }
    if (!isRecord(parsed.value)) {
      sendError(res, ctx, 400, 'Problems parsing JSON');
      return null;
    }
    return parsed.value;
  };

  // -- API root -----------------------------------------------------------------
  if (isRoot) {
    if (method !== 'GET') {
      sendError(res, ctx, 404, 'Not Found');
      return;
    }
    sendJson(res, ctx, 200, {
      current_user_url: `${origin}/api/v3/user`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${origin}/api/v3/user/repos{?type,page,per_page}`,
      emojis_url: `${origin}/api/v3/emojis`,
      meta_url: `${origin}/api/v3/meta`,
    });
    return;
  }

  // -- meta ---------------------------------------------------------------------
  if (isMeta) {
    if (method !== 'GET') {
      sendError(res, ctx, 404, 'Not Found');
      return;
    }
    sendJson(res, ctx, 200, {
      verifiable_password_authentication: true,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      built_with: [],
      installed_version: '1.0.0',
    });
    return;
  }

  // -- the authenticated user ----------------------------------------------------
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') {
      sendError(res, ctx, 404, 'Not Found');
      return;
    }
    sendJson(res, ctx, 200, {
      ...userView(),
      html_url: `${origin}/${VIEWER.login}`,
      url: `${origin}/api/v3/user`,
      repos_url: `${origin}/api/v3/user/repos`,
    });
    return;
  }

  // -- POST /user/repos, GET /user/repos ----------------------------------------
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const input = await jsonBody();
      if (input === null) return;
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '' || !REPO_NAME_RE.test(name)) {
        sendError(res, ctx, 422, 'Validation Failed: name is invalid');
        return;
      }
      if (store.getRepo(VIEWER.login, name) !== undefined) {
        sendError(res, ctx, 422, 'Validation Failed: name already exists on this account');
        return;
      }
      const repo = store.createRepo(
        VIEWER.login,
        name,
        typeof input.description === 'string' ? input.description : '',
        input.private === true,
      );
      sendJson(res, ctx, 201, repoView(repo, origin));
      return;
    }
    if (method === 'GET') {
      const params = pageParams(query);
      const repos = store.listRepos(VIEWER.login);
      const link = linkHeader(req, '/api/v3/user/repos', query, params, repos.length);
      sendJson(res, ctx, 200, paginate(repos, params).map((repo) => repoView(repo, origin)), link ? { link } : {});
      return;
    }
    sendError(res, ctx, 404, 'Not Found');
    return;
  }

  // -- /repos/{owner}/{repo}/... --------------------------------------------------
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const repoName = segments[2] as string;
    const rest = segments.slice(3);
    // A repository belongs to the login the token names; any other owner is a 404, never a 403.
    const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
    if (repo === undefined) {
      sendError(res, ctx, 404, 'Not Found');
      return;
    }

    // GET/PATCH/DELETE /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, ctx, 200, repoView(repo, origin));
        return;
      }
      if (method === 'PATCH') {
        const input = await jsonBody();
        if (input === null) return;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        repo.updatedAt = trialNowIso();
        sendJson(res, ctx, 200, repoView(repo, origin));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        sendNoContent(res, ctx);
        return;
      }
      sendError(res, ctx, 404, 'Not Found');
      return;
    }

    const sub = rest[0] as string;

    // -- branches ---------------------------------------------------------------
    if (sub === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = store.listBranches(repo).map((branch) => ({
          name: branch.name,
          commit: { sha: branch.sha, url: `${origin}/api/v3/repos/${owner}/${repoName}/commits/${branch.sha}` },
          protected: false,
        }));
        sendJson(res, ctx, 200, branches);
        return;
      }
      if (rest.length >= 2 && method === 'GET') {
        const branchName = rest.slice(1).join('/');
        const sha = store.branchTip(repo, branchName);
        if (sha === undefined) {
          sendError(res, ctx, 404, 'Not Found');
          return;
        }
        sendJson(res, ctx, 200, {
          name: branchName,
          commit: { sha, url: `${origin}/api/v3/repos/${owner}/${repoName}/commits/${sha}` },
          protected: false,
        });
        return;
      }
      sendError(res, ctx, 404, 'Not Found');
      return;
    }

    // -- git refs -----------------------------------------------------------------
    if (sub === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const input = await jsonBody();
        if (input === null) return;
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!ref.startsWith('refs/') || ref.length > 200) {
          sendError(res, ctx, 422, 'Validation Failed: ref must start with refs/');
          return;
        }
        if (!isObjectId(sha) || store.getObject(repo, sha) === undefined) {
          sendError(res, ctx, 422, 'Validation Failed: sha does not name an object in this repository');
          return;
        }
        if (store.refTip(repo, ref) !== undefined) {
          sendError(res, ctx, 422, 'Validation Failed: Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, ctx, 201, {
          ref,
          node_id: Buffer.from(`Ref:${ref}`, 'utf8').toString('base64url'),
          url: `${origin}/api/v3/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}`,
          object: { sha, type: store.getObject(repo, sha)?.type ?? 'commit', url: `${origin}/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
        });
        return;
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const refs: Array<Record<string, unknown>> = [];
          for (const [name, sha] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
            refs.push({ ref: name, object: { sha, type: store.getObject(repo, sha)?.type ?? 'commit' } });
          }
          sendJson(res, ctx, 200, refs);
          return;
        }
        const refName = `refs/${rest.slice(2).join('/')}`;
        const sha = store.refTip(repo, refName);
        if (sha === undefined) {
          sendError(res, ctx, 404, 'Not Found');
          return;
        }
        sendJson(res, ctx, 200, {
          ref: refName,
          node_id: Buffer.from(`Ref:${refName}`, 'utf8').toString('base64url'),
          url: `${origin}/api/v3/repos/${owner}/${repoName}/git/refs/${refName.slice(5)}`,
          object: { sha, type: store.getObject(repo, sha)?.type ?? 'commit' },
        });
        return;
      }
      sendError(res, ctx, 404, 'Not Found');
      return;
    }

    // -- commits ------------------------------------------------------------------
    if (sub === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const ref = query.get('sha');
        const tip = resolveRef(ctx, repo, ref);
        if (tip === undefined) {
          if (ref !== null && ref !== '' && store.branchTip(repo, ref) === undefined && !isObjectId(ref)) {
            sendError(res, ctx, 404, 'Not Found');
            return;
          }
          sendJson(res, ctx, 200, []);
          return;
        }
        const params = pageParams(query);
        const shas = listCommits(store, repo, tip, 10_000);
        const views = shas
          .map((sha) => commitView(ctx, repo, sha, origin))
          .filter((view): view is Record<string, unknown> => view !== null);
        const link = linkHeader(req, `/api/v3/repos/${owner}/${repoName}/commits`, query, params, views.length);
        sendJson(res, ctx, 200, paginate(views, params), link ? { link } : {});
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const view = commitView(ctx, repo, rest[1] as string, origin);
        if (view === null) {
          sendError(res, ctx, 404, 'Not Found');
          return;
        }
        sendJson(res, ctx, 200, view);
        return;
      }
      sendError(res, ctx, 404, 'Not Found');
      return;
    }

    // -- contents -------------------------------------------------------------------
    if (sub === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'GET') {
        const tip = resolveRef(ctx, repo, query.get('ref'));
        if (tip === undefined) {
          sendError(res, ctx, 404, 'Not Found');
          return;
        }
        if (filePath === '') {
          const listing = listDirAtCommit(store, repo, tip, '');
          sendJson(res, ctx, 200, listing ?? []);
          return;
        }
        const file = readFileAtCommit(store, repo, tip, filePath);
        if (file !== null) {
          sendJson(res, ctx, 200, {
            type: 'file',
            encoding: 'base64',
            size: file.data.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            content: file.data.toString('base64'),
            sha: file.oid,
            url: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
            html_url: `${origin}/${owner}/${repoName}/blob/${query.get('ref') ?? repo.defaultBranch}/${filePath}`,
          });
          return;
        }
        const listing = listDirAtCommit(store, repo, tip, filePath);
        if (listing !== null) {
          sendJson(
            res,
            ctx,
            200,
            listing.map((entry) => ({
              type: entry.type,
              name: entry.name,
              path: entry.path,
              sha: entry.sha,
              size: entry.size ?? 0,
              url: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${entry.path}`,
              html_url: `${origin}/${owner}/${repoName}/${entry.type === 'dir' ? 'tree' : 'blob'}/${query.get('ref') ?? repo.defaultBranch}/${entry.path}`,
            })),
          );
          return;
        }
        sendError(res, ctx, 404, 'Not Found');
        return;
      }
      if (method === 'PUT') {
        const input = await jsonBody();
        if (input === null) return;
        const message = typeof input.message === 'string' ? input.message : '';
        const contentB64 = typeof input.content === 'string' ? input.content : '';
        const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
        const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
        if (message === '') {
          sendError(res, ctx, 422, 'Validation Failed: message is required');
          return;
        }
        if (contentB64 === '') {
          sendError(res, ctx, 422, 'Validation Failed: content is required');
          return;
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          sendError(res, ctx, 422, 'Validation Failed: content is not valid base64');
          return;
        }
        if (filePath === '') {
          sendError(res, ctx, 422, 'Validation Failed: path is required');
          return;
        }
        // The branch the write lands on: created from the default branch tip when it is new.
        let branchTip = store.branchTip(repo, branch);
        if (branchTip === undefined) {
          const defaultTip = store.defaultTip(repo);
          if (defaultTip !== undefined) {
            repo.refs.set(`refs/heads/${branch}`, defaultTip);
            branchTip = defaultTip;
          }
        }
        const existing = branchTip !== undefined ? readFileAtCommit(store, repo, branchTip, filePath) : null;
        const isUpdate = existing !== null;
        if (isUpdate) {
          if (givenSha === undefined) {
            sendError(res, ctx, 422, 'Validation Failed: sha is required to update a file');
            return;
          }
          if (givenSha !== existing.oid) {
            sendError(res, ctx, 409, 'Conflict: sha does not match the file at that path');
            return;
          }
        } else if (givenSha !== undefined) {
          sendError(res, ctx, 422, 'Validation Failed: sha does not match any file at that path');
          return;
        }
        const blobOid = store.putObject(repo, 'blob', content);
        const files = branchTip !== undefined ? commitFiles(branchTip, store.lookup(repo)) : new Map();
        files.set(filePath, { oid: blobOid, mode: '100644' });
        const commitSha = commitFileMap(store, repo, branch, files, message);
        repo.updatedAt = trialNowIso();
        sendJson(res, ctx, isUpdate ? 200 : 201, {
          content: {
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            sha: blobOid,
            size: content.length,
            url: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
            html_url: `${origin}/${owner}/${repoName}/blob/${branch}/${filePath}`,
            type: 'file',
            encoding: 'base64',
            content: contentB64,
          },
          commit: {
            sha: commitSha,
            message,
            author: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
            committer: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
          },
        });
        return;
      }
      if (method === 'DELETE') {
        const input = await jsonBody();
        if (input === null) return;
        const message = typeof input.message === 'string' ? input.message : '';
        const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
        const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
        if (message === '') {
          sendError(res, ctx, 422, 'Validation Failed: message is required');
          return;
        }
        const branchTip = store.branchTip(repo, branch);
        if (branchTip === undefined) {
          sendError(res, ctx, 404, 'Not Found');
          return;
        }
        const existing = readFileAtCommit(store, repo, branchTip, filePath);
        if (existing === null) {
          sendError(res, ctx, 404, 'Not Found');
          return;
        }
        if (givenSha === undefined || givenSha !== existing.oid) {
          sendError(res, ctx, 409, 'Conflict: sha does not match the file at that path');
          return;
        }
        const files = commitFiles(branchTip, store.lookup(repo));
        files.delete(filePath);
        const commitSha = commitFileMap(store, repo, branch, files, message);
        repo.updatedAt = trialNowIso();
        sendJson(res, ctx, 200, {
          content: null,
          commit: {
            sha: commitSha,
            message,
            author: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
            committer: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
          },
        });
        return;
      }
      sendError(res, ctx, 404, 'Not Found');
      return;
    }

    // -- labels ---------------------------------------------------------------------
    if (sub === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        sendJson(res, ctx, 200, [...repo.labels.values()].map(labelView));
        return;
      }
      if (rest.length === 1 && method === 'POST') {
        const input = await jsonBody();
        if (input === null) return;
        const name = typeof input.name === 'string' ? input.name : '';
        if (name === '') {
          sendError(res, ctx, 422, 'Validation Failed: name is required');
          return;
        }
        if (repo.labels.has(name)) {
          sendError(res, ctx, 422, 'Validation Failed: label already exists');
          return;
        }
        const color = typeof input.color === 'string' && /^[0-9a-fA-F]{6}$/.test(input.color) ? input.color.toLowerCase() : 'ededed';
        const label = store.createLabel(repo, name, color);
        sendJson(res, ctx, 201, labelView(label));
        return;
      }
      sendError(res, ctx, 404, 'Not Found');
      return;
    }

    // -- issues -----------------------------------------------------------------------
    if (sub === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = [...repo.issues.values()];
          if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
          else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
          else if (state !== 'all') {
            sendError(res, ctx, 422, 'Validation Failed: state must be open, closed or all');
            return;
          }
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          }
          const params = pageParams(query);
          const link = linkHeader(req, `/api/v3/repos/${owner}/${repoName}/issues`, query, params, issues.length);
          sendJson(res, ctx, 200, paginate(issues, params).map((issue) => issueView(issue, repo, origin)), link ? { link } : {});
          return;
        }
        if (method === 'POST') {
          const input = await jsonBody();
          if (input === null) return;
          const title = typeof input.title === 'string' ? input.title : '';
          if (title === '') {
            sendError(res, ctx, 422, 'Validation Failed: title is required');
            return;
          }
          const bodyText = typeof input.body === 'string' ? input.body : '';
          const labels: Label[] = [];
          if (input.labels !== undefined) {
            if (!Array.isArray(input.labels)) {
              sendError(res, ctx, 422, 'Validation Failed: labels must be an array');
              return;
            }
            for (const entry of input.labels) {
              const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : '';
              const label = repo.labels.get(name);
              if (!label) {
                sendError(res, ctx, 422, `Validation Failed: label "${name}" does not exist`);
                return;
              }
              labels.push(label);
            }
          }
          const issue = store.createIssue(repo, title, bodyText, labels);
          sendJson(res, ctx, 201, issueView(issue, repo, origin));
          return;
        }
        sendError(res, ctx, 404, 'Not Found');
        return;
      }
      const number = Number(rest[1]);
      const issue = Number.isInteger(number) && number > 0 ? repo.issues.get(number) : undefined;
      if (issue === undefined) {
        sendError(res, ctx, 404, 'Not Found');
        return;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, ctx, 200, issueView(issue, repo, origin));
          return;
        }
        if (method === 'PATCH') {
          const input = await jsonBody();
          if (input === null) return;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (typeof input.state === 'string') {
            if (input.state !== 'open' && input.state !== 'closed') {
              sendError(res, ctx, 422, 'Validation Failed: state must be open or closed');
              return;
            }
            issue.state = input.state;
            issue.closedAt = input.state === 'closed' ? trialNowIso() : null;
          }
          issue.updatedAt = trialNowIso();
          sendJson(res, ctx, 200, issueView(issue, repo, origin));
          return;
        }
        sendError(res, ctx, 404, 'Not Found');
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          sendJson(
            res,
            ctx,
            200,
            issue.comments.map((comment) => commentView(comment, repo, issue.number, origin)),
          );
          return;
        }
        if (method === 'POST') {
          const input = await jsonBody();
          if (input === null) return;
          const text = typeof input.body === 'string' ? input.body : '';
          if (text === '') {
            sendError(res, ctx, 422, 'Validation Failed: body is required');
            return;
          }
          const comment = store.addComment(repo, issue, text);
          sendJson(res, ctx, 201, commentView(comment, repo, issue.number, origin));
          return;
        }
        sendError(res, ctx, 404, 'Not Found');
        return;
      }
      sendError(res, ctx, 404, 'Not Found');
      return;
    }

    // -- pull requests ------------------------------------------------------------------
    if (sub === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
          else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
          else if (state !== 'all') {
            sendError(res, ctx, 422, 'Validation Failed: state must be open, closed or all');
            return;
          }
          pulls.sort((a, b) => b.createdSeq - a.createdSeq);
          const params = pageParams(query);
          const link = linkHeader(req, `/api/v3/repos/${owner}/${repoName}/pulls`, query, params, pulls.length);
          sendJson(res, ctx, 200, paginate(pulls, params).map((pull) => pullView(ctx, pull, repo, origin)), link ? { link } : {});
          return;
        }
        if (method === 'POST') {
          const input = await jsonBody();
          if (input === null) return;
          const title = typeof input.title === 'string' ? input.title : '';
          const head = typeof input.head === 'string' ? input.head : '';
          const base = typeof input.base === 'string' ? input.base : '';
          if (title === '' || head === '' || base === '') {
            sendError(res, ctx, 422, 'Validation Failed: title, head and base are required');
            return;
          }
          const headBranch = head.includes(':') ? (head.split(':').pop() as string) : head;
          const baseBranch = base.includes(':') ? (base.split(':').pop() as string) : base;
          if (store.branchTip(repo, headBranch) === undefined) {
            sendError(res, ctx, 422, `Validation Failed: head branch "${headBranch}" does not exist`);
            return;
          }
          if (store.branchTip(repo, baseBranch) === undefined) {
            sendError(res, ctx, 422, `Validation Failed: base branch "${baseBranch}" does not exist`);
            return;
          }
          if (store.openPullForBranches(repo, headBranch, baseBranch) !== undefined) {
            sendError(res, ctx, 422, 'Validation Failed: a pull request already exists for this head and base');
            return;
          }
          const pull = store.createPullRequest(repo, title, typeof input.body === 'string' ? input.body : '', headBranch, baseBranch);
          sendJson(res, ctx, 201, pullView(ctx, pull, repo, origin));
          return;
        }
        sendError(res, ctx, 404, 'Not Found');
        return;
      }
      const number = Number(rest[1]);
      const pull = Number.isInteger(number) && number > 0 ? repo.pulls.get(number) : undefined;
      if (pull === undefined) {
        sendError(res, ctx, 404, 'Not Found');
        return;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, ctx, 200, pullView(ctx, pull, repo, origin));
          return;
        }
        sendError(res, ctx, 404, 'Not Found');
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        sendJson(
          res,
          ctx,
          200,
          pullRequestFiles(store, repo, pull).map((change) => ({
            filename: change.filename,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.changes,
          })),
        );
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const input = await jsonBody();
        if (input === null) return;
        if (pull.merged) {
          sendError(res, ctx, 405, 'Method Not Allowed: pull request has already been merged');
          return;
        }
        if (pull.state === 'closed') {
          sendError(res, ctx, 405, 'Method Not Allowed: pull request is closed');
          return;
        }
        const sha = squashMerge(store, repo, pull);
        if (sha === null) {
          sendError(res, ctx, 405, 'Method Not Allowed: pull request cannot be merged (conflicts)');
          return;
        }
        sendJson(res, ctx, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      sendError(res, ctx, 404, 'Not Found');
      return;
    }

    sendError(res, ctx, 404, 'Not Found');
    return;
  }

  // Anything else under /api/v3 is an unknown route: a JSON 404, never HTML.
  sendError(res, ctx, 404, 'Not Found');
}


// Re-exported for the GraphQL executor's commit reads (kept here to avoid a cycle).
export { commitView };
