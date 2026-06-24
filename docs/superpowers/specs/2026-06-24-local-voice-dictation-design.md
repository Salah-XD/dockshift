# DockShift Voice — Local-First Voice Dictation

> **Design + build-ready implementation plan**
> Date: 2026-06-24 · Status: **Approved design, ready to plan/implement** · Target: DockShift v0.10+
> Author: drafted with Claude Code via the brainstorming workflow

---

## 1. Summary

Replace DockShift's current low-accuracy on-device speech engine (Vosk small en-US, ~40 MB WASM) with a **local-first, offline, high-accuracy** voice-to-text system modelled on (and aiming to beat) [Handy](https://handy.computer), and add a **global push-to-talk pill** (default `Ctrl+Space`) that transcribes speech and **auto-inserts the text into whatever app is focused**.

Two surfaces share one transcription core:

1. **Voice panel** (existing `VoicePanel.jsx`) — record → review/edit → copy. Upgraded to the new local engine.
2. **Voice pill** (new) — hold `Ctrl+Space`, speak, release → text appears in the focused field. The headline UX.

Engine: **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** (ONNX runtime with prebuilt Node native binaries), running **NVIDIA Parakeet TDT 0.6B v3** (CPU, multilingual-European, auto language detect) as the default, with **Whisper** as an optional model for full multilingual coverage (incl. Hindi/CJK/Arabic).

