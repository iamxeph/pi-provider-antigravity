# 5. Single-bundle Distribution via esbuild

We decided to bundle all source code and internal dependencies into a single `dist/index.js` file using `esbuild`.

Pi extensions run inside the Pi process. Emitting a single self-contained bundle eliminates runtime file I/O across multiple JavaScript files during Pi startup, avoids module resolution quirks across different Node.js environments, and provides the fastest possible extension load time. External peer dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) are marked external.
