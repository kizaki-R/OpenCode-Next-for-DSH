# Changelog

All notable changes to `opencode-next` (`OpenCode-Next-for-DSH`) are documented in this file.

## [1.0.5] - 2026-11-26

### Added
- Added root `icon.svg` (`./icon`) and localized plugin metadata (`locale/en.json`, `locale/zh.json`, `locale/zh-Hant.json`) so DSH's Installed Plugins list displays the OpenCode-Next logo, title, and localized description.
- Integrated DSH host HTTP route admission via `connection.requestRejection` (`401`/`403` empty-body rejections with `cache-control: no-store` and fail-closed error handling) in `lib/web-api.js`, while retaining explicit `sec-fetch-site` and local loopback fallback checks for older DSH releases (`>=0.1.5-rc.1 <0.3.0`).

### Changed
- Recorded DSH `0.2.1-rc.5` in `dsh.compatibility.dshReleases` in `package.json`.

## [1.0.4] - 2026-11-26

### Fixed
- Fixed DSH dark mode contrast across inset surfaces, fact labels, and device sign-in links (`--ocoa-sunk`, `--ocoa-sunk2`, `.ocoa-fact-label`, `.ocoa-link`) by deriving tints via `color-mix` from active surface and foreground tokens ([#1](https://github.com/kizaki-R/OpenCode-Next-for-DSH/pull/1)).
- Fixed native `<select>` / `<option>` popups in dark mode by explicitly inheriting theme surface/foreground colors and `color-scheme`, and fixed undefined CSS variables in `.ocoa-go-row` and `.ocoa-go-pill`.

### Changed
- Replaced the header language `<select>` dropdown with three segmented buttons (`繁` / `简` / `EN`) matching the compact per-page switcher design while keeping system-locale fallback intact.
- Added a dynamic sun/moon light/dark theme toggle button to the left of the language switcher that tracks DSH's host `data-ds-dark-theme` attribute by default and allows independent per-page overrides.
- Added a footer bar showing the maintainer link (`@kizaki-R`), GitHub repository, issue tracker, and dynamic `npm v<version>` link.
- Changed the Free Models tab's **One-click probe** button to probe only checked models (`m.shown === true`) in default and **Available** views, disabling the button when no models are checked while preserving filtered probing under failure-reason filters or search.

## [1.0.3] - 2026-11-25

### Fixed
- Raised OpenCode Go default first-event timeout from 30 s to 180 s (`GO_DEFAULT_FIRST_EVENT_MS = 180000`) so large-context prefill and thinking turns do not abort prematurely at 30 s.
- Exposed `goSubscription.firstEventTimeoutMs` in `lib/config.js` and wired it through `lib/index.js` to `OpenCodeGoAdapter`.
- Kept `GO_NO_RETRY_POLICY` unchanged so billed Go requests are never re-sent automatically.

## [1.0.2] - 2026-11-25

### Fixed
- Made `canonicalSessionId()` in `lib/client.js` deterministic across 1 ms clock ticks so multi-turn conversations keep one `x-opencode-session` ID.
- Guarded `document.addEventListener` / `querySelector` and added click-listener teardown in `lib/ui.js` nav-icon patching.

### Changed
- Added DSH UI screenshots and `screenshots.json`.
- Fixed CI matrix across Ubuntu/Windows and Node 20/22 with isolated auth fixtures, `setup-bun`, and cross-platform Bun path resolution.

## [1.0.1] - 2026-11-24

### Fixed
- Enabled `goSubscription.enabled` by default in `lib/config.js` so OpenCode Go works after saving a Personal API Key without editing `cordis.patch.yml` (set `goSubscription.enabled: false` to disable).

### Changed
- Updated `goDisabledHint` messages in `lib/ui.js` (`en`, `zh`, `zh-Hant`) and added brand icons and EN/zh-TW README banners in `assets/`.

## [1.0.0] - 2026-11-23

### Added
- Initial release of `OpenCode-Next` (`opencode-next`) for DeepSeek Harness (DSH): dual-track OAuth free models, Bun transport, model probing and picker curation, and OpenCode Go subscription support with 5h/7D/1M usage gauges.
