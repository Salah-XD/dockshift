# Ctrl+Shift+Space dictation pill (Voice Phase 2)

**Date:** 2026-06-24
**Branch:** `feat/voice-dictation-spec`
**Status:** design approved
**Master design:** [`2026-06-24-local-voice-dictation-design.md`](./2026-06-24-local-voice-dictation-design.md) — §7.2, §8, §11, §14.1 cover the pill in depth; this doc records the Phase 2 scope + the decisions resolved at build time.

## Goal

A global hotkey pops a floating dictation pill, captures speech, transcribes it
on-device (the verified `local-parakeet`/sherpa path), and **auto-inserts the
text into whatever app is focused** — Handy-parity, the headline UX.

## Decisions (resolved 2026-06-24)

| Decision | Choice | Why |
| --- | --- | --- |
| Default hotkey | **`Control+Shift+Space`** (rebindable) | Plain `Ctrl+Space` is globally stolen by `globalShortcut`, breaking IME toggle + IDE IntelliSense. `Ctrl+Shift+Space` is collision-light and matches the existing `Ctrl+Shift+D` dock toggle. |
| Activation | **Toggle** (1st press start, 2nd stop) | Electron `globalShortcut` has no key-up event; true hold-to-talk needs a native hook (deferred). |
| Paste mechanism | **PowerShell `SendKeys('^v')`** + clipboard save/restore | No native module, lowest AV-false-positive surface; Unicode fidelity comes from the clipboard, not synthetic typing. |
| Pill placement | **Bottom-center, draggable, remembers position** | Handy-like; mirrors the `welcomeWindow` secondary-window pattern. |

## Components

- **`pill.html`** + Vite input + **`src/components/VoicePill.jsx`** — overlay UI with
  states: `listening` (live mic level meter), `transcribing` (spinner), `done`
  (✓ ~700 ms), `error` ("copied to clipboard"). Reuses `useMicPcm` (already built).
- **`electron-paste.js`** (main) — `insertText(text, { mode, restoreDelayMs })`:
  `mode: 'clipboard'` writes text and returns (no keystroke); `mode: 'paste'`
  saves the current clipboard, writes `text`, fires `SendKeys('^v')`, and restores
  the prior clipboard after `restoreDelayMs` (~400 ms). Single-purpose + testable.
- **Pill `BrowserWindow`** — `focusable:false, skipTaskbar:true, transparent:true,
  frame:false, alwaysOnTop`, shown via `showInactive()` so the OS foreground window
  stays the user's target app (the synthetic Ctrl+V lands there). Position persisted
  in settings.

## Flow (toggle, v1)

```
Ctrl+Shift+Space (1st) → showInactive(pill) + send 'voice:pill:start'
                          → VoicePill: useMicPcm captures PCM, meter animates
Ctrl+Shift+Space (2nd) → send 'voice:pill:stop'
                          → VoicePill finalizes PCM → invoke 'voice:pill:transcribe' {pcm,sampleRate}
                          → main resolves active provider → runTranscription (sherpa)
                          → electron-paste.insertText(text)
                          → send 'voice:pill:done' {text} (show ✓ ~700ms) → hide pill
on error                 → clipboard.writeText(text) + send 'voice:pill:error' {message}
Esc / blur               → invoke 'voice:pill:cancel' → discard PCM, hide pill
```

The hotkey is registered through the existing global-shortcut machinery
(`toggleDockShortcut` pattern in `electron-main.js`), persisted as
`voicePillShortcut`, and rebindable via `HotkeyRecorder.jsx` in Settings.

## IPC (three-place rule: handler + preload allowlist + renderer)

- **invoke:** `voice:pill:transcribe` ({pcm,sampleRate} → {ok,text}), `voice:pill:cancel`
- **push (main → pill renderer):** `voice:pill:start`, `voice:pill:stop`, `voice:pill:done`, `voice:pill:error`

## Settings (+ validators)

- `voicePillShortcut` — string accelerator, default `Control+Shift+Space`.
- `voiceInsertMode` — `'paste' | 'clipboard'`, default `'paste'`.
- `voicePillPos` — `{x,y}` remembered pill position.

## Edge cases (handled)

- **UIPI:** a non-elevated synthetic Ctrl+V silently fails to paste into
  elevated/admin windows (Windows security boundary, same as Handy). Detect where
  possible and fall back to clipboard-copy + a hint in the pill.
- **Cold start:** the first dictation after idle loads the 622 MB model; the pill
  shows a "Warming up…" state until the engine is ready.
- **Clipboard hygiene:** the prior clipboard is always restored after paste; when
  `voiceInsertMode === 'clipboard'`, no synthetic keystroke is sent at all.
- **Background-window audio:** the pill is shown via `showInactive()` (visible but
  unfocused) so Chromium does not throttle its mic capture; verify capture
  continues while another app holds focus.

## Testing

- **`electron-paste` unit:** `mode:'clipboard'` writes text + sends no keystroke;
  `mode:'paste'` saves → sets → restores the prior clipboard (assert restore).
- **Real-app harness (`verify-pill`):** drive the registered hotkey → pill window
  appears non-activating → fake-mic PCM → `voice:pill:transcribe` returns text →
  assert it auto-pastes into a focused Notepad, and that the clipboard is restored.
  Reuses the fake-audio rig from `verify-app-e2e.cjs`.
- **`/verify-build`:** the pill + auto-insert path works in the packaged `.exe`.

## Out of scope (deferred — master spec §14.1)

True hold-to-talk (native key-up hook), nut.js paste upgrade, streaming partial
results in the pill, opt-in Gemini cleanup, per-app insert profiles.
