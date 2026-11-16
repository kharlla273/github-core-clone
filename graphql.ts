// graphql.ts — a small GraphQL v4 executor for the documents gh and github-mcp-server send:
// a lexer + recursive-descent parser, a schema validator (an unknown field is a 200 with an
// errors array naming it, never an HTTP 400), and resolvers over the same store the REST
// surface uses. Supports operation batching (an array body answers an array, in order).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  decodeGlobalId,
  planMerge,
  pullRequestFiles,
  squashMerge,
  trialNowIso,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { VIEWER } from './scenario.ts';
import { isAuthorized, isRecord, parseJsonBody, sendError, sendJson, type ForgeContext } from './http-util.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

interface Token {
  readonly kind: 'name' | 'int' | 'float' | 'string' | 'punct';
  readonly value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string): boolean => /[0-9]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // Block strings (""") and regular strings with escapes.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escape = source[j + 1] as string;
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escape === 'u' && j + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += escapes[escape] ?? escape;
            j += 2;
          }
        } else {
          value += source[j] as string;
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || isDigit(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && isDigit(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && isDigit(source[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < source.length && isDigit(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && isDigit(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: string }
  | { readonly kind: 'float'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyArray<{ readonly name: string; readonly value: ValueNode }> };

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyArray<{ readonly name: string; readonly value: ValueNode }>;
  readonly selectionSet: SelectionNode[] | null;
}

interface InlineFragmentNode {
  readonly kind: 'inline-fragment';
  readonly typeCondition: string | null;
  readonly selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | InlineFragmentNode;

interface VariableDefinition {
  readonly name: string;
  readonly type: string;
  readonly defaultValue: ValueNode | null;
}

interface OperationNode {
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly variableDefinitions: readonly VariableDefinition[];
  readonly selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}", got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}", got "${token.value}"`);
    return token.value;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('the document holds no operation');
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value;
    }
    const variableDefinitions = this.parseVariableDefinitions();
    const selectionSet = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selectionSet };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const definitions: VariableDefinition[] = [];
    if (!this.matchPunct('(')) return definitions;
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue();
      definitions.push({ name, type, defaultValue });
    }
    return definitions;
  }

  private parseType(): string {
    let type: string;
    if (this.matchPunct('[')) {
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.matchPunct('!')) type += '!';
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'inline-fragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!this.matchPunct('(')) return args;
    while (!this.matchPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      this.parseArguments();
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// schema (field names per type, for validation and introspection)
// ---------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'private', 'isPrivate', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'id', 'target'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt',
    'closedAt', 'labels', 'comments', 'repository', 'url',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'author',
    'repository', 'url',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'actor', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
});

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
});

/** The type a field's selection set resolves against (for nested validation). */
function fieldReturnType(parentType: string, fieldName: string): string | null {
  const map: Readonly<Record<string, string>> = {
    'Query.viewer': 'User',
    'Query.repository': 'Repository',
    'Query.node': 'Node',
    'Query.__type': '__Type',
    'Repository.owner': 'User',
    'Repository.defaultBranchRef': 'Ref',
    'Repository.issue': 'Issue',
    'Repository.issues': 'IssueConnection',
    'Repository.pullRequest': 'PullRequest',
    'Repository.pullRequests': 'PullRequestConnection',
    'Issue.author': 'User',
    'Issue.labels': 'LabelConnection',
    'Issue.comments': 'IssueCommentConnection',
    'Issue.repository': 'Repository',
    'IssueConnection.nodes': 'Issue',
    'IssueConnection.edges': 'IssueEdge',
    'IssueConnection.pageInfo': 'PageInfo',
    'IssueEdge.node': 'Issue',
    'PullRequest.author': 'User',
    'PullRequest.headRef': 'Ref',
    'PullRequest.baseRef': 'Ref',
    'PullRequest.files': 'PullRequestFileConnection',
    'PullRequest.repository': 'Repository',
    'PullRequestConnection.nodes': 'PullRequest',
    'PullRequestConnection.edges': 'PullRequestEdge',
    'PullRequestConnection.pageInfo': 'PageInfo',
    'PullRequestEdge.node': 'PullRequest',
    'PullRequestFileConnection.nodes': 'PullRequestChangedFile',
    'PullRequestFileConnection.pageInfo': 'PageInfo',
    'Mutation.createIssue': 'CreateIssuePayload',
    'Mutation.closeIssue': 'CloseIssuePayload',
    'Mutation.createPullRequest': 'CreatePullRequestPayload',
    'Mutation.mergePullRequest': 'MergePullRequestPayload',
    'Mutation.addComment': 'AddCommentPayload',
    'CreateIssuePayload.issue': 'Issue',
    'CloseIssuePayload.issue': 'Issue',
    'CreatePullRequestPayload.pullRequest': 'PullRequest',
    'MergePullRequestPayload.pullRequest': 'PullRequest',
    'AddCommentPayload.commentEdge': 'CommentEdge',
    'AddCommentPayload.subject': 'Issue',
    'CommentEdge.node': 'IssueComment',
    'IssueComment.author': 'User',
    '__Type.fields': '__Field',
    '__Type.enumValues': '__EnumValue',
  };
  return map[`${parentType}.${fieldName}`] ?? null;
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

function valueFromNode(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueFromNode(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

function argsFromNode(
  field: FieldNode,
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = valueFromNode(arg.value, variables);
  return args;
}

// ---------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------

function validateSelections(
  selections: readonly SelectionNode[],
  parentType: string,
  errors: string[],
): void {
  const fields = SCHEMA_FIELDS[parentType];
  for (const selection of selections) {
    if (selection.kind === 'inline-fragment') {
      const type = selection.typeCondition ?? parentType;
      validateSelections(selection.selectionSet, type, errors);
      continue;
    }
    const name = selection.name;
    if (name === '__typename') continue;
    if (fields === undefined || !fields.includes(name)) {
      errors.push(`Cannot query field "${name}" on type "${parentType}".`);
      continue;
    }
    if (selection.selectionSet !== null) {
      const childType = fieldReturnType(parentType, name);
      if (childType !== null && childType !== 'Node') {
        validateSelections(selection.selectionSet, childType, errors);
      } else if (childType === 'Node') {
        // node(id:) resolves to a concrete type at runtime; fragments carry the fields.
        for (const child of selection.selectionSet) {
          if (child.kind === 'inline-fragment' && child.typeCondition !== null) {
            validateSelections(child.selectionSet, child.typeCondition, errors);
          } else if (child.kind === 'field' && child.name !== '__typename' && child.name !== 'id') {
            errors.push(`Cannot query field "${child.name}" on type "Node".`);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface TypedValue {
  readonly __typename: string;
  readonly value: unknown;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

class Executor {
  private readonly ctx: ForgeContext;
  private readonly variables: Readonly<Record<string, unknown>>;
  private readonly errors: Array<{ message: string }> = [];

  constructor(ctx: ForgeContext, variables: Readonly<Record<string, unknown>>) {
    this.ctx = ctx;
    this.variables = variables;
  }

  getErrors(): Array<{ message: string }> {
    return this.errors;
  }

  executeOperation(operation: OperationNode): Record<string, unknown> {
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data: Record<string, unknown> = {};
    this.executeSelections(operation.selectionSet, rootType, { __typename: rootType, value: null }, data);
    return data;
  }

  private executeSelections(
    selections: readonly SelectionNode[],
    parentType: string,
    parent: TypedValue,
    out: Record<string, unknown>,
  ): void {
    for (const selection of selections) {
      if (selection.kind === 'inline-fragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
        this.executeSelections(selection.selectionSet, parent.__typename, parent, out);
        continue;
      }
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = parent.__typename;
        continue;
      }
      const args = argsFromNode(selection, this.variables);
      const resolved = this.resolveField(parent.__typename, parent.value, selection.name, args, selection);
      out[key] = this.completeValue(resolved, selection);
    }
  }

  private completeValue(resolved: TypedValue | unknown, field: FieldNode): unknown {
    if (resolved === null || resolved === undefined) return null;
    if (typeof resolved !== 'object' || !('__typename' in (resolved as Record<string, unknown>))) {
      return resolved as unknown;
    }
    const typed = resolved as TypedValue;
    if (field.selectionSet === null) return typed.value;
    if (Array.isArray(typed.value)) {
      return typed.value.map((item) => {
        if (item === null || typeof item !== 'object' || !('__typename' in (item as Record<string, unknown>))) return item;
        const child: Record<string, unknown> = {};
        this.executeSelections(field.selectionSet as SelectionNode[], (item as TypedValue).__typename, item as TypedValue, child);
        return child;
      });
    }
    const child: Record<string, unknown> = {};
    this.executeSelections(field.selectionSet, typed.__typename, typed, child);
    return child;
  }

  private resolveField(
    parentType: string,
    parentValue: unknown,
    fieldName: string,
    args: Record<string, unknown>,
    field: FieldNode,
  ): TypedValue | unknown {
    const store = this.ctx.store;
    // -- Query ------------------------------------------------------------------
    if (parentType === 'Query') {
      if (fieldName === 'viewer') return { __typename: 'User', value: VIEWER };
      if (fieldName === 'repository') {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        if (typeof owner !== 'string' || typeof name !== 'string') {
          this.errors.push({ message: 'Field "repository" requires arguments "owner" and "name".' });
          return null;
        }
        const repo = owner === VIEWER.login ? store.getRepo(owner, name) : undefined;
        return repo ? { __typename: 'Repository', value: repo } : null;
      }
      if (fieldName === 'node') {
        const id = args.id as string | undefined;
        if (typeof id !== 'string') return null;
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = store.getRepoById(decoded.id);
          return repo ? { __typename: 'Repository', value: repo } : null;
        }
        if (decoded.kind === 'Issue') {
          const found = store.getIssueById(decoded.id);
          return found ? { __typename: 'Issue', value: { issue: found.issue, repo: found.repo } } : null;
        }
        if (decoded.kind === 'PullRequest') {
          const found = store.getPullById(decoded.id);
          return found ? { __typename: 'PullRequest', value: { pull: found.pull, repo: found.repo } } : null;
        }
        return null;
      }
      if (fieldName === '__type') {
        const name = args.name as string | undefined;
        if (typeof name !== 'string') return null;
        if (SCHEMA_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
        return { __typename: '__Type', value: name };
      }
      return null;
    }
    // -- Mutation ----------------------------------------------------------------
    if (parentType === 'Mutation') {
      return this.resolveMutation(fieldName, args);
    }
    // -- __Type (introspection) ---------------------------------------------------
    if (parentType === '__Type') {
      const typeName = parentValue as string;
      if (fieldName === 'name') return typeName;
      if (fieldName === 'kind') return SCHEMA_FIELDS[typeName] !== undefined ? 'OBJECT' : 'ENUM';
      if (fieldName === 'fields') {
        const fields = SCHEMA_FIELDS[typeName] ?? [];
        return {
          __typename: '__Field',
          value: fields.map((name) => ({ __typename: '__Field', value: { name } })),
        };
      }
      if (fieldName === 'enumValues') {
        const values = ENUM_VALUES[typeName] ?? [];
        return {
          __typename: '__EnumValue',
          value: values.map((name) => ({ __typename: '__EnumValue', value: { name } })),
        };
      }
      return null;
    }
    if (parentType === '__Field' || parentType === '__EnumValue') {
      if (fieldName === 'name') return (parentValue as { name: string }).name;
      if (fieldName === 'description') return null;
      return null;
    }
    // -- User ----------------------------------------------------------------------
    if (parentType === 'User') {
      const user = parentValue as typeof VIEWER;
      if (fieldName === 'login') return user.login;
      if (fieldName === 'name') return user.name;
      if (fieldName === 'email') return user.email;
      if (fieldName === 'id') return Buffer.from(`User:${user.id}`, 'utf8').toString('base64url');
      if (fieldName === 'url') return '';
      if (fieldName === 'avatarUrl') return '';
      return null;
    }
    // -- Repository ------------------------------------------------------------------
    if (parentType === 'Repository') {
      const repo = parentValue as Repo;
      switch (fieldName) {
        case 'id':
          return store.repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { __typename: 'User', value: VIEWER };
        case 'defaultBranchRef':
          return { __typename: 'Ref', value: { name: repo.defaultBranch } };
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'private':
        case 'isPrivate':
          return repo.private;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'url':
          return '';
        case 'issue': {
          const number = args.number as number | undefined;
          if (typeof number !== 'number') return null;
          const issue = repo.issues.get(number);
          return issue ? { __typename: 'Issue', value: { issue, repo } } : null;
        }
        case 'issues':
          return this.issueConnection(repo, args);
        case 'pullRequest': {
          const number = args.number as number | undefined;
          if (typeof number !== 'number') return null;
          const pull = repo.pulls.get(number);
          return pull ? { __typename: 'PullRequest', value: { pull, repo } } : null;
        }
        case 'pullRequests':
          return this.pullConnection(repo, args);
        default:
          return null;
      }
    }
    // -- Ref -------------------------------------------------------------------------
    if (parentType === 'Ref') {
      if (fieldName === 'name') return (parentValue as { name: string }).name;
      if (fieldName === 'id') return Buffer.from(`Ref:${(parentValue as { name: string }).name}`, 'utf8').toString('base64url');
      return null;
    }
    // -- Issue -------------------------------------------------------------------------
    if (parentType === 'Issue') {
      const { issue, repo } = parentValue as { issue: Issue; repo: Repo };
      switch (fieldName) {
        case 'id':
          return store.issueGlobalId(issue);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'author':
          return { __typename: 'User', value: VIEWER };
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.closedAt;
        case 'repository':
          return { __typename: 'Repository', value: repo };
        case 'url':
          return '';
        case 'labels':
          return {
            __typename: 'LabelConnection',
            value: { nodes: issue.labels, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } },
          };
        case 'comments':
          return {
            __typename: 'IssueCommentConnection',
            value: { nodes: issue.comments, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } },
          };
        default:
          return null;
      }
    }
    // -- IssueConnection / PullRequestConnection / files -------------------------------
    if (
      parentType === 'IssueConnection' ||
      parentType === 'PullRequestConnection' ||
      parentType === 'PullRequestFileConnection' ||
      parentType === 'LabelConnection' ||
      parentType === 'IssueCommentConnection'
    ) {
      const connection = parentValue as { nodes: unknown[]; pageInfo: Record<string, unknown>; totalCount?: number };
      if (fieldName === 'nodes') {
        const itemType =
          parentType === 'IssueConnection'
            ? 'Issue'
            : parentType === 'PullRequestConnection'
              ? 'PullRequest'
              : parentType === 'PullRequestFileConnection'
                ? 'PullRequestChangedFile'
                : parentType === 'LabelConnection'
                  ? 'Label'
                  : 'IssueComment';
        return {
          __typename: itemType,
          value: connection.nodes.map((node) => ({ __typename: itemType, value: node })),
        };
      }
      if (fieldName === 'edges') {
        return { __typename: 'Edge', value: [] };
      }
      if (fieldName === 'pageInfo') return { __typename: 'PageInfo', value: connection.pageInfo };
      if (fieldName === 'totalCount') return connection.totalCount ?? connection.nodes.length;
      return null;
    }
    if (parentType === 'PageInfo') {
      const info = parentValue as Record<string, unknown>;
      return info[fieldName] ?? null;
    }
    // -- PullRequest ---------------------------------------------------------------------
    if (parentType === 'PullRequest') {
      const { pull, repo } = parentValue as { pull: PullRequest; repo: Repo };
      switch (fieldName) {
        case 'id':
          return store.pullGlobalId(pull);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          const plan = planMerge(store, repo, pull);
          return plan !== null && !plan.conflict ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRef':
          return { __typename: 'Ref', value: { name: pull.headRef } };
        case 'baseRef':
          return { __typename: 'Ref', value: { name: pull.baseRef } };
        case 'author':
          return { __typename: 'User', value: VIEWER };
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'mergedAt':
          return pull.mergedAt;
        case 'repository':
          return { __typename: 'Repository', value: repo };
        case 'url':
          return '';
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const files = pullRequestFiles(store, repo, pull).slice(0, Math.max(0, first));
          return {
            __typename: 'PullRequestFileConnection',
            value: {
              nodes: files.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() })),
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
              totalCount: files.length,
            },
          };
        }
        default:
          return null;
      }
    }
    if (parentType === 'PullRequestChangedFile') {
      const file = parentValue as Record<string, unknown>;
      return file[fieldName] ?? null;
    }
    if (parentType === 'Label') {
      const label = parentValue as { id: number; name: string; color: string };
      if (fieldName === 'id') return Buffer.from(`Label:${label.id}`, 'utf8').toString('base64url');
      if (fieldName === 'name') return label.name;
      if (fieldName === 'color') return label.color;
      if (fieldName === 'description') return '';
      return null;
    }
    // -- payloads --------------------------------------------------------------------------
    if (
      parentType === 'CreateIssuePayload' ||
      parentType === 'CloseIssuePayload' ||
      parentType === 'CreatePullRequestPayload' ||
      parentType === 'MergePullRequestPayload' ||
      parentType === 'AddCommentPayload'
    ) {
      const payload = parentValue as Record<string, unknown>;
      const value = payload[fieldName];
      if (value === undefined) return null;
      if (fieldName === 'issue' && isRecord(value) && 'issue' in value) {
        return { __typename: 'Issue', value };
      }
      if (fieldName === 'pullRequest' && isRecord(value) && 'pull' in value) {
        return { __typename: 'PullRequest', value };
      }
      if (fieldName === 'commentEdge') {
        return { __typename: 'CommentEdge', value };
      }
      return value as TypedValue | unknown;
    }
    if (parentType === 'CommentEdge') {
      if (fieldName === 'node') {
        const node = (parentValue as { node: unknown }).node;
        return { __typename: 'IssueComment', value: node };
      }
      if (fieldName === 'cursor') return null;
      return null;
    }
    if (parentType === 'IssueComment') {
      const comment = parentValue as { id: number; body: string; createdAt: string; updatedAt: string };
      if (fieldName === 'id') return Buffer.from(`IssueComment:${comment.id}`, 'utf8').toString('base64url');
      if (fieldName === 'databaseId') return comment.id;
      if (fieldName === 'body') return comment.body;
      if (fieldName === 'author') return { __typename: 'User', value: VIEWER };
      if (fieldName === 'createdAt') return comment.createdAt;
      if (fieldName === 'updatedAt') return comment.updatedAt;
      if (fieldName === 'url') return '';
      return null;
    }
    return null;
  }

  private issueConnection(repo: Repo, args: Record<string, unknown>): TypedValue {
    let issues = [...repo.issues.values()];
    const states = args.states as string[] | undefined;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state).toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
    const direction = orderBy !== null && orderBy.direction === 'ASC' ? 'asc' : 'desc';
    const field = orderBy !== null && typeof orderBy.field === 'string' ? orderBy.field : null;
    if (field === 'CREATED_AT' || field === null) {
      // Default order is creation order ascending; an explicit CREATED_AT order honours direction.
      if (field === 'CREATED_AT') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      } else {
        issues.sort((a, b) => a.createdSeq - b.createdSeq);
      }
    }
    const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
    if (after !== null) {
      const index = issues.findIndex((issue) => issue.number === after);
      if (index >= 0) issues = issues.slice(index + 1);
    }
    const first = typeof args.first === 'number' ? Math.max(0, args.first) : issues.length;
    const page = issues.slice(0, first);
    const hasNextPage = issues.length > first;
    const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
    return {
      __typename: 'IssueConnection',
      value: {
        nodes: page.map((issue) => ({ issue, repo })),
        pageInfo: { hasNextPage, hasPreviousPage: false, startCursor: page.length > 0 ? encodeCursor((page[0] as Issue).number) : null, endCursor },
        totalCount: issues.length,
      },
    };
  }

  private pullConnection(repo: Repo, args: Record<string, unknown>): TypedValue {
    let pulls = [...repo.pulls.values()];
    const states = args.states as string[] | undefined;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state)));
      pulls = pulls.filter((pull) => {
        const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        return wanted.has(state);
      });
    } else {
      pulls = pulls.filter((pull) => pull.state === 'open');
    }
    pulls.sort((a, b) => b.createdSeq - a.createdSeq);
    const first = typeof args.first === 'number' ? Math.max(0, args.first) : pulls.length;
    const page = pulls.slice(0, first);
    return {
      __typename: 'PullRequestConnection',
      value: {
        nodes: page.map((pull) => ({ pull, repo })),
        pageInfo: { hasNextPage: pulls.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: pulls.length,
      },
    };
  }

  private resolveMutation(fieldName: string, args: Record<string, unknown>): TypedValue | unknown {
    const store = this.ctx.store;
    const input = isRecord(args.input) ? args.input : {};
    if (fieldName === 'createIssue') {
      const repositoryId = input.repositoryId as string | undefined;
      const title = input.title as string | undefined;
      const decoded = typeof repositoryId === 'string' ? decodeGlobalId(repositoryId) : null;
      const repo = decoded?.kind === 'Repository' ? store.getRepoById(decoded.id) : undefined;
      if (!repo || typeof title !== 'string' || title === '') {
        this.errors.push({ message: 'createIssue: the repository or title is invalid.' });
        return { __typename: 'CreateIssuePayload', value: { issue: null } };
      }
      const issue = store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
      return { __typename: 'CreateIssuePayload', value: { issue: { issue, repo } } };
    }
    if (fieldName === 'closeIssue') {
      const issueId = input.issueId as string | undefined;
      const decoded = typeof issueId === 'string' ? decodeGlobalId(issueId) : null;
      const found = decoded?.kind === 'Issue' ? store.getIssueById(decoded.id) : null;
      if (!found) {
        this.errors.push({ message: 'closeIssue: the issue does not exist.' });
        return { __typename: 'CloseIssuePayload', value: { issue: null } };
      }
      found.issue.state = 'closed';
      found.issue.closedAt = trialNowIso();
      found.issue.updatedAt = trialNowIso();
      return { __typename: 'CloseIssuePayload', value: { issue: { issue: found.issue, repo: found.repo } } };
    }
    if (fieldName === 'createPullRequest') {
      const repositoryId = input.repositoryId as string | undefined;
      const decoded = typeof repositoryId === 'string' ? decodeGlobalId(repositoryId) : null;
      const repo = decoded?.kind === 'Repository' ? store.getRepoById(decoded.id) : undefined;
      const headRefName = input.headRefName as string | undefined;
      const baseRefName = input.baseRefName as string | undefined;
      const title = input.title as string | undefined;
      if (!repo || typeof headRefName !== 'string' || typeof baseRefName !== 'string' || typeof title !== 'string') {
        this.errors.push({ message: 'createPullRequest: the repository, head, base or title is invalid.' });
        return { __typename: 'CreatePullRequestPayload', value: { pullRequest: null } };
      }
      if (store.branchTip(repo, headRefName) === undefined || store.branchTip(repo, baseRefName) === undefined) {
        this.errors.push({ message: 'createPullRequest: the head or base branch does not exist.' });
        return { __typename: 'CreatePullRequestPayload', value: { pullRequest: null } };
      }
      if (store.openPullForBranches(repo, headRefName, baseRefName) !== undefined) {
        this.errors.push({ message: 'createPullRequest: a pull request already exists for this head and base.' });
        return { __typename: 'CreatePullRequestPayload', value: { pullRequest: null } };
      }
      const pull = store.createPullRequest(repo, title, typeof input.body === 'string' ? input.body : '', headRefName, baseRefName);
      return { __typename: 'CreatePullRequestPayload', value: { pullRequest: { pull, repo } } };
    }
    if (fieldName === 'mergePullRequest') {
      const pullRequestId = input.pullRequestId as string | undefined;
      const decoded = typeof pullRequestId === 'string' ? decodeGlobalId(pullRequestId) : null;
      const found = decoded?.kind === 'PullRequest' ? store.getPullById(decoded.id) : null;
      if (!found) {
        this.errors.push({ message: 'mergePullRequest: the pull request does not exist.' });
        return { __typename: 'MergePullRequestPayload', value: { pullRequest: null } };
      }
      if (found.pull.merged || found.pull.state !== 'open') {
        this.errors.push({ message: 'mergePullRequest: the pull request is not open.' });
        return { __typename: 'MergePullRequestPayload', value: { pullRequest: { pull: found.pull, repo: found.repo } } };
      }
      const sha = squashMerge(store, found.repo, found.pull);
      if (sha === null) {
        this.errors.push({ message: 'mergePullRequest: the pull request has conflicts.' });
        return { __typename: 'MergePullRequestPayload', value: { pullRequest: { pull: found.pull, repo: found.repo } } };
      }
      return { __typename: 'MergePullRequestPayload', value: { pullRequest: { pull: found.pull, repo: found.repo } } };
    }
    if (fieldName === 'addComment') {
      const subjectId = input.subjectId as string | undefined;
      const bodyText = input.body as string | undefined;
      const decoded = typeof subjectId === 'string' ? decodeGlobalId(subjectId) : null;
      const found = decoded?.kind === 'Issue' ? store.getIssueById(decoded.id) : null;
      if (!found || typeof bodyText !== 'string' || bodyText === '') {
        this.errors.push({ message: 'addComment: the subject or body is invalid.' });
        return { __typename: 'AddCommentPayload', value: { commentEdge: null } };
      }
      const comment = store.addComment(found.repo, found.issue, bodyText);
      return { __typename: 'AddCommentPayload', value: { commentEdge: { node: comment } } };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// the HTTP handler
// ---------------------------------------------------------------------------------------------

interface GraphQLOperationInput {
  readonly query?: unknown;
  readonly variables?: unknown;
  readonly operationName?: unknown;
}

function runOperation(
  ctx: ForgeContext,
  input: GraphQLOperationInput,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  if (typeof input.query !== 'string' || input.query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = isRecord(input.variables) ? input.variables : {};
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(input.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Syntax Error: ${(err as Error).message}` }] };
  }
  let operation = operations[0] as OperationNode;
  if (typeof input.operationName === 'string') {
    const named = operations.find((candidate) => candidate.name === input.operationName);
    if (named) operation = named;
  }
  // Variable defaults fill in values the caller did not send.
  const filled: Record<string, unknown> = { ...variables };
  for (const definition of operation.variableDefinitions) {
    if (filled[definition.name] === undefined && definition.defaultValue !== null) {
      filled[definition.name] = valueFromNode(definition.defaultValue, variables);
    }
  }
  const errors: string[] = [];
  validateSelections(
    operation.selectionSet,
    operation.operation === 'mutation' ? 'Mutation' : 'Query',
    errors,
  );
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const executor = new Executor(ctx, filled);
  const data = executor.executeOperation(operation);
  const executionErrors = executor.getErrors();
  if (executionErrors.length > 0) {
    return { data, errors: executionErrors };
  }
  return { data };
}

export async function handleGraphQL(
  ctx: ForgeContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, ctx, 404, 'Not Found');
    return;
  }
  if (!isAuthorized(req, ctx)) {
    sendError(res, ctx, 401, 'Bad credentials');
    return;
  }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed.value)) {
    const responses = parsed.value.map((entry) => {
      if (!isRecord(entry)) return { data: null, errors: [{ message: 'Must provide query string.' }] };
      return runOperation(ctx, entry as GraphQLOperationInput);
    });
    sendJson(res, ctx, 200, responses);
    return;
  }
  if (!isRecord(parsed.value)) {
    sendJson(res, ctx, 400, { errors: [{ message: 'Must provide query string.' }] });
    return;
  }
  sendJson(res, ctx, 200, runOperation(ctx, parsed.value as GraphQLOperationInput));
}
