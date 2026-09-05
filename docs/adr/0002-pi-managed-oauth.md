# 2. Independent OAuth Managed by Pi Core

We decided to implement an independent Google OAuth 2.0 PKCE flow integrated with Pi's native auth store rather than reading existing tokens from `~/.gemini/antigravity-cli/antigravity-oauth-token`.

Although `agy` stores tokens locally, coupling the extension to another CLI's internal file layout risks silent breakages when `agy` updates its internal storage format or token refresh strategy. By registering standard `oauth` provider handlers (`login`, `refreshToken`, `getApiKey`) with `pi.registerProvider`, Pi's core runtime manages credential persistence in `~/.pi/agent/auth.json`, token expiration, and automatic refreshes transparently.
