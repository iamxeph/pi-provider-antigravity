# 6. Deep Turn Trace Request Builder Module

We decided to collapse the shallow Turn Trace helper modules (`contents.ts`, `session.ts`, `thought.ts`) into a single deep `builder.ts` module with `buildAntigravityRequestBody` as its sole external interface, fully encapsulating session trajectory derivation, Thought Signature validation, and tool schema normalization.

Splitting request construction across multiple micro-modules caused session identities (`sessionId`, `trajectoryId`) to leak across internal seams and encouraged testing private helper functions past the module interface ("testing past the seam"). By concentrating all Wire Fingerprint request assembly rules inside one deep module:
1. Callers (`stream.ts`) pass only conversation context, project ID, and Model Plan, with session identities (`sessionId`, `trajectoryId`, numeric session ID) automatically derived deterministically from the conversation history.
2. The interface is the test surface: unit tests verify real Turn Trace payloads and Wire Fingerprint invariants directly through `buildAntigravityRequestBody`, guaranteeing high locality and preventing shallow module drift.
