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
- **Quota visibility**: 5-hour and weekly remaining quota per model pool, with reset times
  and a live footer slot. See [Quota footer](#quota-footer).

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
| `models` | View available models and remaining fraction (alias: `model`) |
| `refresh` | Refresh dynamic model catalog from Antigravity |
| `settings` | Pick provider settings, Enter cycles values (alias: `setting`) |
| `login` | Shortcut: fills in `/login antigravity` for you |

Related Pi builtins:

| Command | Description |
|---|---|
| `/login antigravity` | Authenticate with Google via OAuth |
| `/model antigravity/<id>` | Select a model from the live catalog |

## Quota footer

Quota tracking right in Pi's footer:

```text
5h 22% (3h 0m) · Wk 87% (4d 4h)
```

Each segment displays the window name (`5h` or `Wk`), remaining capacity percentage, and time left until reset.

### Visual Warnings

Remaining percentages are automatically colorized to keep depletion visible without clutter:
- **Normal** (> 30%): Default terminal color
- **Low** (≤ 30%): Yellow
- **Critical** (≤ 10%): Red

In `all` mode, each window carries its own color based on its remaining percentage.

### Display Modes

Switch between display modes at any time using `/antigravity settings`:

| Mode | Example | Behavior |
|---|---|---|
| `off` *(default)* | *(hidden)* | Slot stays empty; zero background quota requests |
| `smart` | `Wk 6% (2d 14h)` | Shows the window that runs out first, 5h or weekly |
| `all` | `5h 90% (3h 54m) · Wk 6% (2d 14h)` | Shows every window of the pool backing the current model |

### Footer placement

The extension never calls `setFooter` — it only publishes the slot text under the key `pi-provider-antigravity-footer-usage` via `setStatus`. Where that text renders is up to your footer; Pi's built-in one gives it its own line, below the default two.

To move it elsewhere (the right side of the first line, for example), ask Pi in a session and name the key:

> Move the `pi-provider-antigravity-footer-usage` slot to the right side of the first footer line, keeping the rest of the footer as it is.

Pi edits your own footer extension, creating one if you have none — based on
Pi's [complete custom-footer
example](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/custom-footer.ts),
which Pi maintains. A custom footer replaces the built-in one, so Pi has to
redraw whichever lines you want to keep.

### Under the Hood

- **Model-aware pool routing**: Automatically aligns with your active model. Selecting a Gemini model displays the Gemini quota pool; switching to Claude or GPT switches to the third-party pool. When using a non-Antigravity model or no model at all, the slot cleanly disappears.
- **Bottleneck detection**: In `smart` mode, the extension determines urgency using `min(r5h, rWk × R)` rather than a naive percentage comparison, accounting for total volume differences between the 5-hour and weekly pools. The volume multiplier `R` starts at 6.0 and automatically self-calibrates between 1.0 and 20.0 based on real usage deltas, persisting across restarts.
- **Battery- and network-friendly caching**: Idle sessions perform zero network requests. The slot repaints instantly from memory on turn completion, session launch, and model changes. Upstream quota queries are throttled to at most once every 5 minutes. Running `/antigravity usage` refreshes upstream data immediately.

## Configuration

You can configure extension preferences interactively via the command palette or declaratively through a configuration file.

### Interactive Settings

Run the settings command to open Pi's native cycling menu:

```text
/antigravity settings
```

- Press **Enter** or **Space** to cycle through option values.
- Press **Esc** to close.
- Changes are saved and applied immediately.

### File-based Configuration

Configuration is stored in `pi-provider-antigravity.json` alongside Pi's `settings.json` (resolved via `$PI_CODING_AGENT_DIR`, falling back to `~/.pi/agent/`):

```json
{
  "settings": {
    "quotaFooter": "smart"
  }
}
```

> **Note:** The extension may persist runtime metadata (such as quota calibration ratios) in an adjacent `"states"` block. Hand-written comments in this file are not preserved across automated updates.

### Available Settings

| Key | Values | Default | Description |
|---|---|---|---|
| `quotaFooter` | `off`, `smart`, `all` | `off` | Display remaining quota in Pi's status footer. See [Quota footer](#quota-footer). |

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
