# 7. Sentinel Divergence for Foreign-Authored Tool Calls

We decided to send Google's documented `skip_thought_signature_validator` sentinel on a
`functionCall` part that has no replayable `thoughtSignature` — but **only when that call
was authored by another provider or model family**, and only on Gemini requests.

Gemini 3 validates thought signatures for every step of the *current* turn (a turn begins
with the most recent user message that is not a `functionResponse`) and otherwise answers
`400 INVALID_ARGUMENT "Function call is missing a thought_signature in functionCall
parts"`. ADR-0001's strict-parity rule cannot cover this case: `agy` never replays a tool
call authored by another model, so the official CLI has no wire shape for a cross-provider
switch. Dropping the foreign signature — the previous behavior — left exactly that 400
whenever the switch happened inside an open tool turn, and the session could not continue
until a fresh user message moved the turn boundary.

Evidence: `captures/pi_probe_sentinel/` (probe captures through `mitmdump`, 2026-09-10).
A/B on `gemini-3.8-flash-low`, where the only delta between A and B is that one field:
unsigned pending foreign `functionCall` → 400 with the message above; the same body with
the sentinel → 200. The same probe on `claude-sonnet-4-6`: unsigned → 200 (a signature is
not required there) and sentinel → 200 (tolerated but pointless), so the Claude/GPT wire
stays untouched.

Consequences:

- The divergence is reachable only by traffic `agy` cannot produce. No captured `agy`
  request contains an unsigned `functionCall` part, so every fixture replays
  byte-identically (wire-parity suites stay green) and ADR-0001 keeps its meaning.
- A signature we *should* have had — same provider and family, yet missing, unreadable,
  or damaged — is deliberately left unpatched: the 400 stays visible instead of quietly
  degrading the model, and pre-#26 sessions stay abandoned as decided in #26.
- The sentinel trades that call's reasoning continuity for an accepted request, so it
  stays a last resort (Google's wording), never a default.
- Revisit gate: if probe B stops returning 200 the sentinel has been retired and the
  builder must change with it (`captures/pi_probe_sentinel/README.md`).
