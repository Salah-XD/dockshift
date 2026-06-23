/*
 * Phase 0 spike — Electron ABI check (see sherpa-spike.cjs and the design spec §8.1).
 *
 * Run:  npx electron scripts/spikes/electron-abi-check.cjs
 *
 * This loads sherpa-onnx-node *inside the Electron runtime* and runs the same
 * transcription as the plain-Node spike. The open question (issue #1945) is whether
 * the prebuilt native addon loads under Electron's ABI on Windows.
 *
 *   - If this PASSES: we can call the engine from the main process directly.
 *   - If require() FAILS here but the plain-Node spike PASSES: we run the engine in an
 *     Electron utilityProcess / forked Node child (which uses the bundled Node ABI),
 *     exactly as the spec already plans. Either outcome is a clean decision.
 */
'use strict';

const { app } = require('electron');

app.whenReady().then(() => {
  try {
    // sherpa-spike.cjs runs its main() on require.
    require('./sherpa-spike.cjs');
    console.log('[spike] Electron ABI: ✅ sherpa-onnx-node loaded and ran inside Electron.');
    app.quit();
  } catch (e) {
    console.error('[spike] Electron ABI: ❌', e && e.message ? e.message : e);
    console.error('[spike] → Plan B per spec §8.1: run the engine in a utilityProcess / forked Node child.');
    app.exit(1);
  }
});
