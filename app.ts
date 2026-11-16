// app.ts — the forge's HTTP server: one in-memory store, four surfaces (git smart HTTP,
// REST v3, GraphQL v4, MCP), and the env's /healthz probe. main.ts owns the lifecycle
// (bind, register, poll /done); this file owns every answer.
//
// Routing, in order:
//   GET  /healthz                                  the boot probe, no auth
//   GET  /api/v3[/]                                the API root (handled by handleRest)
//   *    /api/v3/...                               REST v3
//   POST /api/graphql                              GraphQL v4 (batching supported)
//   POST /mcp, DELETE /mcp                         MCP over Streamable HTTP
//   GET  /:owner/:repo.git/info/refs?service=...   git advertisement (v2 or v0)
//   POST /:owner/:repo.git/git-upload-pack         git fetch / ls-refs
//   POST /:owner/:repo.git/git-receive-pack        git push
//   *    anything else                             JSON 404, never HTML
//
// A handler that throws is a 500 JSON reply, never a dead process: the suite's
// repo-survives-errors check depends on the server staying up after bad input.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createContext, pathSegments, readBody, sendError, sendJson, type ForgeContext } from './http-util.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitInfoRefs, handleGitReceivePack, handleGitUploadPack } from './git-http.ts';
import type { Repo } from './store.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Match a git smart-HTTP path: /:owner/:repo.git/<tail>, where the tail is git-upload-pack,
 * git-receive-pack, or info/refs. Returns the repo (which may be undefined — the git handlers
 * answer 404 for a missing repo) and the tail.
 */
function gitRoute(
  ctx: ForgeContext,
  segments: string[],
): { repo: Repo | undefined; tail: string } | null {
  if (segments.length !== 3 && segments.length !== 4) return null;
  const owner = segments[0] as string;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return null;
  const repoName = repoSegment.slice(0, -'.git'.length);
  if (repoName === '' || owner === '') return null;
  if (segments.length === 4) {
    if (segments[2] !== 'info' || segments[3] !== 'refs') return null;
    return { repo: ctx.store.getRepo(owner, repoName), tail: 'info/refs' };
  }
  return { repo: ctx.store.getRepo(owner, repoName), tail: segments[2] as string };
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const ctx = createContext(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await route(ctx, req, res);
      } catch (err) {
        process.stderr.write(`[app] request ${req.method ?? '?'} ${req.url ?? '?'} failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) {
          sendError(res, ctx, 500, 'Internal Server Error');
        } else {
          res.destroy();
        }
      }
    })();
  });
}

async function route(ctx: ForgeContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const segments = pathSegments(path);

  // The env's boot check calls this twice: 200 {"ok":true}. No token needed.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, ctx, 200, { ok: true });
    return;
  }

  // GraphQL v4.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    const body = await readBody(req);
    if (body === null) {
      sendError(res, ctx, 413, 'Request Entity Too Large');
      return;
    }
    await handleGraphQL(ctx, req, res, body);
    return;
  }

  // MCP over Streamable HTTP.
  if (segments.length === 1 && segments[0] === 'mcp') {
    const body = await readBody(req);
    if (body === null) {
      sendError(res, ctx, 413, 'Request Entity Too Large');
      return;
    }
    await handleMcp(ctx, req, res, body);
    return;
  }

  // REST v3: /api/v3[/...]. The root answers without a token; handleRest enforces the rest.
  // GETs carry no body, so they skip the read entirely (the read workload is 2,000 of them).
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    if (body === null) {
      sendError(res, ctx, 413, 'Request Entity Too Large');
      return;
    }
    await handleRest(ctx, req, res, segments.slice(2), queryOf(req), body);
    return;
  }

  // Git smart HTTP: /:owner/:repo.git/info/refs | git-upload-pack | git-receive-pack.
  const git = gitRoute(ctx, segments);
  if (git !== null) {
    if (method === 'GET' && git.tail === 'info/refs') {
      handleGitInfoRefs(ctx, req, res, git.repo, queryOf(req).get('service'));
      return;
    }
    if (method === 'POST' && git.tail === 'git-upload-pack') {
      const body = await readBody(req);
      if (body === null) {
        sendError(res, ctx, 413, 'Request Entity Too Large');
        return;
      }
      handleGitUploadPack(ctx, req, res, git.repo, body);
      return;
    }
    if (method === 'POST' && git.tail === 'git-receive-pack') {
      const body = await readBody(req);
      if (body === null) {
        sendError(res, ctx, 413, 'Request Entity Too Large');
        return;
      }
      handleGitReceivePack(ctx, req, res, git.repo, body);
      return;
    }
  }

  // Everything else, every method: GitHub's 404 body. Unauthenticated callers get the same
  // JSON 404 (the protocol checks require a JSON body with a message on unknown routes).
  sendError(res, ctx, 404, 'Not Found');
}
