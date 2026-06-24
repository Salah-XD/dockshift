// Verifies model-switching (settings.sttModel → provider modelId override) and the
// family guard, through the real runTranscription executor + provider + engine.
// Uses directory junctions to the already-extracted models (no disk copy).
//   V3_DIR=<extracted v3> V2_DIR=<extracted v2> V3_WAV=<en.wav> V2_WAV=<0.wav> USERDATA=<fresh temp> electron verify-modelswitch.mjs
import { app } from 'electron';
import fs from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.USERDATA) app.setPath('userData', process.env.USERDATA);

import * as catalog from '../../../electron-stt-models.js';
import { getTranscriptionProvider, runTranscription } from '../../../electron-transcription-providers.js';
import { unloadAll } from '../../../electron-sherpa-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checks = [];
const ok = (n, c, d) => { checks.push({ name: n, pass: !!c, detail: d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

// Junction <userData>/sttModels/<id> → an already-extracted model dir + ready marker.
function seedModel(id, srcDir, modelType) {
  const dest = catalog.getModelDir(id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) fs.symlinkSync(path.resolve(srcDir), dest, 'junction');
  fs.writeFileSync(path.join(dest, '.ready.json'), JSON.stringify({ id, modelType, installedAt: new Date().toISOString() }));
}

function pcm(file) {
  const buf = readFileSync(file);
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') { dataOff = body; dataLen = size; }
    off = body + size + (size % 2);
  }
  const bps = fmt.bits / 8, frames = Math.floor(dataLen / (bps * fmt.ch)), out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { let a = 0; for (let c = 0; c < fmt.ch; c++) { const p = dataOff + (i * fmt.ch + c) * bps; a += bps === 2 ? buf.readInt16LE(p) / 32768 : buf.readFloatLE(p); } out[i] = a / fmt.ch; }
  return { b64: Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('base64'), rate: fmt.rate };
}
async function transcribe(modelId, wav) {
  const p = pcm(wav);
  return runTranscription({ provider: getTranscriptionProvider('local-parakeet'), apiKey: null, audioBase64: p.b64, pcm: true, sampleRate: p.rate, language: null, modelId });
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    seedModel('parakeet-v3', process.env.V3_DIR, 'nemo_transducer');
    seedModel('parakeet-v2', process.env.V2_DIR, 'nemo_transducer');
    ok('both parakeet models installed (junction)', catalog.isInstalled('parakeet-v3') && catalog.isInstalled('parakeet-v2'));

    // runTranscription resolves to { text, provider, ... } (no `ok` — that's the
    // IPC handler's wrapper). Assert on the transcript itself.
    const rV3 = await transcribe('parakeet-v3', process.env.V3_WAV);
    ok('modelId=parakeet-v3 uses v3', /ask not what your country/i.test(rV3.text), `"${rV3.text}"`);

    const rV2 = await transcribe('parakeet-v2', process.env.V2_WAV);
    ok('modelId=parakeet-v2 uses v2 (override applied)', /phebe|portrait/i.test(rV2.text), `"${rV2.text}"`);

    // Cross-family override (a whisper id) must be rejected → default v3.
    const rGuard = await transcribe('whisper-medium', process.env.V3_WAV);
    ok('cross-family override rejected → falls back to default', /ask not what your country/i.test(rGuard.text), `"${rGuard.text}"`);
    unloadAll();
  } catch (e) { console.error('FATAL', e); }
  const pass = checks.every((c) => c.pass);
  console.log(`\nRESULT verify-modelswitch: ${pass ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.pass).length}/${checks.length})`);
  writeFileSync(path.join(__dirname, 'verify-modelswitch-result.json'), JSON.stringify({ pass, checks }, null, 2));
  app.quit();
  process.exitCode = pass ? 0 : 1;
});
app.on('window-all-closed', () => app.quit());
