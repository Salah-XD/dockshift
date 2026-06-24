/**
 * Local speech-to-text engine — sherpa-onnx (ONNX runtime, prebuilt Node addon).
 *
 * Runs in the MAIN process and is the back-end for the `localNative` transcription
 * providers (Parakeet / Whisper) defined in `electron-transcription-providers.js`.
 * Those providers call `transcribePcm()` and get back text; they never touch sherpa
 * directly, keeping the provider registry generic.
 *
 * Phase 0 spike (2026-06-24, `scripts/spikes/voice-engine/`) proved this loads and
 * decodes Parakeet v3 int8 under Electron 42 (Node 24 / ABI 146) at 16–23× realtime.
 *
 * ── Hard rules learned from the spike ────────────────────────────────────────
 *  1. NEVER call `sherpa.readWave()` here. Under Electron, native addons returning
 *     an *external* ArrayBuffer trip V8's "External buffers are not allowed". We only
 *     ever feed JS-owned Float32 PCM (which the renderer's Web Audio already produces).
 *  2. `Buffer.from(base64).buffer` can be a pooled, mis-aligned ArrayBuffer — slice
 *     out exactly our bytes into a fresh, 4-byte-aligned buffer before the Float32 view.
 *
 * ── Memory / lifecycle (§8.4) ────────────────────────────────────────────────
 *  The Parakeet v3 encoder is ~622 MB resident once loaded. We lazy-load on first
 *  use, keep the recognizer warm for an idle window, then unload to reclaim RAM.
 *  The public API (`transcribePcm`/`warm`/`unloadAll`) is intentionally process-
 *  agnostic so the whole engine can later move into an Electron `utilityProcess`
 *  for memory isolation + crash containment without changing any caller.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// sherpa-onnx-node is a CommonJS native addon; load it with require, lazily, so
// importing this module never pays the native-load cost until the first dictation.
const require = createRequire(import.meta.url);

/** @type {any} */
let sherpa = null;
function loadSherpa() {
  if (!sherpa) sherpa = require('sherpa-onnx-node');
  return sherpa;
}

/* ── Config ─────────────────────────────────────────────────────────────── */

const DEFAULT_IDLE_UNLOAD_MS = 5 * 60 * 1000; // keep warm 5 min after last use
let idleUnloadMs = DEFAULT_IDLE_UNLOAD_MS;

/** Reasonable CPU thread count: at least 2, at most 4, never more than half the cores. */
function defaultNumThreads() {
  const cores = os.cpus()?.length || 4;
  return Math.max(2, Math.min(4, Math.floor(cores / 2) || 2));
}

/* ── Model file resolution ──────────────────────────────────────────────── */

/**
 * Resolve the on-disk model files for a model directory by engine type.
 * Filenames are auto-detected so the same code handles int8 and fp32 variants.
 *
 * @param {string} dir       absolute model directory
 * @param {string} modelType 'nemo_transducer' | 'whisper'
 * @returns {object} sherpa modelConfig fragment (transducer/whisper + tokens)
 */
function resolveModelFiles(dir, modelType) {
  const pick = (...names) => {
    for (const n of names) {
      const p = path.join(dir, n);
      if (existsSync(p)) return p;
    }
    return null;
  };
  const tokens = pick('tokens.txt');
  if (!tokens) throw new Error(`tokens.txt not found in ${dir}`);

  if (modelType === 'nemo_transducer') {
    const encoder = pick('encoder.int8.onnx', 'encoder.onnx');
    const decoder = pick('decoder.int8.onnx', 'decoder.onnx');
    const joiner = pick('joiner.int8.onnx', 'joiner.onnx');
    if (!encoder || !decoder || !joiner) {
      throw new Error(`transducer model files (encoder/decoder/joiner) not found in ${dir}`);
    }
    return { transducer: { encoder, decoder, joiner }, tokens };
  }

  if (modelType === 'whisper') {
    // sherpa Whisper packages name files like "<size>-encoder.int8.onnx".
    const encoder = pick('encoder.int8.onnx', 'encoder.onnx')
      || pickBySuffix(dir, '-encoder.int8.onnx') || pickBySuffix(dir, '-encoder.onnx');
    const decoder = pick('decoder.int8.onnx', 'decoder.onnx')
      || pickBySuffix(dir, '-decoder.int8.onnx') || pickBySuffix(dir, '-decoder.onnx');
    if (!encoder || !decoder) throw new Error(`whisper model files not found in ${dir}`);
    return { whisper: { encoder, decoder }, tokens };
  }

  throw new Error(`unsupported modelType: ${modelType}`);
}

function pickBySuffix(dir, suffix) {
  // Lazy fs read only if the simple names missed (whisper packages vary).
  const { readdirSync } = require('node:fs');
  try {
    const hit = readdirSync(dir).find((f) => f.endsWith(suffix));
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

/* ── Recognizer cache ───────────────────────────────────────────────────── */

/**
 * modelId -> {
 *   recognizer: OfflineRecognizer,
 *   building: Promise|null,   // in-flight build, to dedupe concurrent first-uses
 *   modelType, dir, numThreads,
 *   lastUsedAt: number,
 * }
 */
const cache = new Map();
let idleTimer = null;

function buildConfig({ dir, modelType, numThreads }) {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      ...resolveModelFiles(dir, modelType),
      modelType,
      numThreads,
      provider: 'cpu',
      debug: false,
    },
  };
}

