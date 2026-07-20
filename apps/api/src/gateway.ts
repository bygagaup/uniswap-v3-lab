/**
 * The single point of contact with The Graph's gateway.
 *
 * Everything that can go wrong here becomes an ApiError with a specific code.
 * There is no path that returns null, and no path that returns a 200 carrying
 * a failure.
 */
import { ApiError } from './errors.js';
import type { Operation } from './operations.js';

/** Beyond this the client has given up anyway, and the Worker is burning CPU. */
const UPSTREAM_TIMEOUT_MS = 20_000;

interface GraphQLResponse {
  data?: unknown;
  errors?: readonly { message?: string }[];
}

export async function queryGateway(args: {
  url: string;
  operation: Operation;
  variables: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<unknown> {
  const { url, operation, variables } = args;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: operation.document, variables }),
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    throw new ApiError(
      aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_HTTP',
      aborted ? 'The subgraph did not respond in time' : 'Could not reach the subgraph',
      cause instanceof Error ? cause.message : String(cause),
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new ApiError(
      'UPSTREAM_HTTP',
      `The subgraph gateway returned ${response.status}`,
      await response.text().catch(() => undefined),
    );
  }

  const data = await extractData(response);
  return operation.transform ? operation.transform(data) : data;
}

/** Turns a 2xx gateway response into `data`, or the right ApiError. */
async function extractData(response: Response): Promise<unknown> {
  let body: GraphQLResponse;
  try {
    body = (await response.json()) as GraphQLResponse;
  } catch (cause) {
    throw new ApiError(
      'UPSTREAM_MALFORMED',
      'The subgraph returned a response that is not JSON',
      cause instanceof Error ? cause.message : undefined,
    );
  }

  // A dead or unsynced deployment answers 200 with an errors array. Treating
  // that as data is how a broken subgraph becomes an eternal loading spinner.
  if (body.errors?.length) {
    throw new ApiError(
      'UPSTREAM_GRAPHQL',
      'The subgraph rejected the query — the deployment may be unsynced or retired',
      body.errors.map((e) => e.message ?? 'unknown').join('; '),
    );
  }

  // `{data: {pools: []}}` is a successful empty answer and must survive; only a
  // missing `data` key is malformed.
  if (body.data === undefined || body.data === null) {
    throw new ApiError('UPSTREAM_MALFORMED', 'The subgraph returned no data field');
  }

  return body.data;
}
