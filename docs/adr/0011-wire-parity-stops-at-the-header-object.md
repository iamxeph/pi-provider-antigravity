# 11. Wire Parity Is Enforced at the Header Object, Not on the Transport

We decided that strict parity (ADR-0001) covers the endpoint, the header names and their
casing as this provider sets them, and the JSON envelope — not the bytes the HTTP client
writes, which belong to `fetch` (undici). The decision is a trade-off with a measured price,
not a limitation: most of the gap is closable, and what closing it costs is elsewhere.

Evidence. `buildAntigravityHeaders` (`src/protocol.ts`) sets exactly the captured names in
the captured casing (`Host`, `User-Agent`, `Content-Type`, `Authorization`). The captured
set comes in two shapes: `Host, User-Agent, Transfer-Encoding: chunked, Authorization,
Content-Type, Accept-Encoding: gzip` for streamed turns, and `…, Content-Length, …` for the
JSON calls (`retrieveUserQuotaSummary`, `loadCodeAssist`, `fetchAvailableModels`).

Measured on a plain-HTTP local origin (`http.createServer` + `req.rawHeaders`, no TLS, no proxy
environment), the same header object goes out as `host` lowercased to the connection
authority, `content-length`, `accept-encoding: gzip, deflate`, plus four headers `agy` never
sends (`accept: */*`, `accept-language: *`, `sec-fetch-mode: cors`, `connection: keep-alive`).
The explicit `Host` header is ignored in favour of the connection authority — a mismatching
one is illegal.

The set is not even stable across the client's own paths. The same request measured through
`NODE_USE_ENV_PROXY=1` (mitmdump, `pi` running against the live endpoint) carries eight
headers — `Authorization, Content-Type, Host, User-Agent, Connection, Accept,
Accept-Encoding, Content-Length`, `Host` in the casing this provider sets — and neither
`accept-language` nor `sec-fetch-mode`. Protocol is not the variable: every leg was
HTTP/1.1, and the backend chose HTTP/1.1 over TLS 1.3 even though h2 was offered upstream.
The client's path decides, so no single measured set is "the" set.

What closing each gap takes (all measured):

| Gap | With `fetch` today | With `node:https` + `setHost: false` |
|---|---|---|
| `Accept-Encoding` value | set the header explicitly and the client honours it | same |
| Framing (`Content-Length` vs `chunked`) | pass a `ReadableStream` body instead of a string | same |
| The four extra headers | not controllable — the client owns them | gone |
| `Host` casing | not controllable | matches the capture |
| Header order, `Connection` | not controllable | still the client's own (`Host, User-Agent, Content-Type, Authorization, Connection, Content-Length`) |

Consequences:

- Parity tests assert the header object and the URL; "header casing" in the capture README
  means this object, not the bytes. Values `fetch` computes (`Content-Length`,
  `Accept-Encoding`, framing) are not pinned anywhere.
- A capture taken through `mitmdump` therefore shows a different header set than production
  traffic: read those headers as `agy`'s fingerprint, never as the set this provider must
  emit on a given path.
- We stay on `fetch` for the seam, not for the transport. A `node:https` client would keep
  working through the capture runbook — `NODE_USE_ENV_PROXY` and `NODE_EXTRA_CA_CERTS` apply
  to the core HTTP/HTTPS clients too (verified against `mitmdump`: both `fetch` and
  `https.request` reached the real endpoint through the proxy, 2 captured flows). What it
  would cost instead: rewriting `globalThis.fetch` as the single stubbed wire seam in the
  test suites, owning timeouts/abort/redirect/keep-alive plumbing, and closing the door on
  pi's own `ProviderRequestOptions.fetch` injection (unused by this provider today).
- Byte-for-byte parity is out of reach either way: the low-level client keeps its own header
  order and framing decisions, so only a raw-socket implementation could reproduce a capture
  exactly. That is not a trade this provider needs, with no evidence the backend inspects any
  of it.
- Revisit gate: a response that objects to one of the extra headers, requires chunked
  framing, or cares that `Accept-Encoding` is exactly `gzip`. The first two rows above are
  then local changes; the last two force the client question.
