# 10. `last_execution_id` Is Not Reproduced

We decided not to send the `last_execution_id` label that `agy` adds to some requests,
because nothing on the wire this provider can see produces it.

Evidence (`captures/agy_cli_1.1.26` … `1.1.28`): the label rides 9 of the 26 frozen
stream requests — every continuation turn (`1.1.26` turn4/turn5, `1.1.27` turn4/turn5/turn9,
`1.1.28` turn4/turn5/turn8b/turn9) and none of the fresh ones or the tool-result ones
(turn2/turn6). Its UUID appears in no captured response: searching `captures/` for each
value finds it only in the request that carries it, so the backend never handed it back in
anything we can replay, and no builder-side input (session, trajectory, turn count,
`requestId`) derives it. Continuations that omit it — `stream_turn2_toolresult` and
`stream_turn6_toolerror` in every version — answer 200, so a continuation does not require
the field.

Consequences:

- The Turn Trace Request Builder stays a pure function of the conversation: it threads no
  per-execution state, and every label it writes comes from the history or the Model Plan.
- The wire-parity replay test names this as the one label it compares out
  (`tests/wire-parity.test.mjs`). Revisit gate: a capture that starts sending it, or a
  backend rejection that mentions it — the value's source must then be captured (a fresh
  `mitmdump` run per `captures/README.md`) before anything is emitted.
- Guessing a value (a fresh UUID, the `trajectory_id`) would put a fabricated identifier on
  the wire, which is what ADR-0001's strict-parity rule exists to prevent.
