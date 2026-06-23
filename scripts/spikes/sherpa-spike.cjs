#!/usr/bin/env node
/*
 * Phase 0 spike — DockShift Voice (see ../../docs/superpowers/specs/2026-06-24-local-voice-dictation-design.md)
 *
 * Goal: prove that `sherpa-onnx-node` LOADS and DECODES NVIDIA Parakeet TDT 0.6B v3 (int8)
 *       on this machine, before we commit to the full feature. This is the go/no-go gate.
 *
 * Run under plain Node:   node scripts/spikes/sherpa-spike.cjs
 * Run under Electron:     npx electron scripts/spikes/electron-abi-check.cjs
 *
 * CommonJS (.cjs) on purpose: sherpa-onnx-node is a CJS native addon, and .cjs is
 * unaffected by the project's "type": "module".
 *
 * NOTE: API field names below follow the documented sherpa-onnx Node API
 * (https://k2-fsa.github.io/sherpa/onnx/javascript-api/index.html). If the installed
 * version differs, adjust here — that mismatch is itself a useful spike finding.
 *
 * Prereqs (Windows 10/11 ship curl + tar):
 *   npm install sherpa-onnx-node     # confirm exact package name; pulls the prebuilt binary
 *
 * Cleanup when done: delete scripts/spikes/.spike-cache  (~600 MB model)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const MODEL_ID = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
const ARCHIVE = `${MODEL_ID}.tar.bz2`;
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${ARCHIVE}`;
const CACHE = path.join(__dirname, '.spike-cache');
const MODEL_DIR = path.join(CACHE, MODEL_ID);
const ENCODER = path.join(MODEL_DIR, 'encoder.int8.onnx');

function log(...a) { console.log('[spike]', ...a); }

function ensureModel() {
  fs.mkdirSync(CACHE, { recursive: true });
  if (fs.existsSync(ENCODER)) { log('model already present'); return; }

  const archivePath = path.join(CACHE, ARCHIVE);
  if (!fs.existsSync(archivePath)) {
    log(`downloading ${ARCHIVE} (~600 MB, one time) ...`);
    // curl -L follows GitHub's redirect to the release object store.
    execFileSync('curl', ['-L', '--fail', '--retry', '3', '-o', archivePath, URL], { stdio: 'inherit' });
  }
  log('extracting (bsdtar auto-detects bz2) ...');
  execFileSync('tar', ['-xf', archivePath, '-C', CACHE], { stdio: 'inherit' });
  if (!fs.existsSync(ENCODER)) {
    throw new Error(`extraction did not produce ${ENCODER} — inspect ${CACHE}`);
  }
}

function loadModule() {
  try {
    return require('sherpa-onnx-node');
  } catch (e) {
    console.error('\n[spike] ❌ FAILED to load sherpa-onnx-node.');
    console.error('[spike]    If not installed:  npm install sherpa-onnx-node');
    console.error('[spike]    If it loads under plain Node but FAILS here under Electron, that IS the');
    console.error('[spike]    ABI finding from spec §8.1 → run the engine in a utilityProcess/forked Node child.');
    throw e;
  }
}

function buildRecognizer(sherpa) {
  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: ENCODER,
        decoder: path.join(MODEL_DIR, 'decoder.int8.onnx'),
        joiner: path.join(MODEL_DIR, 'joiner.int8.onnx'),
      },
      tokens: path.join(MODEL_DIR, 'tokens.txt'),
      numThreads: Math.max(1, Math.min(4, os.cpus().length)),
      provider: 'cpu',
      modelType: 'nemo_transducer',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  };
  return new sherpa.OfflineRecognizer(config);
}

function main() {
  const runtime = process.versions.electron
    ? `Electron ${process.versions.electron}`
    : `Node ${process.versions.node}`;
  log(`runtime: ${runtime}  (NODE_MODULE_VERSION ${process.versions.modules}, ${os.arch()})`);

  ensureModel();

  const sherpa = loadModule();
  log('module loaded ✓');

  const tLoad = Date.now();
  const recognizer = buildRecognizer(sherpa);
  log(`recognizer built ✓ (model load ${((Date.now() - tLoad) / 1000).toFixed(2)}s)`);

  // Each model archive ships sample clips under test_wavs/.
  const wavPath = path.join(MODEL_DIR, 'test_wavs', '0.wav');
  const wave = sherpa.readWave(wavPath); // -> { samples: Float32Array, sampleRate: number }
  const durationSec = wave.samples.length / wave.sampleRate;

  const t0 = Date.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  const elapsed = (Date.now() - t0) / 1000;

  log('─'.repeat(48));
  log('transcript:', JSON.stringify(result.text));
  log(`audio ${durationSec.toFixed(2)}s · decoded ${elapsed.toFixed(2)}s · ${(durationSec / elapsed).toFixed(1)}× realtime`);
  log('─'.repeat(48));

  const ok = !!(result.text && result.text.trim());
  if (!ok) {
    log('RESULT: ⚠️  empty transcript — engine loaded but decode produced nothing. Investigate.');
    process.exitCode = 2;
  } else if (durationSec / elapsed < 3) {
    log('RESULT: ✅ works, but < 3× realtime on this CPU — note the speed before relying on it.');
  } else {
    log('RESULT: ✅ PASS — loads, decodes, and is fast enough.');
  }
}

main();
