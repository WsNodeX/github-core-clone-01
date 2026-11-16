// The request context every surface handler receives: the store, the decoded request and
// the response helpers. http.ts builds one per request; rest.ts, graphql.ts and mcp.ts
// consume it. JSON replies always carry application/json and a request id.

import type { Store } from './store.ts';

export class BadJsonError extends Error {
  constructor() {
    super('request body is not valid JSON');
    this.name = 'BadJsonError';
  }
}

export interface Ctx {
  store: Store;
  method: string;
  /** Decoded path segments, e.g. ['api', 'v3', 'repos', 'octo', 'demo']. */
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  /** The request's own origin (http://host), for absolute pagination links. */
  origin: string;
  /** Parse the request body as JSON; throws BadJsonError when it is not. */
  json(): unknown;
  respond(status: number, contentType: string, body: string | Buffer, headers?: Record<string, string>): void;
  jsonBody(status: number, value: unknown, headers?: Record<string, string>): void;
  /** A GitHub-shaped error body: {message}. */
  error(status: number, message: string): void;
}
