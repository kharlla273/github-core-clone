// mcp.ts — Model Context Protocol over Streamable HTTP: the modern 2026-07-28 era
// (server/discover, no handshake/session) plus the legacy 2025-11-25 initialize handshake
// for older clients. Six tools, matching the github-mcp-server names and argument shapes,
// all backed by the same store the REST and GraphQL surfaces use.
//
// Protocol notes the suite relies on:
//  - tools/list must be byte-identical across calls (a frozen tool list, same order).
//  - every tool result carries both a text block (a JSON string of the REST object) and a
//    structuredContent object with the same value; checks read structuredContent first.
//  - an unknown tool is a JSON-RPC -32601/-32602, never an HTTP 500.
//  - a missing required argument fails (isError or -32602), never silently succeeds.
//  - a truncated JSON body is HTTP 400 with a -32700 Parse error, id echoed when recoverable.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import {
  planMerge,
  squashMerge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { isAuthorized, isRecord, sendJson, type ForgeContext } from './http-util.ts';

const SERVER_NAME = 'github-forge-mcp';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { readonly type: string; readonly description: string }>>;
    readonly required: readonly string[];
  };
}

const TOOLS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository in the authenticated user account.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
        owner: Object.freeze({ type: 'string', description: 'The account that owns the repository.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Filter by state: open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

// ---------------------------------------------------------------------------------------------
// REST-shaped views (the MCP checks read the same fields the REST checks do)
// ---------------------------------------------------------------------------------------------

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: '',
    clone_url: '',
    url: '',
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: '',
    url: '',
    repository_url: '',
  };
}

function pullView(ctx: ForgeContext, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = ctx.store.branchTip(repo, pull.headRef) ?? '0000000000000000000000000000000000000000';
  const baseSha = ctx.store.branchTip(repo, pull.baseRef) ?? '0000000000000000000000000000000000000000';
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? (pull.mergedAt ?? pull.updatedAt) : null,
    html_url: '',
    url: '',
  };
}

// ---------------------------------------------------------------------------------------------
// tool execution
// ---------------------------------------------------------------------------------------------

interface ToolOutcome {
  readonly ok: boolean;
  readonly value: unknown;
  readonly message?: string;
}

