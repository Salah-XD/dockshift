// Verifies the REAL production engine module (../../../electron-sherpa-engine.js)
// end-to-end under Electron: base64 Float32 PCM in → text out, warm-cache reuse,
// and multilingual decode. Mirrors how the localNative provider will call it.
//   MODEL_DIR=<extracted parakeet dir> ../../../node_modules/electron/dist/electron.exe verify-engine.mjs
import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcribePcm, isWarm, unloadAll } from '../../../electron-sherpa-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = process.env.MODEL_DIR;
const MODEL_ID = 'parakeet-v3';

function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not WAVE');
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { numChannels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    else if (id === 'data') { dataOff = body; dataLen = size; }
    off = body + size + (size % 2);
  }
  const bps = fmt.bitsPerSample / 8;
  const frames = Math.floor(dataLen / (bps * fmt.numChannels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.numChannels; c++) {
      const p = dataOff + (i * fmt.numChannels + c) * bps;
      acc += bps === 2 ? buf.readInt16LE(p) / 32768 : buf.readFloatLE(p);
    }
    out[i] = acc / fmt.numChannels;
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}

// Encode a Float32Array's raw bytes as base64 — exactly what the renderer will send.
function pcmToBase64(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
}

async function decodeLang(lang) {
  const { samples, sampleRate } = parseWav(readFileSync(path.join(MODEL_DIR, 'test_wavs', `${lang}.wav`)));
  const r = await transcribePcm({
    modelId: MODEL_ID, modelDir: MODEL_DIR, modelType: 'nemo_transducer',
    pcmFloat32Base64: pcmToBase64(samples), sampleRate,
  });
  return r;
}

async function run() {
  const results = {};
  console.log(`MODEL_DIR=${MODEL_DIR}`);

  // 1) Cold call — builds the recognizer (buildMs > 0).
  results.cold = await decodeLang('en');
  console.log(`COLD  en: "${results.cold.text}"  build=${results.cold.buildMs}ms decode=${results.cold.decodeMs}ms warm=${isWarm(MODEL_ID)}`);

  // 2) Warm call — same model, should reuse the cached recognizer (buildMs ~0).
  results.warm = await decodeLang('en');
  console.log(`WARM  en: build=${results.warm.buildMs}ms decode=${results.warm.decodeMs}ms`);

  // 3) Multilingual on the warm recognizer.
  results.es = await decodeLang('es');
  results.fr = await decodeLang('fr');
  console.log(`WARM  es: "${results.es.text}"`);
  console.log(`WARM  fr: "${results.fr.text}"`);

  const pass = results.cold.text.length > 0
    && results.warm.buildMs < results.cold.buildMs
    && results.es.text.length > 0 && results.fr.text.length > 0;
  console.log(`\nRESULT verify-engine: ${pass ? 'PASS' : 'FAIL'}`);
  writeFileSync(path.join(__dirname, 'verify-engine-result.json'), JSON.stringify({ pass, ...results }, null, 2));
  unloadAll();
  return pass;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let ok = false;
  try { ok = await run(); } catch (e) { console.error('FAIL', e); writeFileSync(path.join(__dirname, 'verify-engine-result.json'), JSON.stringify({ pass: false, error: String(e?.stack || e) }, null, 2)); }
  app.quit();
  process.exitCode = ok ? 0 : 1;
});
app.on('window-all-closed', () => app.quit());
