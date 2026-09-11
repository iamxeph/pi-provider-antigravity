# 13. The Persisted Catalog Snapshot Carries No Generation Counter

We decided the Catalog Snapshot written into the provider's private store entry holds no
counter, even though freshness is decided by exactly such a counter in memory.

`refreshCatalogGeneration` reads fresh/stale/failed off a version bump (#46, #51: the
catalog seam owns the verdict, and `refreshCatalog`'s `Model[]` return is a Pi contract
that stays untouched): fresh means a new Catalog Generation landed in this
process, stale means a retained generation survived a failed fetch, failed means nothing is
retained. Catalog Persistence writes the store entry wholesale
(`ModelsStore.write(providerId, entry)`), so persisting the counter would make a restored
snapshot indistinguishable from a fetched one: the first `/antigravity models` after a
restart would print a retained list as fresh, and `/antigravity refresh`'s stale warning
would never appear. The counter's meaning is "a fetch succeeded here", and a file read is
not a fetch.

Consequences:

- The store's two writes are distinct: `record()` bumps the counter, `restore()` does not,
  and `restore()` applies only to a pristine store so older persisted data can never
  overwrite a recorded generation.
- The codec (`toPersistedSnapshot` / `fromPersistedSnapshot`) is therefore total over the
  snapshot's four fields — no field selection, so adding or dropping one is a single edit.
  A restored snapshot is version 0.
- The private entry's `modelEnums` spelling is part of the file format, not a code detail:
  every installed provider has it on disk, and Pi persists unknown keys verbatim (ADR-0004).
  Revisit gate: a second consumer of the persisted entry that needs to know which fetch
  produced it — that consumer must carry its own proof (e.g. a remote `etag`), not the
  generation counter.
