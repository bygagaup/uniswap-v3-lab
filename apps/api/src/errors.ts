/**
 * One error shape, always. Never `200` on failure.
 *
 * THE LOAD-BEARING RULE: the Graph gateway answers `200 OK` with
 * `{errors: [...]}` for a dead or unsynced subgraph. That is UPSTREAM_GRAPHQL,
 * a 502 — not empty data. Conflating the two turns a broken deployment into an
 * eternal spinner, which is exactly how the predecessor's predecessor failed.
 * `{data: {pools: []}}` is a *successful* empty result and must stay distinct.
 */
export type ApiErrorCode =
  | 'UNKNOWN_CHAIN'
  | 'UNKNOWN_OP'
  | 'BAD_VARIABLES'
  | 'NOT_CONFIGURED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_HTTP'
  | 'UPSTREAM_GRAPHQL'
  | 'UPSTREAM_MALFORMED'
  | 'MISCONFIGURED';

const STATUS: Record<ApiErrorCode, number> = {
  UNKNOWN_CHAIN: 400,
  UNKNOWN_OP: 400,
  BAD_VARIABLES: 400,
  RATE_LIMITED: 429,
  MISCONFIGURED: 500,
  UPSTREAM_HTTP: 502,
  UPSTREAM_GRAPHQL: 502,
  UPSTREAM_MALFORMED: 502,
  NOT_CONFIGURED: 503,
  UPSTREAM_TIMEOUT: 504,
};

/**
 * Whether trying again could plausibly work. The client's retry predicate reads
 * this rather than guessing from the status code — the gateway's intermittent
 * "bad indexers" failure is a 502 that *is* worth retrying, and a malformed
 * response is a 502 that is not.
 */
const RETRYABLE: ReadonlySet<ApiErrorCode> = new Set([
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_HTTP',
  'RATE_LIMITED',
]);

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly detail: string | undefined;

  constructor(code: ApiErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
  }

  get status(): number {
    return STATUS[this.code];
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly detail?: string;
    readonly retryable: boolean;
    readonly requestId: string;
  };
}

export function errorBody(error: ApiError, requestId: string, exposeDetail: boolean): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      // A misconfiguration message can name env vars and deployment IDs, so it
      // stays server-side in production.
      ...(error.detail && exposeDetail ? { detail: error.detail } : {}),
      retryable: error.retryable,
      requestId,
    },
  };
}
