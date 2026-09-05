# 3. Multi-turn Session Fixtures (≥ 5 Turns)

We decided to require multi-turn interaction traces (at least 5 conversational turns) for conversation, thinking, and tool calling capture fixtures in `captures/agy_cli_{version}/`.

Single-turn dumps miss critical state transitions in Google Antigravity. Specifically, Gemini 3.x requires preserving and replaying `thoughtSignature` from prior assistant turns, and multi-turn tool calling alternates between `functionCall` and `functionResponse` blocks. Testing against full 5-turn session logs ensures accurate replay and envelope reconstruction.