### Goals
- Offline, no API key, no audio leaves the device (matches DockShift's privacy-first GTM).
- Accuracy and speed that meet or beat Handy on commodity Windows hardware (no GPU required).
- Handy-style global dictation: hotkey → pill → auto-insert into the active application.
- Keep the existing provider abstraction intact (no business-logic branching by provider id).

### Non-goals (v1)
- GPU acceleration (Parakeet is CPU-only; a Whisper-GPU path is a future enhancement).
- Real-time streaming partials in the panel (the pill may add a live level meter, but full streaming decode is deferred).
- macOS/Linux parity (DockShift is Windows-only in practice; design keeps the door open but does not target them now).

---

## 2. Locked decisions (from brainstorming, 2026-06-24)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Offline requirement | **Local-first** — fully offline, no API key for the great experience. |
| 2 | Pill text output | **Auto-insert into the active field** (Handy parity). |
| 3 | Inference engine | **sherpa-onnx** (Parakeet + Whisper), Node native addon, runs in main process. |
| 4 | Default model | **Parakeet TDT 0.6B v3 (int8)**; **Whisper** offered for Hindi/CJK/Arabic. |
| 5 | Vosk | **Kept as an optional ultra-light fallback** (not deleted), demoted from default. |

> Open sub-decisions still to confirm with maintainer are tracked in §13.

---

## 3. Background

### 3.1 Why the current voice is "useless"

The default STT provider is `vosk-offline` (`electron-transcription-providers.js:137`), a ~40 MB Vosk small English model run as WASM in the renderer (`VoicePanel.jsx` `startVoskRecognition`, lines 276–354). The Vosk small en-US model is the accuracy floor of modern STT and is English-only. The *plumbing* is excellent — the problem is purely the model tier.

### 3.2 What DockShift already has (assets we reuse)

- **A clean provider abstraction** — `electron-transcription-providers.js` with a registry + executor; adding a provider is "one object literal." 9 providers exist (OpenAI, Groq, Deepgram, AssemblyAI, Google, Azure, Gemini, Vosk, custom-OpenAI).
- **A first-use model downloader** with progress UI — `stt:voskModel:status|download|remove` handlers (`electron-main.js:1231–1333`), `stt:voskModel:progress` push channel, and the download/progress UI in `VoicePanel.jsx` (lines 215–250, 522–569). We generalize this to a multi-model catalog.
- **A configurable global hotkey system** — `globalShortcut` registration + `settings:hotkey:set` (`electron-main.js:~2170–2200`), plus a renderer `HotkeyRecorder.jsx`. We add a second hotkey for voice.
- **A precedent for a secondary window** — `welcomeWindow` (`electron-main.js:663`) is a separate `BrowserWindow`. The pill follows this pattern.
- **A transparent, always-on-top, click-through main window** — `createWindow()` (`electron-main.js:555–650`), `setIgnoreMouseEvents(true, { forward: true })`. Confirms overlay UX is well-trodden here.
- **Custom protocol precedent** — `vosk-model://` registered (`electron-main.js:37`) and served (`electron-main.js:2685`).

### 3.3 Handy — verified facts (the bar we're clearing)

| Aspect | Handy | Source |
|--------|-------|--------|
| License | **MIT** (we may read/adapt code w/ attribution) | [github.com/cjpais/Handy](https://github.com/cjpais/Handy) |
| Stack | **Tauri** (Rust + React/TS) | repo |
| Whisper inference | **whisper.cpp + ggml**, GPU-accelerated (Intel/AMD/NVIDIA/Apple) | [README](https://github.com/cjpais/Handy/blob/main/README.md) |
| Parakeet inference | **`transcribe-rs`** crate, Parakeet V2/V3, CPU-only, ~5× realtime on i5, auto language detect | README |
| Models | Whisper Small 487 MB / Medium 492 MB / Turbo 1.6 GB / Large 1.1 GB; Parakeet V2 473 MB / V3 478 MB | README |
| Model host | `https://blob.handy.computer/` (e.g. `ggml-small.bin`, `parakeet-v3-int8.tar.gz`) | README |
| UX | global hotkey → push-to-talk pill → types into focused field | handy.computer |

**Why we can't just copy Handy directly:** Handy embeds inference natively because it's Rust. DockShift is Electron/Node, so we need a Node-friendly engine. sherpa-onnx gives us the same model families (Parakeet + Whisper) through a prebuilt Node addon — no Rust, no compile-from-source for the ASR core.

**How we aim to beat Handy:** custom vocabulary / hotword biasing, voice editing commands, clipboard-history integration, and optional (opt-in) Gemini cleanup — see §12.

---

## 4. Engine decision & rationale

We evaluated three Electron-viable engines:

| Option | Models | Pros | Cons | Verdict |
|--------|--------|------|------|---------|
| **sherpa-onnx** (Node addon) | Parakeet, Whisper, Moonshine, SenseVoice, Zipformer | Prebuilt native binaries (no source compile); both Handy model families; CPU multilingual; runs in main, fits existing IPC | New native dep; we host/download ONNX models | **Chosen** |
| whisper.cpp server + `custom-openai` provider | Whisper only | Least new code (reuses existing provider); battle-tested; GPU optional | No Parakeet; child-server lifecycle; per-platform binaries | Fallback if sherpa spike fails |
| transformers.js (Xenova) in worker | Whisper base/small, Moonshine | Zero native modules; stays in sandbox | Low accuracy ceiling; slow w/o GPU; heavy renderer memory | Future low-end tier only |

**Sources:** sherpa-onnx provides a Node addon (`Node >= 16`) with prebuilt platform binaries and supports offline Parakeet/Whisper/Moonshine/SenseVoice/Zipformer ([npm](https://www.npmjs.com/package/sherpa-onnx), [Node addon examples](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md)). The Node API takes Float32 samples in [-1, 1] and feeds them to a stream via `stream.acceptWaveform({ sampleRate, samples })` (object form — see Appendix A), then reads the decoded `result.text`. **Confirm the exact field/arg shape against the installed version during the Phase 0 spike.**

> ⚠️ **De-risk first (Phase 0 spike):** there is an open upstream issue about `parakeet-tdt-0.6b-v2-int8` on the Node addon ([issue #2216](https://github.com/k2-fsa/sherpa-onnx/issues/2216)). Before committing the full feature, confirm Parakeet-int8 decodes correctly via the Node addon on Windows x64. If it doesn't, fall back to (a) Whisper-via-sherpa, or (b) the whisper.cpp-server option.

---

## 5. Models

All models download on first use into `userData/sttModels/<id>/`, verified by SHA-256, and are never bundled in the installer.

| Model id | Archive | Languages | Size (download) | Engine cfg | Notes |
|----------|---------|-----------|-----------------|------------|-------|
| `parakeet-v3` **(default)** | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` | 25 European (en, de, fr, es, it, pt, nl, pl, ru, uk, …) | ~620 MB | `modelType: nemo_transducer` | CPU, fast, auto-detect. **No Hindi/CJK/Arabic.** |
| `parakeet-v2` | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2` | English only | ~620 MB | `nemo_transducer` | Punctuation + casing; best EN accuracy. |
| `whisper-medium` | sherpa Whisper package (`medium`/`medium.en`) | 99 langs incl. **Hindi, Chinese, Japanese, Korean, Arabic** | ~770 MB–1.5 GB | `modelType: whisper` | The multilingual fallback for non-European languages. |
| `whisper-small` | sherpa Whisper package (`small`) | 99 langs | ~460 MB | `whisper` | Lighter multilingual option. |
| `sense-voice` *(optional, later)* | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-…` | zh, en, ja, ko, yue | ~900 MB | `modelType: sense_voice` | Strong CJK; consider for Asian-language users. |
| `vosk-en-small` *(legacy)* | existing | English | ~40 MB | renderer WASM | Demoted; ultra-light fallback. |

**Parakeet v3 archive contents** (extracted): `encoder.int8.onnx` (~622 MB), `decoder.int8.onnx` (~12 MB), `joiner.int8.onnx` (~6 MB), `tokens.txt` (~92 KB), `test_wavs/`.
**Download base:** `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/<archive>`
**Source:** [sherpa-onnx NeMo transducer models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html).

> **Language-coverage rule for the UI:** when the user selects a language that the active model can't handle (e.g. Hindi on Parakeet v3), the Voice panel/Settings prompt: "Parakeet v3 doesn't support Hindi — switch to Whisper for this language?" with a one-click model switch. We compute this from a per-model `supportedLanguages` list.

---

## 6. Architecture

### 6.1 Process map

```
┌─────────────────────────── Renderer (sandboxed) ────────────────────────────┐
│  VoicePanel.jsx        VoicePill.jsx (new, separate window)                   │
│        │                      │                                              │
│        └──── useMicPcm.js (new) — Web Audio → Float32 PCM (mono) ───┐        │
│                                                                      │        │
│  window.electronAPI.invoke / on   (preload allowlist)               │        │
└──────────────────────────────────┬──────────────────────────────────┘        │
                                    │ IPC
┌──────────────────────────────────▼──────────────────────── Main process ────┐
│  transcription:* handlers ──► runTranscription() ──► provider.transcribe()    │
│                                                          │ (localNative)      │
│                                            electron-sherpa-engine.js (new)    │
│                                                          │                    │
│                                            sherpa-onnx-node (native addon)    │
│                                                                                │
│  voice:pill:* handlers ──► pill window mgmt + electron-paste.js (new)          │
│  stt-models: download/verify/extract (electron-stt-models.js, new)             │
│  globalShortcut: dock toggle (existing) + voice hotkey (new)                   │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 The `localNative` provider tier

We extend the provider contract with a `localNative: true` flag (sibling to the existing `clientSide: true` used by Vosk). A `localNative` provider:
- is `keyless: true` (no API key),
- receives **Float32 PCM** (not webm/base64-of-container) from the renderer,
- runs its `transcribe()` in the main process by delegating to `electron-sherpa-engine.js`.

This keeps `runTranscription()`/registry generic — the executor does not branch on provider id, exactly as the file's contract demands.

```js
// electron-transcription-providers.js  (new provider, abbreviated)
const localParakeet = {
  id: 'local-parakeet',
  label: 'On-device — Parakeet (offline)',
  keyName: null,
  keyless: true,
  localNative: true,                 // NEW flag: PCM in, runs sherpa in main
  modelId: 'parakeet-v3',            // which model in the catalog
  description: 'Runs fully on your computer. No internet, no API key, no audio uploaded.',
  setupHint: 'A one-time ~620 MB model download. After that, voice works offline.',
  supportedAudioMimes: [],           // unused — PCM path
  languageHintFormat: 'iso-639-1',
  capabilities: { autoDetectLanguage: true, streaming: false, multilingual: true, timestamps: false, diarization: false },

  async transcribe({ audioBase64, sampleRate, language, signal }) {
    const { transcribePcm } = await import('./electron-sherpa-engine.js');
    const out = await transcribePcm({
      modelId: this.modelId,
      pcmFloat32Base64: audioBase64,
      sampleRate,
      language,
      signal,
    });
    return { text: out.text, detectedLanguage: out.language || null, durationMs: out.durationMs ?? null, raw: out.raw };
  },
  async testConnection() { return { ok: true, info: 'On-device — model loads locally.' }; },
};
```

### 6.3 Component inventory

| Module | New? | Process | Responsibility |
|--------|------|---------|----------------|
| `electron-sherpa-engine.js` | new | main | Lazy-load + cache `OfflineRecognizer` per model; `transcribePcm()`; warm-keep; teardown on idle/quit. |
| `electron-stt-models.js` | new | main | Model **catalog**, download (+resume), SHA-256 verify, `.tar.bz2` extract into `userData/sttModels/<id>/`, status/remove. Generalizes the Vosk-only downloader. |
| `electron-paste.js` | new | main | Auto-insert: save clipboard → set text → synthetic **Ctrl+V** → restore clipboard (delay). Mechanism: PowerShell `SendKeys('^v')` (no native dep) with optional nut.js path. |
| `electron-transcription-providers.js` | edit | main | Add `local-parakeet`, `local-whisper`; `localNative` flag; demote Vosk default. |
| `electron-main.js` | edit | main | New IPC handlers (§9); pill window; voice global hotkey; model-catalog handlers; settings keys + validators. |
| `preload.js` | edit | both | Add new channels to allowlists (§9). |
| `src/hooks/useMicPcm.js` | new | renderer | Web Audio capture → mono Float32 PCM; level meter; stop returns the buffer. Shared by panel + pill. |
| `src/components/VoicePill.jsx` | new | renderer | The pill overlay UI (idle/listening/transcribing/done/error states). |
| `src/components/VoicePanel.jsx` | edit | renderer | Use `useMicPcm` + the localNative PCM path; model picker entry point. |
| `src/components/VoiceSettings.jsx` | edit | renderer | Model picker (download/switch/remove), voice hotkey rebind, insert-mode toggle. |
| pill HTML entry | new | renderer | `pill.html` + Vite input, mirroring the welcome window's separate entry. |

---

## 7. Data flows

### 7.1 Voice panel (record → review)

1. User clicks record. `useMicPcm` starts Web Audio capture (mono Float32, native sample rate).
2. User stops. Renderer base64-encodes the Float32 buffer.
3. `invoke('transcription:transcribe', { audio, sampleRate, language, pcm: true })`.
4. Main routes to the active provider. For `local-parakeet`/`local-whisper`, `transcribe()` calls `electron-sherpa-engine.transcribePcm()`.
5. Result text returned; panel appends + offers copy. (Unchanged UX from today.)

### 7.2 Voice pill (push-to-talk, the headline)

```
hold Ctrl+Space ─► globalShortcut(down) ─► main: showInactive pill + send 'voice:pill:start'
                                            (pill window is non-activating: target app keeps focus)
        speak  ─► pill renderer: useMicPcm captures PCM + shows live level meter
release Ctrl+Space ─► globalShortcut(up)* ─► main: send 'voice:pill:stop'
                                            ─► pill renderer finalizes PCM
                                            ─► invoke 'voice:pill:transcribe' { pcm, sampleRate }
        main ─► sherpa transcribePcm ─► text ─► (optional post-processing)
             ─► electron-paste.insert(text):
                  1. const prev = clipboard.read()
                  2. clipboard.write(text)
                  3. SendKeys('^v')  → lands in the previously-focused app
                  4. setTimeout(() => clipboard.write(prev), 400ms)
             ─► send 'voice:pill:done' (show ✓ ~700ms) ─► hide pill
on error ─► clipboard.write(text) + 'voice:pill:error' (pill shows "copied to clipboard")
```

> **\*Push-to-talk key-up:** Electron's `globalShortcut` fires only on key-**down**, not key-up. Two viable approaches:
> - **(A) Toggle mode (simplest, ship first):** first `Ctrl+Space` starts, second stops. No key-up needed.
> - **(B) True hold-to-talk:** requires a low-level keyboard hook. Options: a small native module (`node-global-key-listener`) or polling. **Recommendation:** ship **(A) toggle** in v1; offer **(B) hold** as a setting once a key-up source is validated in a spike. This avoids a fragile native hook on the critical path.

### 7.3 Why focus is preserved

The pill `BrowserWindow` is created with `focusable: false, skipTaskbar: true, alwaysOnTop: true, transparent: true, frame: false` and shown via `win.showInactive()`. Because it never takes focus, the OS "foreground window" remains the user's target app, so the synthetic `Ctrl+V` pastes there.

---

## 8. Native dependencies, install & build notes

### 8.1 sherpa-onnx Node addon
- Package: **`sherpa-onnx-node`** (pulls platform binary, e.g. `sherpa-onnx-win-x64`). *Exact package name to confirm in the Phase 0 spike — both `sherpa-onnx` and `sherpa-onnx-node` exist on npm.*
- Requires **Node ≥ 16**. Uses **node-addon-api (N-API)**, ships **prebuilt** binaries → no MSVC/Python compile to install (Windows DLLs resolve automatically from `node_modules`). Unlike `node-pty`, no source build.
- ⚠️ **Electron-ABI risk is real, not theoretical.** N-API does *not* guarantee cross-runtime loading into Electron on Windows; users report "cannot find native module" loading sherpa-onnx-node inside Electron ([issue #1945](https://github.com/k2-fsa/sherpa-onnx/issues/1945), [node-addon-api #269](https://github.com/nodejs/node-addon-api/issues/269)).
  **Mitigation (now part of the design): run the engine in an Electron [`utilityProcess`](https://www.electronjs.org/docs/latest/api/utility-process) (or a forked Node child) that uses the bundled Node runtime**, not the Electron main process. This (a) sidesteps the Electron-ABI mismatch, (b) isolates the ~600 MB model memory from the UI process, and (c) contains any native crash so the dock survives. Main ↔ engine talk over `postMessage`/IPC; the `local-parakeet` provider's `transcribe()` proxies to it.
- Bundling: `asarUnpack` the native `.node` + ONNX runtime libs in electron-builder (`**/sherpa-onnx*/**`).

### 8.2 Auto-paste mechanism
- **v1 (recommended): PowerShell SendKeys** — no native module:
  ```
  powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $w.SendKeys('^v')"
  ```
  We only ever send a single `^v`; text fidelity (Unicode/emoji) comes from the clipboard, not from synthetic typing, so SendKeys reliability concerns (which affect literal text) don't apply. Lowest dependency + lowest antivirus-false-positive surface.
- **Optional upgrade: `@nut-tree-fork/nut-js`** — `keyboard.type(Key.LeftControl, Key.V)` ([docs](https://nutjs.dev/docs/keyboard)). More robust but heavier: bundles OpenCV, needs Windows Build Tools + Python + `electron-rebuild`. Gate behind a setting; not on the v1 critical path.

### 8.3 Build/dev reminders (from AGENTS.md)
- Main-process changes require a **full Electron restart** (no HMR).
- Don't claim done until `/verify-build` launches the packaged `.exe` from `release/` ([[feedback-verify-packaged-runtime]]).
- No test runner/linter exists — verification is manual (§11).

### 8.4 Engine lifecycle, memory & latency
- The Parakeet v3 encoder is **~622 MB (int8) resident in RAM** once loaded. For an always-running dock, keeping it warm forever is unacceptable.
  **Policy:** lazy-load on first dictation; keep warm for a configurable idle window (default ~5 min) then unload; the `utilityProcess` can be killed entirely to reclaim all memory.
- **First-dictation latency:** loading a 622 MB ONNX model takes a few seconds. The pill shows a "Warming up…" state on the first hotkey press after idle. Optional setting to pre-warm on app launch (trades startup RAM for instant first use).
- **Throughput target:** ≥3× realtime on a mid CPU (Parakeet claims ~5× on an i5). Validate in the Phase 0 spike.

### 8.5 Known platform constraints
- **UIPI (elevated windows):** a synthetic `Ctrl+V` from a non-elevated DockShift will **silently fail to paste into elevated/admin windows** (e.g. an admin terminal). This is a Windows security boundary, not a bug; Handy has the same limitation. Detect paste failure where possible and fall back to clipboard-copy + a hint. Document it.
- **`Ctrl+Space` hotkey conflict:** `Ctrl+Space` is widely used — IME/keyboard-layout toggle on many Windows setups, and code-completion (IntelliSense) in IDEs. `globalShortcut` **steals it globally**, breaking those. Mitigation: ship it rebindable (reuse `HotkeyRecorder.jsx`) and surface a first-run note; consider a less-conflicting default (e.g. `Ctrl+Shift+Space` or `Alt+\``) if testing shows the collision is disruptive. Decision deferred to maintainer (kept `Ctrl+Space` as requested).
- **Background-window audio:** the pill is shown via `showInactive()` (visible, unfocused) so Chromium does not throttle its audio capture; verify mic capture continues while another app holds focus (spike checklist).

### 8.6 Licensing (clear for OSS + future commercial)
- **Parakeet TDT 0.6B v3:** **CC-BY-4.0** — commercial use and redistribution explicitly permitted, **requires attribution to NVIDIA** ([model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)). Add an attribution line in About/credits.
- **sherpa-onnx:** Apache-2.0. **Whisper:** MIT. **Vosk model:** Apache-2.0. All compatible with DockShift's OSS-now / monetize-later GTM. (We download models at runtime rather than bundling, which also keeps the installer license-clean.)

---

## 9. IPC surface — the three-place rule

Every channel below must be added in **all three** places: `ipcMain.handle` (main), the `allowed`/`allowedSendChannels` array (`preload.js`), and the renderer caller. (The PostToolUse hook `scripts/hooks/check-ipc-sync.mjs` will warn on drift.)

### New `invoke` channels (add to `preload.js` `allowed[]`)
```
// Local STT model catalog (generalizes stt:voskModel:*)
'stt:models:list'        // → [{ id, label, sizeBytes, installed, languages, engine }]
'stt:model:download'     // { id } → starts download; progress via push
'stt:model:remove'       // { id } → unlink model dir
'stt:model:active:set'   // { id } → settings.sttModel
// Voice pill
'voice:pill:transcribe'  // { pcm, sampleRate } → { ok, text }
'voice:pill:cancel'      // user dismissed the pill
'voice:settings:get'     // { hotkey, insertMode, holdToTalk }
'voice:hotkey:set'       // { accelerator } → re-register globalShortcut
```

### New push channels (main → renderer, via `webContents.send`; consumed by `electronAPI.on`)
```
'stt:model:progress'   // { id, phase, downloaded, total }   (mirror of stt:voskModel:progress)
'voice:pill:start'     // pill renderer: begin capture
'voice:pill:stop'      // pill renderer: finalize capture
'voice:pill:done'      // { text }  → show ✓
'voice:pill:error'     // { message }
```

### New settings keys + validators (`electron-main.js` ~1660)
```js
sttModel:        (v) => (typeof v === 'string' && v.length <= 48 ? v : undefined),
voiceHotkey:     (v) => (typeof v === 'string' && v.length <= 64 ? v : undefined),  // default 'CommandOrControl+Space'
voiceInsertMode: (v) => (['paste','clipboard'].includes(v) ? v : undefined),       // default 'paste'
voiceHoldToTalk: (v) => (typeof v === 'boolean' ? v : undefined),                  // default false (toggle mode)
```

### Reused/extended
- `transcription:transcribe` gains optional `{ sampleRate, pcm: true }` for the localNative path (back-compat: cloud providers still send `{ audio, mimeType }`).
- The existing `stt:voskModel:*` handlers remain for the legacy Vosk model; new models go through `stt:model:*`.

---

## 10. Security & privacy

- **No audio leaves the device** for local providers — surfaced prominently in the pill and Settings (marketing win; aligns with GTM).
- **Model integrity:** pin download URLs + verify **SHA-256** before extract (matches the recent `security audit` commit posture). Reject on mismatch; never execute downloaded content.
- **Clipboard hygiene:** auto-paste saves and **restores** the prior clipboard contents after paste (configurable delay ~400 ms). If `insertMode === 'clipboard'`, we skip the synthetic keystroke entirely.
- **Preserve existing invariants** (AGENTS.md): don't loosen `TerminalManager` cwd/metachar checks; keep Gemini key in main; keep `webview` partition isolation. The optional Gemini-cleanup feature (§12) reuses `ai:chat` in main — the key never reaches the renderer.
- **`asarUnpack`** only the native ASR binaries; no broad unpacking.

---

## 11. Verification plan (manual — no test runner)

Phase 0 spike script — **✅ PASSED 2026-06-24** (scripts at `scripts/spikes/voice-engine/`):
- [x] Install `sherpa-onnx-node`; confirm prebuilt Windows binary loads. — `sherpa-onnx-node@1.13.3` + prebuilt `sherpa-onnx-win-x64`, **no compile**.
- [x] Load Parakeet v3 int8; transcribe a known WAV; assert non-empty, correct text. — en/es/de/fr all correct.
- [x] Confirm it runs under the **Electron** runtime (ABI), not just plain Node. — loads + decodes under **Electron 42.2.0 (Node 24, ABI 146)**; issues #1945 and #2216 did **not** reproduce.
- [x] Measure latency on a mid CPU (target ≥3× realtime). — **16–23× realtime** (RTF ~0.05), model build ~1.9 s.

> **⚠️ Electron gotcha found in the spike (now a hard rule):** `sherpa.readWave()` throws *"External buffers are not allowed"* under Electron — V8 rejects the external ArrayBuffer the native addon returns. The app is unaffected because PCM arrives from the renderer as a normal V8-owned `Float32Array`. **Rule: never call `readWave` in the Electron engine process — only feed JS-owned Float32 PCM.** This also means the engine must build its input `Float32Array` carefully (alignment-safe; see Appendix A).

Feature verification via `/verify-build` (packaged `.exe` from `release/`):
- [ ] First-run model download shows progress, verifies checksum, extracts.
- [ ] Voice panel transcribes accurately (EN + one European lang).
- [ ] Hindi prompt → "switch to Whisper" flow works; Whisper model transcribes Hindi.
- [ ] `Ctrl+Space` opens the pill **without** stealing focus (target app caret stays).
- [ ] Speak → release/toggle → text **auto-pastes** into Notepad, VS Code, a browser field, and a chat app.
- [ ] Clipboard contents are **restored** after paste.
- [ ] Error path (model missing / engine fail) falls back to clipboard-copy with a clear message.
- [ ] Hotkey rebinding (via `HotkeyRecorder`) re-registers and persists.
- [ ] IPC-sync hook reports no missing channels.

---

## 12. Differentiators — out-shine Handy (phased)

Picked for v1 vs deferred:

| Idea | Effort | When | Notes |
|------|--------|------|-------|
| **Custom vocabulary / hotword biasing** | M | **v1.1** | sherpa supports contextual/hotword biasing — names, jargon, product terms. Big accuracy win Handy lacks. |
| **Dictation → clipboard history integration** | S | **v1** | Every dictation auto-lands in DockShift's clipboard manager. Near-free; uses existing store. |
| Voice editing commands ("new line", "scratch that", "comma") | M | v1.2 | Post-process transcript with a small command grammar. |
| Optional Gemini cleanup (punctuate/tidy) | S | v1.2 | **Opt-in only** (breaks pure-offline). Reuses `ai:chat`. |
| Per-app profiles (lang/format by focused app) | M | later | Detect foreground exe; map to model/lang/format. |
| Streaming partials in the pill | L | later | sherpa streaming (Zipformer) for live text while speaking. |

---

## 13. Open questions / to confirm with maintainer

1. ✅ **RESOLVED (2026-06-24):** Parakeet v3 is the default. Hindi/CJK/Arabic are **not** required at launch — they're available as an **optional Whisper download**, not a blocker. No India-first default needed for v1.
2. **Push-to-talk vs toggle in v1:** confirm shipping **toggle** first (no native key-up hook), hold-to-talk later.
3. **nut.js vs SendKeys:** confirm **SendKeys** for v1 auto-paste (no native compile), nut.js as opt-in later.
4. **Disk budget:** ~620 MB (Parakeet) or up to ~1.5 GB (Whisper-medium) per model — acceptable for the target user? Cap installed models / offer remove UI (already planned).
5. **Pill placement:** bottom-center (Handy-like) vs anchored near the dock? Default proposal: bottom-center, draggable, remembers position.

---

## 14. Phased implementation plan (build order)

### Phase 0 — Engine spike (de-risk) — *blocking* — ✅ **DONE 2026-06-24**
- Standalone script: `sherpa-onnx-node` + Parakeet v3 int8 transcribes a WAV under Electron's ABI on Windows x64. → `scripts/spikes/voice-engine/`.
- Decision gate: **✅ proceed with sherpa** (en/es/de/fr correct, 16–23× realtime under Electron 42). whisper.cpp-server fallback not needed.

### Phase 1 — Local engine in the Voice panel (kills "useless model")
1. `electron-stt-models.js` — catalog + download/verify/extract; `stt:models:*` handlers; generalize progress channel.
2. ✅ **DONE** `electron-sherpa-engine.js` — `transcribePcm()`, warm per-model cache, idle teardown. Verified end-to-end under Electron 42 via `scripts/spikes/voice-engine/verify-engine.mjs` (cold build 2.3 s → warm 0 ms; en/es/fr correct). `sherpa-onnx-node@1.13.3` added to `dependencies`.
3. Add `local-parakeet` + `local-whisper` providers; `localNative` flag; demote Vosk default → `DEFAULT_TRANSCRIPTION_PROVIDER_ID = 'local-parakeet'`.
4. `useMicPcm.js`; wire `VoicePanel.jsx` to the PCM path; `transcription:transcribe` accepts `{ pcm, sampleRate }`.
5. `VoiceSettings.jsx` model picker (download/switch/remove) + language-coverage prompt.
6. preload allowlist + settings validators.
7. `/verify-build` for panel transcription.

### Phase 2 — The Ctrl+Space pill (headline UX)
1. Pill window (`focusable:false`, `showInactive`) + `pill.html` Vite entry; `VoicePill.jsx`.
2. Register voice `globalShortcut` (default `CommandOrControl+Space`); `voice:pill:*` handlers; toggle mode.
3. `electron-paste.js` (SendKeys `^v` + clipboard save/restore); `voiceInsertMode` setting.
4. Hotkey rebind UI in `VoiceSettings.jsx`; persist `voiceHotkey`.
5. `/verify-build` for the full pill + auto-insert matrix (§11).

### Phase 3 — Differentiators
- v1: clipboard-history integration.
- v1.1: hotword biasing. v1.2: voice commands, opt-in Gemini cleanup.

---

## 14.1 Deferred enhancements — do not forget

These are intentionally **out of v1 scope** but should not be lost. Tracked here and in persistent memory (`dockshift-voice-dictation`).

| Deferred item | Why deferred | Revisit when |
|---|---|---|
| **True hold-to-talk** (press-and-hold `Ctrl+Space`) | Electron `globalShortcut` has no key-up event; needs a native keyboard hook. v1 ships **toggle** mode. | After validating a key-up source (`node-global-key-listener`) in a spike. |
| **nut.js auto-paste** | v1 uses dependency-free PowerShell `SendKeys('^v')`. nut.js is more robust but heavy (OpenCV, build tools). | If SendKeys proves unreliable in the field; ship as opt-in. |
| **GPU acceleration / Whisper-GPU path** | Parakeet is CPU-only and fast enough; GPU packaging on Windows is fiddly. | When users with strong GPUs want max Whisper-large accuracy. |
| **Streaming partial results in the pill** | Adds live decode complexity (Zipformer streaming). v1 does post-hoc decode. | Once core path is stable; big perceived-latency win. |
| **SenseVoice model (CJK)** + broader Whisper multilingual incl. **Hindi** | Parakeet v3 = 25 European langs only; Hindi/CJK/Arabic deferred per maintainer (2026-06-24). | When Asian-language / Hindi demand appears. |
| **Custom vocabulary / hotword biasing** | sherpa supports it; not needed for MVP. | v1.1 — high-value accuracy differentiator over Handy. |
| **Voice editing commands** ("new line", "scratch that") | Post-processing grammar; not MVP. | v1.2. |
| **Opt-in Gemini cleanup** (punctuate/tidy) | Breaks pure-offline; must be explicit opt-in. | v1.2. |
| **Per-app profiles** (lang/format by focused app) | Needs foreground-exe detection + mapping UI. | Later. |
| **Silero VAD** (auto-stop on silence) | Toggle/hold covers MVP stop. | If users want hands-free auto-stop. |
| **Pre-warm engine on launch** | Trades startup RAM for instant first dictation. | Expose as a setting once memory policy lands. |
| **Safer default hotkey than `Ctrl+Space`** | Kept `Ctrl+Space` per maintainer; it conflicts with IME/IntelliSense. | If field testing shows the collision is disruptive. |

## 15. Sources

- Handy — site: https://handy.computer · repo (MIT): https://github.com/cjpais/Handy · README: https://github.com/cjpais/Handy/blob/main/README.md
- sherpa-onnx — repo: https://github.com/k2-fsa/sherpa-onnx · npm: https://www.npmjs.com/package/sherpa-onnx · Node addon examples: https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md
- Parakeet/NeMo models for sherpa-onnx: https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html
- sherpa-onnx Node Parakeet-int8 issue (spike reference): https://github.com/k2-fsa/sherpa-onnx/issues/2216
- nut.js keyboard docs: https://nutjs.dev/docs/keyboard · fork: https://www.npmjs.com/package/@nut-tree-fork/nut-js
- Parakeet TDT 0.6B v3 (NVIDIA, multilingual EU) background: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- DockShift internal: `AGENTS.md`, `electron-transcription-providers.js`, `src/components/VoicePanel.jsx`, `electron-main.js` (model/hotkey/window handlers), `preload.js`.

---

## Appendix A — sherpa-onnx OfflineRecognizer config sketch

```js
// electron-sherpa-engine.js (sketch — confirm exact field names against installed version)
import sherpa from 'sherpa-onnx-node';

function parakeetConfig(dir, numThreads) {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: `${dir}/encoder.int8.onnx`,
        decoder: `${dir}/decoder.int8.onnx`,
        joiner:  `${dir}/joiner.int8.onnx`,
      },
      tokens: `${dir}/tokens.txt`,
      modelType: 'nemo_transducer',
      numThreads,
      debug: false,
    },
    decodingMethod: 'greedy_search',
  };
}

function whisperConfig(dir, numThreads) {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: `${dir}/encoder.onnx`, decoder: `${dir}/decoder.onnx` },
      tokens: `${dir}/tokens.txt`,
      modelType: 'whisper',
      numThreads,
    },
    decodingMethod: 'greedy_search',
  };
}

let recognizers = new Map(); // modelId -> OfflineRecognizer (warm cache)

export async function transcribePcm({ modelId, pcmFloat32Base64, sampleRate }) {
  const rec = getOrCreateRecognizer(modelId);          // builds from catalog dir
  // NEVER use sherpa.readWave() here — it returns an EXTERNAL ArrayBuffer that
  // Electron's V8 rejects ("External buffers are not allowed"). Feed a JS-owned
  // Float32Array instead. Also: Buffer.from(base64).buffer can be a POOLED,
  // mis-aligned ArrayBuffer, so slice out exactly our bytes into a fresh, 4-byte-
  // aligned ArrayBuffer before viewing it as Float32. (Better still: send the PCM
  // over IPC as a transferable Float32Array/ArrayBuffer and skip base64 entirely.)
  const buf = Buffer.from(pcmFloat32Base64, 'base64');
  const aligned = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const samples = new Float32Array(aligned);
  const stream = rec.createStream();
  stream.acceptWaveform({ sampleRate, samples });      // sherpa resamples to 16k
  rec.decode(stream);
  const r = rec.getResult(stream);
  return { text: (r.text || '').trim(), language: r.lang || null, raw: r };
}
```

## Appendix B — pill window creation sketch

```js
// electron-main.js (sketch)
function createPillWindow() {
  pillWindow = new BrowserWindow({
    width: 280, height: 72,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false,  // never steals focus
    show: false,
    webPreferences: { preload: PRELOAD_PATH, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  pillWindow.setAlwaysOnTop(true, 'screen-saver');
  pillWindow.loadURL(isDev ? `${VITE}/pill.html` : pathToFileURL(`${DIST}/pill.html`).href);
}
function showPill() { positionBottomCenter(pillWindow); pillWindow.showInactive(); }
```

## Appendix C — auto-paste sketch

```js
// electron-paste.js (sketch)
import { clipboard } from 'electron';
import { execFile } from 'node:child_process';

export async function insertText(text, { mode = 'paste', restoreDelayMs = 400 } = {}) {
  if (mode === 'clipboard') { clipboard.writeText(text); return { pasted: false }; }
  const prev = clipboard.readText();
  clipboard.writeText(text);
  await sendCtrlV();
  setTimeout(() => { try { clipboard.writeText(prev); } catch {} }, restoreDelayMs);
  return { pasted: true };
}

function sendCtrlV() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile','-Command',
      "$w=New-Object -ComObject WScript.Shell; $w.SendKeys('^v')"],
      () => resolve());
  });
}
```
