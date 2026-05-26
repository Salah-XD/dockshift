---
description: Run a security + memory/leak audit of the codebase before cutting a release. Delegates two parallel subagents and summarises findings.
---

Run a pre-release audit of DockShift. This is **research only** — do not edit code. The output is two prioritised finding lists and a release-readiness verdict for each.

Delegate the two audits to subagents in parallel (one tool-call message, two `Agent` calls). They are independent and `electron-main.js` is ~1800 lines — running them concurrently keeps the main context clean and the wall-clock short.

## Step 1 — Spawn both audits in parallel

Use `subagent_type: general-purpose` for both. Use the prompts below verbatim (tweak only the scope sentence at the top if the user has narrowed it).

### Security audit prompt

```
Perform a focused security audit of the DockShift Electron app at <repo root>
before a release. This is research only — do NOT modify any files. Return
findings as a prioritized list (Critical / High / Medium / Low / Info).

Read `AGENTS.md` first for the full architecture and the security invariants
the project claims to preserve.

Check, at minimum:

1. Electron hardening — every `new BrowserWindow(...)` webPreferences
   (nodeIntegration, contextIsolation, sandbox, webSecurity,
   allowRunningInsecureContent). `app.on('web-contents-created')`
   navigation/new-window handlers. CSP headers. `<webview>` partition
   isolation and `will-attach-webview` lockdown.
2. IPC surface — enumerate every `ipcMain.handle` / `ipcMain.on` in
   `electron-main.js`. Cross-check against the `allowed` /
   `allowedSendChannels` arrays in `preload.js`. For each handler flag:
   path traversal, command injection, secret exfiltration,
   `shell.openExternal` with renderer-controlled input, missing input
   validation on `settings:set`-style "spread into JSON" handlers.
3. Path traversal — `path.join` / `fs.*` where input comes from the
   renderer. Persistence under `app.getPath('userData')` is fine;
   arbitrary file reads are not.
4. Command injection / spawn safety — `node-pty`, `child_process.spawn`,
   `execFile`, PowerShell here-strings with interpolated values. Check
   `TerminalManager.js` cwd and metacharacter validators. Check
   `launcher:` handlers and workspace-restore exe-launch path.
5. Secret handling — hardcoded keys, `.env` leaks. Confirm the renderer
   bundle (`dist/assets/*.js`) does not contain `VITE_GEMINI_API_KEY`
   or `GEMINI_API_KEY` substrings. Confirm `electron-secrets.js`
   never returns plaintext values across IPC.
6. Updater — electron-updater publish config, code-signing
   (`win.certificateFile` / `publisherName`), autoDownload /
   autoInstallOnAppQuit behavior. An unsigned auto-installing updater
   is a release-blocker.
7. External content — Gemini / STT / update feed / browser panel.
   URL scheme allowlists. User-input URLs handed to `shell.openExternal`
   or `loadURL`.
8. Dependency hygiene — `npm audit --json`, summarise Critical/High.

Output format: for each finding give severity, file:line, what's wrong,
why it matters, suggested fix. Group by severity. If a category has no
issues, say so explicitly. End with a one-paragraph release-readiness
verdict.

Time-box ~25 minutes. Prioritise IPC surface, terminal/launcher, and
the Electron pin's published advisories.
```

### Memory audit prompt

```
Perform a focused memory / resource-leak audit of the DockShift Electron
app at <repo root> before a release. Research only — do NOT modify files.

Read `AGENTS.md` first. This app runs continuously in the background
(productivity dock) — leaks compound. A 100 KB/min drip is a real bug.

Check, at minimum:

Main process (`electron-main.js`, `src/workspace/*`):
1. setInterval / setTimeout — every timer must have a matching
   clearInterval / clearTimeout on `will-quit` and on the event that
   created it. List each timer with its lifecycle.
2. `ipcMain.on` registered conditionally / inside another handler
   (accumulating listeners). `ipcMain.handle` is fine (one per channel).
3. webContents.send subscribers on a closed/reloaded window.
4. node-pty — every spawned pty killed on app quit and on panel close.
   Check `will-quit` for an explicit `.kill()` and dead-pty cleanup.
5. `fs.watch` / `chokidar` close().
6. Clipboard polling — does it pause when the dock is hidden? Are
   buffers / history bounded?
7. WindowTracker polling cleanup.
8. globalShortcut.unregisterAll on will-quit. tray.destroy.
9. Image buffers — clipboard images, screenshots, icons. Are they
   bounded in memory (not just on disk)?

Renderer (`src/`):
1. Every `useEffect` that subscribes (addEventListener, IPC `onX`,
   intervals, observers) must return a cleanup.
2. IPC subscriptions — `window.electronAPI.onX` must return an
   unsubscribe AND the renderer must call it. Verify the preload
   actually returns one.
3. xterm.js, re-resizable, vosk-browser disposal in TerminalPanel,
   ResizablePanel, VoicePanel.
4. AbortController on long-running fetches (Gemini streaming) — does
   unmount cancel?
5. useRef holding unbounded arrays / Maps.
6. Whether panels are conditionally mounted or permanently mounted
   with isOpen={false} (latter never frees panel-local state).

Heuristics:
- Static analysis is enough; you don't need to run the app.
- List bundle entries over 500 KB from `dist/assets/`.
- Verify there are no `ipcMain.on(` calls (grep) — DockShift uses
  only `.handle`, which is the leak-resistant API.

Output format: severity (Critical/High/Medium/Low/Info), file:line,
what leaks, expected vs actual lifecycle, suggested fix. Group by
severity. If a category has no issues, say so. End with a
one-paragraph release-readiness verdict on memory.

Time-box ~25 minutes. Prioritise timers, pty cleanup, and renderer
useEffect cleanups.
```

## Step 2 — Summarise

When both subagents return, present the findings as one combined report:

1. **Headline verdict** — ship / hold / hold-blocking-on-X. One sentence.
2. **Blockers** — Critical findings and any High finding the maintainer should fix before tagging the release.
3. **Recommended for the next minor** — High/Medium findings that are real bugs but not release-blockers.
4. **Verified safe** — categories the audits checked and found clean. This is load-bearing — without it, a future auditor doesn't know what was already covered.

Always include `file:line` for every finding so the maintainer can jump straight there.

## Don't

- Don't apply fixes during the audit. The maintainer wants the report first; fixes get cherry-picked in a follow-up commit so they're easy to review and easy to revert.
- Don't re-run the audit against a still-running Vite/Electron dev server's output — read source files. Findings derived from logs go stale instantly.
- Don't skip the "Verified safe" section. It's the difference between an audit and a vibe check.
- Don't propose generic advice ("consider adding tests", "use TypeScript"). Every finding must be a specific behavior change at a specific location.

## Why this exists

A release without a security pass on the IPC surface and a memory pass on the always-on timers is a release waiting for a CVE or a 2-GB-resident-set bug report. The two audits cover orthogonal failure modes and parallelise cleanly. Codifying the prompts here means the next auditor — human or agent — starts from the same checklist instead of re-deriving it.
