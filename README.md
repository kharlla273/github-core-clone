# GitHub Core Clone — a GitHub-compatible git forge

A dependency-free, in-memory GitHub-compatible forge in TypeScript (Node ≥ 22.18).
It speaks the four surfaces the contest grades, all backed by one store:

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch`) and v0 (fetch), plus v0
  `receive-pack` with fast-forward checks and per-ref `report-status`. Packs are
  delta-free and checksummed; shallow clones, deepen and unshallow are supported.
- **REST v3** — repos, refs, branches, commits, contents (create/update/delete),
  labels, issues, comments and pull requests (create, files, squash merge),
  with GitHub-style pagination (`Link` headers) and JSON errors everywhere.
- **GraphQL v4** — `viewer`, `repository`, `node(id:)` with inline fragments,
  issue/PR connections with cursor pagination, the five mutations
  (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`), `__type` introspection, and operation batching. An unknown
  field is an HTTP 200 with an `errors` array naming it.
- **MCP over Streamable HTTP** — the modern 2026-07-28 era (`server/discover`,
  no handshake) plus the legacy `initialize` handshake, with six tools:
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry↔env lifecycle from the starter (bind an ephemeral port,
`POST $MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done`, exit 0) and is
kept as it ships. The server itself lives in `app.ts`.

Environment:

| Variable | Meaning |
| --- | --- |
| `MAKEFUN_ENV_URL` | The env origin to register with (required by `main.ts`). |
| `MAKEFUN_SHOP_TOKEN` | The bearer token the suite presents; empty means no auth is enforced. |
| `MAKEFUN_TRIAL_NOW` | The trial clock (epoch seconds or ISO); all timestamps come from it, never the wall clock. |

## Layout

| File | What it holds |
| --- | --- |
| `app.ts` | The HTTP server and router. |
| `main.ts` | The entry↔env lifecycle (starter, unchanged). |
| `scenario.ts` | The suite's seeded scenario (viewer `adaiversen`, teammates, repos). |
| `store.ts` | The in-memory store: repos, objects, refs, issues, PRs, labels. |
| `gitobj.ts` | Git objects, packs (read/write, deltas), pkt-lines, fetch selection. |
| `git-http.ts` | Smart HTTP: info/refs, upload-pack (v2 + v0), receive-pack (v0). |
| `rest.ts` | REST v3. |
| `graphql.ts` | GraphQL v4: lexer, parser, validator, executor. |
| `mcp.ts` | MCP tools and JSON-RPC plumbing. |
| `http-util.ts` | Shared HTTP plumbing (JSON replies, auth, pagination). |

Determinism: every timestamp comes from `MAKEFUN_TRIAL_NOW` (default
2025-01-01T00:00:00Z), ids and request ids are monotonic counters, and packs
are written in oid order — replaying a trial leaves the same state.
