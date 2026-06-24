// Verifies the local-parakeet provider through the REAL runTranscription executor
// (../../../electron-transcription-providers.js) under Electron — the exact path
// the transcription:transcribe IPC handler will use, with PCM + sampleRate.
//   LOCAL_ARCHIVE=<parakeet .tar.bz2> USERDATA=<temp dir> electron verify-provider.mjs
import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolate userData BEFORE app uses it, so the provider's default catalog dir
// (app.getPath('userData')/sttModels) resolves into our throwaway location.
if (process.env.USERDATA) app.setPath('userData', process.env.USERDATA);

import * as catalog from '../../../electron-stt-models.js';
import { getTranscriptionProvider, runTranscription, TranscriptionError } from '../../../electron-transcription-providers.js';
import { unloadAll } from '../../../electron-sherpa-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_ARCHIVE = process.env.LOCAL_ARCHIVE;
const checks = [];
const ok = (name, cond, detail) => { checks.push({ name, pass: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

function parseWav(buf) {
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') { dataOff = body; dataLen = size; }
    off = body + size + (size % 2);
  }
  const bps = fmt.bits / 8, frames = Math.floor(dataLen / (bps * fmt.ch)), out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { let a = 0; for (let c = 0; c < fmt.ch; c++) { const p = dataOff + (i * fmt.ch + c) * bps; a += bps === 2 ? buf.readInt16LE(p) / 32768 : buf.readFloatLE(p); } out[i] = a / fmt.ch; }
  return { samples: out, sampleRate: fmt.rate };
}
const pcmB64 = (s) => Buffer.from(s.buffer, s.byteOffset, s.byteLength).toString('base64');

async function run() {
  // The provider uses the default catalog dir; install there (no modelsDir override).
  const parakeet = getTranscriptionProvider('local-parakeet');
  ok('local-parakeet provider exists', !!parakeet);
  ok('provider is localNative + keyless', parakeet.localNative && parakeet.keyless);
  ok('provider exposes timestamps capability', parakeet.capabilities.timestamps === true);

  // Error path 1: model not installed yet.
  let notInstalledErr = null;
  try {
    await runTranscription({ provider: parakeet, apiKey: null, audioBase64: 'AAAA', sampleRate: 16000, language: 'auto' });
  } catch (e) { notInstalledErr = e; }
  ok('errors clearly when model not installed', notInstalledErr instanceof TranscriptionError && notInstalledErr.code === 'config', notInstalledErr?.message);

  // Install the model at the provider's default location.
  await catalog.installFromArchive('parakeet-v3', LOCAL_ARCHIVE);
  ok('model installed at default catalog dir', catalog.isInstalled('parakeet-v3'));

  const wavPath = path.join(catalog.getModelDir('parakeet-v3'), 'test_wavs', 'en.wav');
  const { samples, sampleRate } = parseWav(readFileSync(wavPath));

  // Error path 2: missing sampleRate (localNative requires it).
  let noRateErr = null;
  try { await runTranscription({ provider: parakeet, apiKey: null, audioBase64: pcmB64(samples), language: 'auto' }); }
  catch (e) { noRateErr = e; }
  ok('errors clearly when sampleRate missing', noRateErr instanceof TranscriptionError && noRateErr.code === 'config', noRateErr?.message);

  // Happy path: full executor → provider → engine.
  const res = await runTranscription({ provider: parakeet, apiKey: null, audioBase64: pcmB64(samples), mimeType: '', sampleRate, language: 'auto' });
  ok('runTranscription returns correct text', /ask not what your country/i.test(res.text), `"${res.text}"`);
  ok('result tagged with provider id', res.provider === 'local-parakeet');
  ok('result carries audio durationMs', typeof res.durationMs === 'number' && res.durationMs > 3000, `${res.durationMs}ms`);
  unloadAll();

  // local-whisper is registered too (even though its model isn't pinned yet).
  ok('local-whisper provider registered', !!getTranscriptionProvider('local-whisper'));

  catalog.removeModel('parakeet-v3');

  const pass = checks.every((c) => c.pass);
  console.log(`\nRESULT verify-provider: ${pass ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.pass).length}/${checks.length})`);
  writeFileSync(path.join(__dirname, 'verify-provider-result.json'), JSON.stringify({ pass, checks }, null, 2));
  return pass;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let pass = false;
  try { pass = await run(); } catch (e) { console.error('FAIL', e); writeFileSync(path.join(__dirname, 'verify-provider-result.json'), JSON.stringify({ pass: false, error: String(e?.stack || e), checks }, null, 2)); }
  app.quit();
  process.exitCode = pass ? 0 : 1;
});
app.on('window-all-closed', () => app.quit());
