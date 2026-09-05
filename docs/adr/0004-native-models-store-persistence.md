# 4. Native Pi models-store.json for Catalog Persistence

We decided to rely entirely on Pi's native `refreshModels` hook and `models-store.json` rather than creating a custom model cache file.

Pi provides first-class dynamic model persistence: when an extension registers a provider with `refreshModels`, Pi persists the retrieved catalog in `~/.config/pi/models-store.json` (or `~/.pi/agent/models-store.json`) and handles offline restoring, throttling, and catalog overlays natively. Implementing custom JSON cache files in the extension would duplicate Pi core functionality and increase boilerplate.