/**
 * Get (or lazily build) a warm OfflineRecognizer for a model. Concurrent callers
 * during the (~2 s) first build share one in-flight promise.
 */
async function getOrCreateRecognizer({ modelId, modelDir, modelType, numThreads }) {
  let entry = cache.get(modelId);
  if (entry?.recognizer) {
    entry.lastUsedAt = Date.now();
    return entry.recognizer;
  }
  if (entry?.building) return entry.building;

  const threads = numThreads || defaultNumThreads();
  const config = buildConfig({ dir: modelDir, modelType, numThreads: threads });
  const s = loadSherpa();

  const building = (async () => {
    // createAsync builds on a worker thread so the main process UI never freezes
    // during the multi-hundred-MB model load. Fall back to the sync ctor if absent.
    const recognizer = typeof s.OfflineRecognizer.createAsync === 'function'
      ? await s.OfflineRecognizer.createAsync(config)
      : new s.OfflineRecognizer(config);
    cache.set(modelId, {
      recognizer, building: null, modelType, dir: modelDir, numThreads: threads, lastUsedAt: Date.now(),
    });
    return recognizer;
  })();

  cache.set(modelId, { recognizer: null, building, modelType, dir: modelDir, numThreads: threads, lastUsedAt: Date.now() });
  scheduleIdleSweep();
  return building;
}

/* ── PCM → ArrayBuffer helpers ──────────────────────────────────────────── */

/** Decode base64 of a raw Float32 PCM buffer into a fresh, aligned Float32Array. */
function float32FromBase64(b64) {
  const buf = Buffer.from(b64, 'base64');
  // Slice copies exactly our bytes into a new 0-offset (4-byte-aligned) ArrayBuffer,
  // dodging Node's Buffer pooling (which can leave a non-multiple-of-4 byteOffset).
  const aligned = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(aligned);
}

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Transcribe a chunk of mono Float32 PCM with a local model.
 *
 * @param {object} args
 * @param {string} args.modelId            cache key (e.g. 'parakeet-v3')
 * @param {string} args.modelDir           absolute dir of the extracted model
 * @param {string} [args.modelType]        'nemo_transducer' (default) | 'whisper'
 * @param {string} [args.pcmFloat32Base64] base64 of a raw Float32 PCM buffer …
 * @param {Float32Array} [args.samples]    … or the samples directly
 * @param {number} args.sampleRate         capture rate; sherpa resamples to 16 kHz
 * @param {number} [args.numThreads]
 * @returns {Promise<{text, language, audioMs, decodeMs, buildMs, raw}>}
 */
export async function transcribePcm({
  modelId, modelDir, modelType = 'nemo_transducer',
  pcmFloat32Base64, samples, sampleRate, numThreads,
}) {
  if (!modelId || !modelDir) throw new Error('transcribePcm: modelId and modelDir are required');
  if (!sampleRate) throw new Error('transcribePcm: sampleRate is required');

  const pcm = samples instanceof Float32Array
    ? samples
    : float32FromBase64(pcmFloat32Base64 || '');
  if (!pcm.length) throw new Error('transcribePcm: empty PCM');

  const tBuild0 = Date.now();
  const recognizer = await getOrCreateRecognizer({ modelId, modelDir, modelType, numThreads });
  const buildMs = Date.now() - tBuild0; // ~0 when already warm

  const tDec0 = Date.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate, samples: pcm }); // sherpa resamples to 16 kHz
  // decodeAsync runs the decode off the main thread and returns the parsed result.
  const result = typeof recognizer.decodeAsync === 'function'
    ? await recognizer.decodeAsync(stream)
    : (recognizer.decode(stream), recognizer.getResult(stream));
  const decodeMs = Date.now() - tDec0;

  touch(modelId);

  return {
    text: (result?.text || '').trim(),
    language: result?.lang || null,
    audioMs: Math.round((pcm.length / sampleRate) * 1000),
    decodeMs,
    buildMs,
    raw: result,
  };
}

/** Pre-build a model so the first real dictation is instant (opt-in, §8.4). */
export async function warm({ modelId, modelDir, modelType = 'nemo_transducer', numThreads }) {
  await getOrCreateRecognizer({ modelId, modelDir, modelType, numThreads });
  return { ok: true, modelId };
}

/** Is a model currently loaded in RAM? */
export function isWarm(modelId) {
  return !!cache.get(modelId)?.recognizer;
}

/** Unload one model (frees its native memory). */
export function unload(modelId) {
  const entry = cache.get(modelId);
  if (!entry) return false;
  try { entry.recognizer?.free?.(); } catch { /* best-effort */ }
  cache.delete(modelId);
  return true;
}

/** Unload everything — call on app quit. */
export function unloadAll() {
  for (const id of [...cache.keys()]) unload(id);
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
}

/** Configure the idle-unload window (ms). 0 disables auto-unload (keep warm forever). */
export function setIdleUnloadMs(ms) {
  idleUnloadMs = Math.max(0, Number(ms) || 0);
}

function touch(modelId) {
  const entry = cache.get(modelId);
  if (entry) entry.lastUsedAt = Date.now();
}

function scheduleIdleSweep() {
  if (idleTimer || idleUnloadMs <= 0) return;
  idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of cache) {
      if (entry.recognizer && now - entry.lastUsedAt > idleUnloadMs) unload(id);
    }
    if (cache.size === 0 && idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  }, Math.min(idleUnloadMs, 60_000));
  // Don't keep the event loop alive just for the sweep.
  idleTimer.unref?.();
}
