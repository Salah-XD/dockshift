# Changelog

All notable changes to DockShift are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.4] - 2026-05-26
## [0.9.3] - 2026-05-15
## [0.9.2] - 2026-05-15
## [0.9.1] - 2026-05-15
## [0.9.0-rc.2] - 2026-05-15

Release candidate for [0.9.0]. Same changes as below, plus:

### Changed
- Installer is now **one-click** (no wizard) — runs after install, like Slack/Discord/VS Code.
- GitHub Actions release workflow auto-detects pre-release tags (`-rc.N` suffix) and skips
  the draft step, so releases publish immediately as Latest or Pre-release.

### Added
- `npm run release <ver>` helper — bumps `package.json`, README badge, and CHANGELOG date
  in sync, then prints the git commands to commit/tag/push.
- NSIS installer/uninstaller icons now use the DockShift app icon.

## [0.9.0] - 2026-05-15

First public beta. The app is feature-complete for everyday use; we're shipping at 0.9
(not 1.0) because the Windows installer is not yet code-signed and we want a beat of
real-world feedback before declaring 1.0.

### Added
- **Workspace snapshots actually persist your dock state** — the panel you had open is
  reopened on next launch (resolved a long-standing TODO; the dock layout now round-trips
  through `dock-layout.json` in `userData`).
- **AI request timeouts** — chat hangs no more than 60s (non-streaming) or 60s of idle
  silence (streaming, with a 45s grace for the first chunk). Times out cleanly with a
  `TIMEOUT` error code instead of an infinite spinner.
- **Light / dark / system theme.** A CSS custom-property token system (`theme.css`) with a
  `ThemeContext`; every panel reads theme tokens instead of hardcoded colors. Switchable from
  Settings → Appearance; the preference persists.
- **Multiple AI providers.** Gemini, OpenAI, Anthropic Claude, Ollama (local, no key), and
  OpenRouter — selectable in Settings → AI / Models, with a model picker per provider.
- **In-app API key management.** Keys are entered in Settings and stored encrypted via the OS
  keystore (`safeStorage` / DPAPI). The renderer can only set/check/remove keys — a raw key
  value never crosses the IPC boundary. `.env` still works as a Gemini dev override.
- **Streaming AI responses.** Chat replies render incrementally as tokens arrive.
- **Code-aware AI quick actions** — explain code, write tests, fix error, review, add docs,
  add types — replacing the previous generic actions.
- `electron-builder` configuration — `npm run dist` produces a Windows NSIS installer and a
  portable build.
- `npm run icons` — one-shot regenerator for `assets/icon.{png,ico}` from a single source PNG.
- Auto-update via `electron-updater`, wired to GitHub Releases (packaged builds only).
- GitHub Actions release workflow that builds and publishes the installer on version tags.
- Atomic JSON persistence with corrupted-file recovery: stored files are written via a
  temp-file rename, and an unreadable file is preserved as a `.corrupt-<timestamp>` backup
  with a user notification instead of being silently discarded.
- Open-source project files: `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and
  pull-request templates.
- `package.json` author / repository / bugs / homepage fields so the Windows installer's
  Publisher field is no longer blank.

### Changed
- Rebranded from "Float Dock" to **DockShift**.
- `.env` parsing now handles quoted values and inline comments instead of storing them
  verbatim.
- `iconCache` is now LRU-bounded at 500 entries — long sessions with many launched apps no
  longer leak memory unboundedly.

### Fixed
- **Packaged app could not start** — `electron-ai-providers.js` and `electron-secrets.js`
  were imported by `electron-main.js` but missing from `build.files`, so the .exe would have
  thrown `Cannot find module` at startup. Both now bundled.
- **Packaged renderer was blank** — Vite's default `base: '/'` resolved asset paths to the
  drive root under `file://`, so the bundle 404'd and the dock window appeared invisible.
  Set `base: './'`.
- Path traversal in workspace snapshot names — names are now sanitized to a safe filename
  component before touching the filesystem.
- Shell injection via a crafted workspace `cwd` — the working directory is no longer
  interpolated into a shell command string and is rejected if it contains shell
  metacharacters.
- The PTY environment filter now strips any secret-looking variable by pattern, not just a
  fixed list of known key names.
- 17 stray `console.log` calls removed from main-process and workspace code (kept
  `console.warn`/`console.error` for genuine diagnostics).
- Asset filenames de-typo'd and de-spaced (`ai assitant.png`, `setttings.png`,
  `dockshift banner.png`, `dock preview.png`, `voice to text.png`).

### Removed
- The broken `npm start` script.
