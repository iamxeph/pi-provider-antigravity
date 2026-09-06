# Actionable API Error Hints

This project does not map backend status codes to actionable user hints
(e.g. 401 → "re-authenticate", 429 → "check quota").

## Why this is out of scope

The raw backend error (status + body) is already surfaced to the user, and
for this extension's audience it is sufficient for debugging. A curated
status-to-hint mapping adds a maintenance liability with little return:

- The mapping can mislead when the backend changes error shapes — a 403
  that re-login cannot fix would still tell the user to re-login.
- Pi's turn-level retry (`retryAssistantCall`) classifies retryability with
  regexes over the error message. Appended hint text is safe today (verified:
  our 429/503 wording still matches, 401 still fails fast), but every future
  wording tweak must re-verify that classification. Raw passthrough has no
  such coupling.
- Truncating long bodies (e.g. at 500 chars) destroys information to solve
  HTML-flood output that has never been observed against this backend —
  real error bodies are short JSON.

If backend errors ever become routinely unactionable for users, reconsider
with fresh evidence rather than re-litigating from scratch.

## Prior requests

- #9: "feat: actionable API error messages (401/429 hints)"
