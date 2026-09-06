# Stream Retry and Metadata Timeouts

This project does not retry failed stream requests at the fetch layer and
does not bound metadata calls with timeouts — matching the official `agy`
CLI, which waits indefinitely at the HTTP layer on every endpoint.

## Why this is out of scope

- **Streams are already covered one layer up.** Pi's `retryAssistantCall`
  retries failed assistant turns under the `settings.retry` policy, keyed
  off the error message. A fetch-layer retry only absorbs the failure
  1–2 seconds earlier at the cost of a second retry budget stacked on top.
- **Retrying 429s is actively harmful here.** This backend is quota-based:
  a 429 means "wait for the reset window", not "try again now". Burning
  retries delays the useful error instead of helping.
- **Timeouts deviate from `agy` parity.** Probes through a delay proxy
  (150s on metadata, 240s on streams) showed `agy` never gives up at the
  HTTP layer on any endpoint — the only bound observed is the 5-minute
  print-mode deadline. Our timeouts are invisible on the wire, so this is
  a behavior-parity choice, not a fingerprint one: hang like `agy` hangs.
- A stalled metadata call hanging the command is accepted as agy-identical
  behavior. If hangs ever become a real operational problem (not a
  theoretical one), reconsider with fresh evidence.

## Prior requests

- #8: "feat: retry transient stream failures and cap metadata calls"
