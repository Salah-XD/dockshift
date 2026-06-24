# Retire Vosk, migrate everyone to on-device Parakeet

**Date:** 2026-06-24
**Branch:** `feat/voice-dictation-spec`
**Status:** design approved
**Relates to:** [`2026-06-24-local-voice-dictation-design.md`](./2026-06-24-local-voice-dictation-design.md)

## Problem

The voice initiative replaced the "useless" default on-device engine (Vosk small
en-US WASM) with on-device Parakeet (sherpa-onnx), and flipped
`DEFAULT_TRANSCRIPTION_PROVIDER_ID` to `local-parakeet`. But the active provider
is resolved as `settings.sttProvider || DEFAULT`, so the flip **only affects
profiles that have no `sttProvider` saved at all.**

Any existing user who already had a voice provider persisted keeps their old
value. A profile with `sttProvider: "vosk-offline"` therefore stays on Vosk
forever, even after the upgrade — the Parakeet model may download (e.g. via the
welcome auto-download) and sit installed-but-unused while the app runs the old
Vosk path. Symptom observed: a healthy 600 MB Parakeet model on disk
(`sttModels/parakeet-v3/` with `.ready.json` + all `.onnx` files), but the Voice
panel stuck on Vosk's "Loading speech model…" screen, because
`settings.sttProvider === "vosk-offline"`.

This defeats the entire point of the initiative for the existing user base.

## Decision

**Migrate everyone off Vosk and fully retire it.** Vosk is dropped as a provider
choice; legacy users are moved to on-device Parakeet (the new default), which
auto-downloads on first voice use via the existing `localNative` path.

(Decision made via brainstorming on 2026-06-24: "Migrate everyone + retire Vosk",
"Full removal".)

## Design

### 1. One-time migration (the bug fix)

Runs at the **top of `app.on('ready')`** in `electron-main.js`, before the
welcome-vs-dock decision and before any renderer queries the provider:

```js
// One-time: the legacy on-device Vosk engine was replaced by on-device Parakeet.
// Move anyone still pointed at it onto the new default and reclaim its model file.
function migrateVoskToParakeet() {
  const s = readSettings();
  if (s.sttProvider !== 'vosk-offline') return;
  writeJsonAtomic(settingsFile(), { ...s, sttProvider: DEFAULT_TRANSCRIPTION_PROVIDER_ID });
  try {
    fs.rmSync(path.join(app.getPath('userData'), 'voskModels'), { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }
}
```

**No migration version flag.** The trigger is the exact string `'vosk-offline'`,
which the migration overwrites — so it is self-limiting and idempotent. And
because `voskOffline` is removed from the registry,
`getActiveSttProvider()` / `transcription:providers` already fall back to the
default for any unknown id, so runtime resolution is correct even if the persisted
write never happened. The migration's role is to make `settings.json` honest and
reclaim the ~40 MB Vosk archive.

### 2. Full removal of Vosk

| File | Remove |
| --- | --- |
| `electron-transcription-providers.js` | `voskOffline` object + its registry entry |
| `electron-main.js` | `stt:voskModel:{status,download,remove}` handlers; `voskModelsDir`/`voskModelPath`/`ensureVoskDir`; `VOSK_MODELS`; the `vosk-model` privileged-scheme registration; the `protocol.handle('vosk-model', …)` block |
| `preload.js` | the 3 `stt:voskModel:*` invoke-allowlist entries |
| `src/components/VoicePanel.jsx` | the entire `clientSide` path — `loadVoskModel`, `startVoskRecognition`, `stopVoskPipeline`, all Vosk refs/state, the two `stt:voskModel:*` effects, `handleDownloadModel`, and every `isClientSide` branch |
| `package.json` | drop `vosk-browser` (uninstall + sync lockfile) |
| `index.html` | remove `vosk-model:` from `img-src`/`connect-src`; remove `wasm-unsafe-eval` from `script-src` (verified: nothing else in `src/` uses WASM) |

With Vosk gone, `isClientSide` is always false; on-device collapses to the single
`localNative` (sherpa) tier. Cloud providers' MediaRecorder → IPC path is
untouched.

### 3. Behavior after

- **Existing Vosk users** → silently land on Parakeet. First Voice-panel open
  triggers the existing `localNative` auto-download (600 MB). Accepted tradeoff.
- **New users** → unchanged (welcome already defaults to Parakeet + auto-downloads).
- **The reporting machine** → fixed on next launch; its Parakeet model is already
  installed, so voice works immediately with no re-download.

## Testing

- **`verify-migration` (new):** seed a throwaway `--user-data-dir` with
  `settings.json` `{ sttProvider: 'vosk-offline' }` + a dummy `voskModels/…` file,
  run `migrateVoskToParakeet()`, assert `sttProvider === 'local-parakeet'` and the
  `voskModels` dir is gone. Also assert a non-Vosk profile is left untouched.
- **`verify-app-e2e.cjs` (regress, 6/6):** the `localNative` record→PCM→transcript
  path still works after the VoicePanel surgery; also catches CSP/boot breakage.
- **`verify-app-ui.cjs` (regress, 4/4):** the panel mounts + renders the record
  control under the tightened CSP.
- **Manual:** `npm run dev`, confirm the renderer loads under the new CSP and
  Parakeet records end to end.

## Out of scope (separate follow-ups)

- `/verify-build` packaging gate (electron-builder + `asarUnpack` sherpa addon).
- Whisper enablement (pin checksums + verify the whisper engine path).
- Phase 2 (Ctrl+Space pill) — not started.
