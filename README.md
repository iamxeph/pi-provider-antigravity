# pi-provider-antigravity

Use Google Antigravity models directly in [Pi](https://pi.dev).

> ⚠️ **Disclaimer:** Unofficial harness use is a ToS breach and can cost you
> your Antigravity access — or, in theory, your whole Google account.
> Read the [full disclaimer](#disclaimer) before logging in.

## Features

- **Verified wire parity**: headers, request envelopes, and tier/thinking mapping
  matched against real `agy` CLI traffic captures — not guessed.
- **Dynamic model catalog**: exposes exactly the models your account can use,
  synthesized from the live catalog and cached for offline startup.
  Newly released models are usable immediately without waiting for an extension update.
- **OAuth with auto-refresh**: log in once via `/login antigravity`; tokens refresh silently.
- **Quota visibility**: 5-hour and weekly remaining quota per model pool, with reset times.

## Requirements

- Pi >= 0.80.0
- A Google account with Antigravity access

## Installation

```bash
pi install npm:pi-provider-antigravity
```

Or try it without installing:

```bash
pi -e npm:pi-provider-antigravity
```

## Quick Start

1. Authenticate:
   ```text
   /login antigravity
   ```
2. Select a model (IDs are dynamic — served from your account's live catalog,
   so check `/antigravity models` for the current list; example):
   ```text
   /model antigravity/gemini-3.8-flash
   ```
3. Check quota:
   ```text
   /antigravity usage
   ```
   ```text
   Gemini Models
     5h  [##--------]  22% left (in 3h 0m)
     Wk  [#########-]  87% left (in 4d 4h)

   Claude and GPT models
     5h  [########--]  84% left (in 2h 0m)
     Wk  [##########]  95% left (in 4d 14h)
   ```

## Commands

Extension subcommands (`/antigravity ...`):

| Subcommand | Description |
|---|---|
| `usage` | Check 5-hour and weekly quota limits and reset times |
| `models` | View available models and remaining fraction |
| `refresh` | Refresh dynamic model catalog from Antigravity |
| `login` | Shortcut: fills in `/login antigravity` for you |

Related Pi builtins:

| Command | Description |
|---|---|
| `/login antigravity` | Authenticate with Google via OAuth |
| `/model antigravity/<id>` | Select a model from the live catalog |

## Disclaimer

This extension spends your Google account's Antigravity quota from a third-party
harness — which the [Antigravity ToS](https://antigravity.google/terms) (§6)
explicitly calls a breach (it names OpenClaw-over-OAuth as the example; this
project is the same pattern). Read this before logging in:

- **Stated enforcement: Antigravity and/or Gemini CLI accounts.** Per §6,
  third-party access "may be grounds for suspension or termination of your
  Antigravity and/or Gemini CLI accounts" (they share quota).
- **Residual risk: your whole Google account.** The ToS also binds you to the
  Universal [Google Terms](https://policies.google.com/terms) (§1), which allow
  Google to suspend your access to the services **or delete your Google Account**
  for breach of service-specific terms ([context](https://x.com/GergelyOrosz/status/2095453567955968398)).
This project is unofficial and not affiliated with Google. Use at your own risk.

## License

MIT
