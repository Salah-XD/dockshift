// Stage B (production-representative) — decode under Electron WITHOUT sherpa.readWave.
// We parse the WAV in pure JS into a NORMAL (V8-owned) Float32Array, exactly like the
// real app where PCM arrives from the renderer's Web Audio over IPC. This sidesteps
// Electron's "External buffers are not allowed" restriction that only affects the
// native readWave() helper — not the actual mic->IPC->acceptWaveform path.
//   MODEL_DIR=<dir> WAV_PATH=<file> electron transcribe-js-pcm.cjs   (or plain node)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`;
const abi = process.versions.modules;
const modelDir = process.env.MODEL_DIR;
const wavPath = process.env.WAV_PATH;

function writeResult(obj) {
  try { fs.writeFileSync(path.join(__dirname, 'jspcm-result.json'), JSON.stringify(obj, null, 2)); } catch {}
}
function fail(msg, err) {
  console.error(`\nRESULT js-pcm: FAIL — ${msg}`);
  if (err) console.error(err && err.stack ? err.stack : err);
  writeResult({ runtime, abi, ok: false, error: msg + (err ? ' :: ' + (err.message || err) : '') });
  return false;
}

// Minimal RIFF/WAVE parser → { samples: Float32Array(mono), sampleRate }
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        numChannels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOff = body; dataLen = size;
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || dataOff < 0) throw new Error('missing fmt or data chunk');

  const { audioFormat, numChannels, sampleRate, bitsPerSample } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLen / (bytesPerSample * numChannels));
  const out = new Float32Array(frameCount); // <-- normal V8-owned buffer (not external)

  for (let i = 0; i < frameCount; i++) {
    let acc = 0;
    for (let c = 0; c < numChannels; c++) {
      const p = dataOff + (i * numChannels + c) * bytesPerSample;
      let v;
      if (audioFormat === 3 && bitsPerSample === 32) v = buf.readFloatLE(p);
      else if (bitsPerSample === 16) v = buf.readInt16LE(p) / 32768;
      else if (bitsPerSample === 32) v = buf.readInt32LE(p) / 2147483648;
      else if (bitsPerSample === 8) v = (buf.readUInt8(p) - 128) / 128;
      else throw new Error('unsupported bitsPerSample: ' + bitsPerSample);
      acc += v;
    }
    out[i] = acc / numChannels; // downmix to mono
  }
  return { samples: out, sampleRate, audioFormat, bitsPerSample, numChannels };
}

function run() {
  if (!modelDir || !wavPath) return fail('set MODEL_DIR and WAV_PATH');
  let sherpa;
  try { sherpa = require('sherpa-onnx-node'); } catch (e) { return fail('load sherpa-onnx-node', e); }

  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, 'encoder.int8.onnx'),
        decoder: path.join(modelDir, 'decoder.int8.onnx'),
        joiner: path.join(modelDir, 'joiner.int8.onnx'),
      },
      tokens: path.join(modelDir, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: Math.max(2, Math.min(4, os.cpus().length)),
      provider: 'cpu',
      debug: false,
    },
  };

  const tBuild0 = Date.now();
  let rec;
  try { rec = new sherpa.OfflineRecognizer(config); } catch (e) { return fail('OfflineRecognizer build', e); }
  const buildMs = Date.now() - tBuild0;

  let wav;
  try { wav = parseWav(fs.readFileSync(wavPath)); } catch (e) { return fail('parseWav', e); }
  const audioSec = wav.samples.length / wav.sampleRate;
  console.log(`[${runtime} | abi ${abi}] built in ${buildMs}ms | wav ${path.basename(wavPath)} ${audioSec.toFixed(2)}s @ ${wav.sampleRate}Hz fmt=${wav.audioFormat}/${wav.bitsPerSample}bit/${wav.numChannels}ch`);
  console.log(`[${runtime}] samples is ${wav.samples.constructor.name}, length ${wav.samples.length}`);

  const t0 = Date.now();
  const stream = rec.createStream();
  stream.acceptWaveform({ sampleRate: wav.sampleRate, samples: wav.samples });
  rec.decode(stream);
  const result = rec.getResult(stream);
  const decodeMs = Date.now() - t0;
  const speedup = audioSec / (decodeMs / 1000);
  const text = (result.text || '').trim();

  console.log(`[${runtime}] TRANSCRIPT: "${text}"`);
  if (result.lang) console.log(`[${runtime}] lang: ${result.lang}`);
  console.log(`[${runtime}] decode ${decodeMs}ms for ${audioSec.toFixed(2)}s → ${speedup.toFixed(1)}x realtime (RTF ${(decodeMs/1000/audioSec).toFixed(3)})`);
  const ok = text.length > 0;
  console.log(`\nRESULT js-pcm (${runtime}): ${ok ? 'PASS' : 'FAIL — empty'}`);
  writeResult({ runtime, abi, ok, buildMs, wav: path.basename(wavPath), audioSec: +audioSec.toFixed(2), decodeMs, speedup: +speedup.toFixed(1), text, lang: result.lang || null });
  return ok;
}

if (process.versions.electron) {
  const { app } = require('electron');
  app.disableHardwareAcceleration();
  app.whenReady().then(() => { let ok = false; try { ok = run(); } catch (e) { fail('unexpected', e); } app.quit(); process.exitCode = ok ? 0 : 1; });
  app.on('window-all-closed', () => app.quit());
} else {
  process.exit(run() ? 0 : 1);
}