function missingArgument(tool: string, argument: string): ToolOutcome {
  return { ok: false, value: null, message: `Tool "${tool}" requires argument "${argument}".` };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function executeTool(ctx: ForgeContext, name: string, args: Record<string, unknown>): ToolOutcome {
  const store = ctx.store;
  const owner = asString(args.owner) ?? VIEWER.login;
  const repoName = asString(args.repo);
  switch (name) {
    case 'create_repo': {
      const repoNameArg = asString(args.name);
      if (repoNameArg === null) return missingArgument(name, 'name');
      if (store.getRepo(VIEWER.login, repoNameArg) !== undefined) {
        return { ok: false, value: null, message: `A repository named "${repoNameArg}" already exists.` };
      }
      const repo = store.createRepo(
        VIEWER.login,
        repoNameArg,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return { ok: true, value: repoView(repo) };
    }
    case 'get_repo': {
      if (repoName === null) return missingArgument(name, 'repo');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, value: null, message: `Repository "${owner}/${repoName}" not found.` };
      return { ok: true, value: repoView(repo) };
    }
    case 'create_issue': {
      if (repoName === null) return missingArgument(name, 'repo');
      const title = asString(args.title);
      if (title === null) return missingArgument(name, 'title');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, value: null, message: `Repository "${owner}/${repoName}" not found.` };
      const issue = store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return { ok: true, value: issueView(repo, issue) };
    }
    case 'list_issues': {
      if (repoName === null) return missingArgument(name, 'repo');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, value: null, message: `Repository "${owner}/${repoName}" not found.` };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.createdSeq - b.createdSeq);
      return { ok: true, value: issues.map((issue) => issueView(repo, issue)) };
    }
    case 'create_pull_request': {
      if (repoName === null) return missingArgument(name, 'repo');
      const title = asString(args.title);
      if (title === null) return missingArgument(name, 'title');
      const head = asString(args.head);
      if (head === null) return missingArgument(name, 'head');
      const base = asString(args.base);
      if (base === null) return missingArgument(name, 'base');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, value: null, message: `Repository "${owner}/${repoName}" not found.` };
      const stripPrefix = (ref: string): string => {
        const colon = ref.indexOf(':');
        return colon >= 0 ? ref.slice(colon + 1) : ref;
      };
      const headRef = stripPrefix(head);
      const baseRef = stripPrefix(base);
      if (store.branchTip(repo, headRef) === undefined) {
        return { ok: false, value: null, message: `The head branch "${headRef}" does not exist.` };
      }
      if (store.branchTip(repo, baseRef) === undefined) {
        return { ok: false, value: null, message: `The base branch "${baseRef}" does not exist.` };
      }
      if (store.openPullForBranches(repo, headRef, baseRef) !== undefined) {
        return { ok: false, value: null, message: 'A pull request already exists for this head and base.' };
      }
      const pull = store.createPullRequest(repo, title, typeof args.body === 'string' ? args.body : '', headRef, baseRef);
      return { ok: true, value: pullView(ctx, repo, pull) };
    }
    case 'merge_pull_request': {
      if (repoName === null) return missingArgument(name, 'repo');
      const pullNumber = asNumber(args.pull_number ?? args.pullNumber ?? args.number);
      if (pullNumber === null) return missingArgument(name, 'pull_number');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, value: null, message: `Repository "${owner}/${repoName}" not found.` };
      const pull = repo.pulls.get(pullNumber);
      if (!pull) return { ok: false, value: null, message: `Pull request #${pullNumber} not found.` };
      if (pull.state !== 'open' || pull.merged) {
        return { ok: false, value: null, message: `Pull request #${pullNumber} is not open.` };
      }
      const plan = planMerge(store, repo, pull);
      if (plan === null || plan.conflict) {
        return { ok: false, value: null, message: `Pull request #${pullNumber} has conflicts.` };
      }
      const sha = squashMerge(store, repo, pull);
      if (sha === null) {
        return { ok: false, value: null, message: `Pull request #${pullNumber} could not be merged.` };
      }
      return { ok: true, value: { ...pullView(ctx, repo, pull), sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    default:
      return { ok: false, value: null, message: `Unknown tool "${name}".` };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------

function resultEnvelope(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function errorEnvelope(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function normalizeToolName(name: string): string {
  let normalized = name.toLowerCase().replace(/^github__/, '');
  // Aliases the suite accepts: create_repository, repo_create, get_repository, issue_create,
  // issues_list, create_pr, merge_pr.
  const aliases: Record<string, string> = {
    create_repository: 'create_repo',
    repo_create: 'create_repo',
    get_repository: 'get_repo',
    issue_create: 'create_issue',
    issues_list: 'list_issues',
    create_pr: 'create_pull_request',
    merge_pr: 'merge_pull_request',
  };
  normalized = aliases[normalized] ?? normalized;
  return normalized;
}

function handleRpc(ctx: ForgeContext, request: JsonRpcRequest): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  const isNotification = request.id === undefined;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'server/discover') {
    return resultEnvelope(id, {
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: [MODERN_REVISION],
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN_REVISION,
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MODERN_REVISION;
    const version = requested === MODERN_REVISION || (LEGACY_REVISIONS as readonly string[]).includes(requested)
      ? requested
      : LEGACY_REVISIONS[0];
    return resultEnvelope(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: {
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
  }
  if (method === 'ping') {
    return resultEnvelope(id, {});
  }
  if (method === 'tools/list') {
    // The frozen list serialises identically on every call.
    return resultEnvelope(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const rawName = typeof params.name === 'string' ? params.name : '';
    const name = normalizeToolName(rawName);
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      return errorEnvelope(id, -32601, `Method not found: no tool named "${rawName}".`);
    }
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return resultEnvelope(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: `Missing required argument "${required}".` }) }],
          structuredContent: { error: `Missing required argument "${required}".` },
          isError: true,
        });
      }
    }
    const outcome = executeTool(ctx, name, args);
    if (!outcome.ok) {
      return resultEnvelope(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: outcome.message ?? 'The tool call failed.' }) }],
        structuredContent: { error: outcome.message ?? 'The tool call failed.' },
        isError: true,
      });
    }
    return resultEnvelope(id, {
      content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
      structuredContent: outcome.value,
    });
  }
  if (isNotification) return null;
  return errorEnvelope(id, -32601, `Method not found: "${method}".`);
}

/** Recover a JSON-RPC id from a truncated body, so the parse error can echo it. */
function recoverId(body: Buffer): unknown {
  const match = /"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")/.exec(body.toString('utf8', 0, Math.min(body.length, 4096)));
  if (!match) return null;
  const raw = match[1] as string;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return Number(raw);
}

export async function handleMcp(
  ctx: ForgeContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    // Legacy session teardown; the modern era has no sessions. Accept and move on.
    sendJson(res, ctx, 200, {});
    return;
  }
  if (method !== 'POST') {
    sendJson(res, ctx, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  if (!isAuthorized(req, ctx)) {
    sendJson(res, ctx, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, ctx, 400, errorEnvelope(recoverId(body), -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed)) {
    // A batch answers a batch; notifications inside it answer nothing.
    const responses: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) {
        responses.push(errorEnvelope(null, -32600, 'Invalid Request'));
        continue;
      }
      const response = handleRpc(ctx, entry as JsonRpcRequest);
      if (response !== null) responses.push(response);
    }
    sendJson(res, ctx, 200, responses);
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(res, ctx, 400, errorEnvelope(isRecord(parsed) ? (parsed as { id?: unknown }).id ?? null : null, -32600, 'Invalid Request'));
    return;
  }
  const response = handleRpc(ctx, parsed as JsonRpcRequest);
  if (response === null) {
    // A notification: no JSON-RPC reply, just an accepted status.
    sendJson(res, ctx, 200, {});
    return;
  }
  sendJson(res, ctx, 200, response);
}
