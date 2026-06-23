# Phase 0 spike — DockShift Voice (sherpa-onnx / Parakeet v3)

This is a **throwaway de-risking spike**, not shipped code. It answers the single
go/no-go question behind the [Local-First Voice Dictation design](../../docs/superpowers/specs/2026-06-24-local-voice-dictation-design.md):

> Does `sherpa-onnx-node` **load and decode** Parakeet TDT 0.6B v3 (int8) on Windows,
> under both plain Node and the Electron runtime?

If yes → proceed with sherpa-onnx as the engine.
If the Electron load fails → run the engine in a `utilityProcess` / forked Node child (spec §8.1).
If it fails entirely → fall back to whisper.cpp-server + the existing `custom-openai` provider.

## Prereqs

- Windows 10/11 (ships `curl` and `tar`/bsdtar, which handle the download + `.tar.bz2`).
- Node ≥ 18 and the project's Electron (already a devDependency).
- One-time native dep install (confirm the exact package name — both `sherpa-onnx-node` and `sherpa-onnx` exist on npm):

```sh
npm install sherpa-onnx-node
```

## Run it

```sh
# 1) Plain Node — downloads the model (~600 MB, once), then transcribes a bundled test clip.
node scripts/spikes/sherpa-spike.cjs

# 2) Electron runtime — the ABI question. Reuses the model already downloaded in step 1.
npx electron scripts/spikes/electron-abi-check.cjs
```

## Success criteria

- [ ] `sherpa-onnx-node` loads in **plain Node**.
- [ ] `sherpa-onnx-node` loads in **Electron** (or we confirm we must use a utilityProcess/child).
- [ ] Transcript of `test_wavs/0.wav` is **non-empty and correct**.
- [ ] Throughput is **≥ 3× realtime** on the target CPU (Parakeet claims ~5× on an i5).
- [ ] Note model **load time** (informs the warm/idle-unload policy in spec §8.4).

## What to report back

Paste the `[spike] ...` output from both runs — especially the `runtime:` line, the
`transcript:`, the `×realtime` figure, and whether the Electron run loaded the module.

## Cleanup

The downloaded model is cached (and git-ignored) under `scripts/spikes/.spike-cache/`
(~600 MB). Delete it when done:

```sh
rm -rf scripts/spikes/.spike-cache
```
