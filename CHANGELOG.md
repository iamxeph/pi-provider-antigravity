# Changelog

## [0.15.0](https://github.com/iamxeph/pi-provider-antigravity/compare/v0.14.0...v0.15.0) (2026-09-20)


### Features

* improve Pi 0.86 SDK integration and stream robustness ([#21](https://github.com/iamxeph/pi-provider-antigravity/issues/21)) ([464e376](https://github.com/iamxeph/pi-provider-antigravity/commit/464e3762dde6719842e5baa1857dc564fb7b8bbc))

## [0.14.0](https://github.com/iamxeph/pi-provider-antigravity/compare/v0.13.0...v0.14.0) (2026-09-20)


### ⚠ BREAKING CHANGES

* Drops support for Pi < 0.86.0.

### Features

* migrate to Pi 0.86.x TranscriptContext ([#18](https://github.com/iamxeph/pi-provider-antigravity/issues/18)) ([a2bb390](https://github.com/iamxeph/pi-provider-antigravity/commit/a2bb390fd5e811c9b1baf7dbc2d585dff7b58ced))

## [0.13.0](https://github.com/iamxeph/pi-provider-antigravity/compare/v0.12.0...v0.13.0) (2026-09-17)


### Features

* **compatibility:** verify wire compatibility with agy CLI 1.2.5 ([#15](https://github.com/iamxeph/pi-provider-antigravity/issues/15)) ([5f3f14f](https://github.com/iamxeph/pi-provider-antigravity/commit/5f3f14fa7c7be2643510c96fd6bf7cb15ff519f0))

## [0.12.0](https://github.com/iamxeph/pi-provider-antigravity/compare/v0.11.0...v0.12.0) (2026-09-16)


### Features

* **compatibility:** verify wire compatibility with agy CLI 1.2.4 ([#11](https://github.com/iamxeph/pi-provider-antigravity/issues/11)) ([adfffd5](https://github.com/iamxeph/pi-provider-antigravity/commit/adfffd5bca755fa28c3e33d0e80aac7a33720d23))
* **quota-status:** adapt footer quota colors to active Pi theme ([f73add6](https://github.com/iamxeph/pi-provider-antigravity/commit/f73add6bc70d09aafc9f3209dae7237a3070d436))

## [0.11.0](https://github.com/iamxeph/pi-provider-antigravity/compare/v0.10.0...v0.11.0) (2026-09-16)


### Features

* **compatibility:** verify wire compatibility with agy CLI 1.2.3 ([f219db2](https://github.com/iamxeph/pi-provider-antigravity/commit/f219db2a9073126687cfd7dd1d62d2083d0c1011))
* **search:** rename tool to antigravity_websearch and command to websearch ([9642537](https://github.com/iamxeph/pi-provider-antigravity/commit/96425376d747c40d8cb92037216011a74e8943b7))

## [0.10.0](https://github.com/iamxeph/pi-provider-antigravity/compare/v0.9.0...v0.10.0) (2026-09-15)


### Features

* **search:** rename search_web tool to antigravity_search ([#6](https://github.com/iamxeph/pi-provider-antigravity/issues/6)) ([b379f76](https://github.com/iamxeph/pi-provider-antigravity/commit/b379f7600df9c203f159e1b7cfbd92d5f2bebb2c))

## [0.9.0](https://github.com/iamxeph/pi-provider-antigravity/compare/v0.8.1...v0.9.0) (2026-09-15)


### Features

* **search:** add Google search grounding and deepen model catalog ([#3](https://github.com/iamxeph/pi-provider-antigravity/issues/3)) ([8d63900](https://github.com/iamxeph/pi-provider-antigravity/commit/8d639003ff9814ddb9833b7090c56ed0b46813d3))

## [0.8.1](https://github.com/iamxeph/pi-provider-antigravity/compare/v0.8.0...v0.8.1) (2026-09-14)


### Bug Fixes

* **quota-status:** ignore a dead session ctx in footer paint and refresh ([#1](https://github.com/iamxeph/pi-provider-antigravity/issues/1)) ([e0626c0](https://github.com/iamxeph/pi-provider-antigravity/commit/e0626c0ccc15056472c39a66d6445881c136e0d6))

## 0.8.0 (2026-09-15)

### Features

* **compatibility:** verify compatibility with Antigravity CLI 1.2.2
* **core:** optimize request builder performance and streamline payload handling
* **tests:** transition to lightweight offline test fixtures for faster test runs
* **docs:** update setup instructions and clarify research/study guidelines

## 0.7.0 (2026-09-11)

### Features

* **protocol:** deep protocol wire client and auth credential seams
* **catalog:** dynamic model catalog resolution from live snapshot
* **quota:** live footer status slot with automated volume ratio calibration
* **settings:** interactive TUI and file-based configuration
