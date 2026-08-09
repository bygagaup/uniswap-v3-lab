# The proxy takes operation names, not GraphQL, and answers on GET

Clients send `{chain, op, variables}`. They never send GraphQL text, and the response is
served over **GET**.

**Why not pass GraphQL through.** The proxy runs on our Graph API key. A proxy that
forwards arbitrary queries is a free faucet for anyone who opens the Network tab — they
get our key's quota for whatever they like. An allowlist of named operations bounds
exactly what the key can be spent on, and it bounds it server-side, where the client
cannot argue.

**Why GET.** A named operation with variables is a cacheable URL, so the edge CDN can
hold responses with per-operation TTLs. A POST body is not cacheable by the same
machinery, and pool metadata that changes hourly has no business hitting the gateway on
every view.

## Consequences

- Adding a query is a server-side change (a new allowlisted operation), never a
  client-side one. This is the intended friction.
- `GRAPH_API_KEY` never leaves `apps/api`; CI greps the built bundle for it.
- The gateway returns `200 OK` with `{errors: […]}` for a dead or unsynced subgraph.
  That is translated to `502 UPSTREAM_GRAPHQL`, and kept distinct from
  `{data: {pools: []}}`, which is a successful empty result. Conflating the two turns a
  broken deployment into an eternal spinner.
