# 1. Strict Wire Fingerprint via Versioned Fixtures

We decided to strictly match the wire fingerprint of the official `agy` CLI using versioned capture fixtures (`captures/agy_cli_{version}/`) captured with `mitmproxy`.

Google Antigravity (`daily-cloudcode-pa.googleapis.com`) relies on undocumented `v1internal:` endpoints where header order, exact `User-Agent`, request envelopes (`metadata`), and `thoughtSignature` rules are critical. Instead of guessing API schemas or writing complex heuristic parsers, we capture real traffic from specific `agy` CLI versions as JSON fixtures and enforce exact structural parity in our request builders and tests.
