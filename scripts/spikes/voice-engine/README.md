# Phase 0 spike — local voice engine (sherpa-onnx + Parakeet v3 int8)

De-risk script for the design at
[`docs/superpowers/specs/2026-06-24-local-voice-dictation-design.md`](../../../docs/superpowers/specs/2026-06-24-local-voice-dictation-design.md).
It answers the **go/no-go gate**: does `sherpa-onnx-node` load and decode Parakeet v3
int8 under **plain Node *and* the project's Electron runtime** on Windows x64?

## Result (2026-06-24) — ✅ GREEN LIGHT

Run against Electron 42.2.0 (Node 24, ABI 146) and plain Node 22 (ABI 127):

| Check | Result |
|-------|--------|
| Prebuilt `sherpa-onnx-win-x64` binary installs (no compile) | ✅ |
| Loads under plain Node (ABI 127) — `node-load-test.cjs` | ✅ |
| Loads under Electron 42 (ABI 146) — `electron-load-test.cjs`, issue #1945 | ✅ |
| Parakeet v3 int8 builds + decodes under Electron — issue #2216 | ✅ ~1.9s build |
| en/es/de/fr test WAVs transcribe correctly | ✅ |
| Latency on this CPU | ✅ 16–23× realtime (RTF ~0.05; target ≥3×) |

### Gotcha found (folded into the design)
`sherpa.readWave()` throws **"External buffers are not allowed"** under Electron — V8
rejects the external ArrayBuffer the native addon returns. The real app is unaffected:
PCM arrives from the renderer's Web Audio as a normal V8-owned `Float32Array`. Rule:
**never call `readWave` in the Electron engine process — feed JS-owned Float32 PCM.**
`transcribe-js-pcm.cjs` parses the WAV in pure JS to mirror the production data path.

## Reproduce

```bash
cd scripts/spikes/voice-engine
npm install                       # pulls sherpa-onnx-node + sherpa-onnx-win-x64 (prebuilt)

# Stage A — does the native binary load?
node node-load-test.cjs                                   # plain Node
../../../node_modules/electron/dist/electron.exe electron-load-test.cjs   # Electron ABI

# Stage B — download Parakeet v3 int8 (~464 MB) and decode a known WAV
curl -L -o parakeet-v3.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2
tar -xf parakeet-v3.tar.bz2
MODEL_DIR=./sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 \
  WAV_PATH=./sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/test_wavs/en.wav \
  ../../../node_modules/electron/dist/electron.exe transcribe-js-pcm.cjs
```

(`node_modules/`, the archive, the extracted model dir, `*-result.json`, and `*.png` are git-ignored.)

## Module + app verification harnesses

Beyond the Phase 0 spike, these drive the real modules / app (run with the project's `electron.exe`, except the e2e/ui which use Node + Playwright):

| Harness | Verifies |
|---------|----------|
| `verify-engine.mjs` | `electron-sherpa-engine.js` — warm cache (cold→warm), multilingual decode |
| `verify-catalog.mjs` | `electron-stt-models.js` — SHA-256 verify, atomic extract, catalog→engine, real download |
| `verify-provider.mjs` | `local-parakeet` provider through the real `runTranscription` executor |
| `verify-modelswitch.mjs` | `settings.sttModel` → provider `modelId` override + same-family guard (Parakeet v3↔v2) |
| `verify-migration.mjs` | `electron-stt-migration.js` — legacy `vosk-offline` → `local-parakeet` flip + model cleanup (plain Node, no Electron) |
| `verify-app-e2e.cjs` | **Running app**: real IPC (`stt:models:*`, `transcription:transcribe` PCM) + **fake-mic** capture → transcript |
| `verify-app-ui.cjs` | **Running app**: the `VoicePanel` React component mounts + renders the record control |
| `verify-welcome.cjs` | **Running app**: welcome "Voice engine" step (model cards + accuracy/speed bars), default-provider flip, and `welcome:complete` persistence |

The harnesses junction the already-extracted models into a fresh throwaway `--user-data-dir`
(no 640 MB copies). Result (2026-06-24): modelswitch **4/4**, migration **8/8**, welcome **10/10**, e2e **6/6**, ui **4/4**.

`verify-migration.mjs` runs with plain `node` (no Electron) since the migration takes a
`userDataDir` argument; the Vosk→Parakeet retirement was additionally confirmed on a real
app boot (a seeded `vosk-offline` profile flips to `local-parakeet` on `app.on('ready')`).

The two app harnesses need `npm install playwright` (no-save) and the Vite dev server
(`npm run dev:vite`); they launch DockShift with Chromium's fake-audio device fed from a WAV:

```bash
npm install playwright --no-save          # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm run dev:vite &                         # renderer on :5173
MODEL_SRC=<extracted model> WAV=<en.wav> TEST_UD=<temp> node verify-app-e2e.cjs
TEST_UD=<same temp> WAV=<en.wav> node verify-app-ui.cjs
```

Result (2026-06-24): e2e **6/6** (incl. fake-mic 48 kHz → correct transcript), ui **4/4**.
