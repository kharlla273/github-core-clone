// http-util.ts — the small shared HTTP plumbing: JSON replies, the request-id header every REST
// reply carries, auth, pagination and Link headers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';

export interface ForgeContext {
  readonly store: Store;
  /** The bearer token the suite presents (MAKEFUN_SHOP_TOKEN); empty means no auth is enforced. */
  readonly token: string;
  nextRequestId(): string;
}

export function createContext(token: string): ForgeContext {
  let counter = 0;
  return {
    store: new Store(),
    token,
    nextRequestId(): string {
      counter += 1;
      return `req-${counter.toString(16).padStart(8, '0')}`;
    },
  };
}

/** True when the request carries the suite's bearer token (or no token is configured). */
export function isAuthorized(req: IncomingMessage, ctx: ForgeContext): boolean {
  if (ctx.token === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${ctx.token}`;
}

/** Send a JSON body with the headers every REST reply carries. */
export function sendJson(
  res: ServerResponse,
  ctx: ForgeContext,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': ctx.nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/** Send a JSON error body: {message} (a string, as the protocol checks require). */
export function sendError(res: ServerResponse, ctx: ForgeContext, status: number, message: string): void {
  sendJson(res, ctx, status, { message });
}

/** Send a binary body (git smart-HTTP) with the request-id header every reply carries. */
export function sendRaw(
  res: ServerResponse,
  ctx: ForgeContext,
  status: number,
  contentType: string,
  body: Buffer,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': ctx.nextRequestId(),
    'content-length': body.length,
  });
  res.end(body);
}

/** Read a request body fully (up to `maxBytes`); null when it overruns the cap. */
export async function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON body; returns { ok: false } on malformed JSON (the caller answers 400). */
export function parseJsonBody(
  body: Buffer,
): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

export interface PageParams {
  readonly page: number;
  readonly perPage: number;
}

/** Parse ?page=&per_page= the way GitHub does (defaults 1 and 30, per_page clamped to 1..100). */
export function pageParams(query: URLSearchParams): PageParams {
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  return { page, perPage };
}

/** Slice one page out of a list. */
export function paginate<T>(items: readonly T[], params: PageParams): T[] {
  const start = (params.page - 1) * params.perPage;
  return items.slice(start, start + params.perPage);
}

/**
 * A GitHub-style Link header for a paginated list: first/prev/next/last, absolute URLs on the
 * request's own host, rel="next" present only while another page follows.
 */
export function linkHeader(
  req: IncomingMessage,
  path: string,
  query: URLSearchParams,
  params: PageParams,
  total: number,
): string | null {
  const totalPages = Math.max(1, Math.ceil(total / params.perPage));
  if (totalPages <= 1) return null;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${path}`;
  const link = (page: number, rel: string): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(page));
    q.set('per_page', String(params.perPage));
    return `<${base}?${q.toString()}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (params.page < totalPages) parts.push(link(params.page + 1, 'next'));
  if (params.page > 1) parts.push(link(params.page - 1, 'prev'));
  parts.push(link(1, 'first'));
  parts.push(link(totalPages, 'last'));
  return parts.join(', ');
}

/** The request's path segments, percent-decoded one by one (a branch `release/1.0` stays one segment). */
export function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
