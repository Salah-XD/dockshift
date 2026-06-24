/**
 * End-to-end verification of the local voice dictation feature in the REAL
 * DockShift app, driven by Playwright's Electron support.
 *
 * Tier 1 — real IPC pipeline: through preload allowlist + main handlers +
 *          provider + catalog + sherpa engine (stt:models:list / stt:model:status
 *          / transcription:transcribe with PCM).
 * Tier 2 — fake-microphone capture: Chromium fake audio device fed from en.wav,
 *          captured via the same Web Audio graph as useMicPcm, transcribed.
 *
 * Prereqs: Vite dev server on :5173 (npm run dev:vite), `npm install playwright`
 * (no-save), and the extracted Parakeet v3 model in MODEL_SRC.
 *
 * Run:  MODEL_SRC=<dir> WAV=<en.wav> TEST_UD=<temp> node verify-app-e2e.cjs
 */
'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const ELECTRON_EXE = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const MODEL_SRC = process.env.MODEL_SRC;
const WAV = process.env.WAV;
const TEST_UD = process.env.TEST_UD;
const MODEL_ID = 'parakeet-v3';

const checks = [];
const ok = (name, cond, detail) => { checks.push({ name, pass: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

function parseWavToPcm(file) {
  const buf = fs.readFileSync(file);
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') { dataOff = body; dataLen = size; }
    off = body + size + (size % 2);
  }
  const bps = fmt.bits / 8, frames = Math.floor(dataLen / (bps * fmt.ch)), out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { let a = 0; for (let c = 0; c < fmt.ch; c++) { const p = dataOff + (i * fmt.ch + c) * bps; a += bps === 2 ? buf.readInt16LE(p) / 32768 : buf.readFloatLE(p); } out[i] = a / fmt.ch; }
  const bytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  return { b64: bytes.toString('base64'), rate: fmt.rate };
}

function seedUserData() {
  fs.rmSync(TEST_UD, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_UD, 'sttModels'), { recursive: true });
  // Skip the welcome window + default to the on-device provider.
  fs.writeFileSync(path.join(TEST_UD, 'settings.json'), JSON.stringify({ hasCompletedWelcome: true, sttProvider: 'local-parakeet' }, null, 2));
  // Copy the extracted model into place + write the ready marker the catalog expects.
  const dest = path.join(TEST_UD, 'sttModels', MODEL_ID);
  fs.cpSync(MODEL_SRC, dest, { recursive: true });
  fs.writeFileSync(path.join(dest, '.ready.json'), JSON.stringify({ id: MODEL_ID, modelType: 'nemo_transducer', installedAt: new Date().toISOString() }));
}

(async () => {
  seedUserData();
  const pcm = parseWavToPcm(WAV);

  const app = await electron.launch({
    executablePath: ELECTRON_EXE,
    cwd: REPO,
    args: [
      REPO,
      `--user-data-dir=${TEST_UD}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' }, // load the Vite dev server renderer
  });

  try {
    const ud = await app.evaluate(({ app: a }) => a.getPath('userData'));
    ok('app honors --user-data-dir', path.resolve(ud) === path.resolve(TEST_UD), ud);

    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.electronAPI, null, { timeout: 20000 });
    ok('renderer exposes electronAPI (preload loaded)', true);

    // Tier 1a — catalog list through real IPC.
    const list = await page.evaluate(() => window.electronAPI.invoke('stt:models:list'));
    const v3 = list?.models?.find((m) => m.id === MODEL_ID);
    ok('stt:models:list returns parakeet-v3 installed', !!v3 && v3.installed === true);

    // Tier 1b — per-model status.
    const status = await page.evaluate((id) => window.electronAPI.invoke('stt:model:status', { id }), MODEL_ID);
    ok('stt:model:status installed=true', status?.installed === true);

    // Tier 1c — full transcribe through real IPC with PCM payload.
    const t1 = await page.evaluate((p) => window.electronAPI.invoke('transcription:transcribe', { providerId: 'local-parakeet', audio: p.b64, pcm: true, sampleRate: p.rate, language: null }), pcm);
    ok('transcription:transcribe (PCM) returns correct text', t1?.ok && /ask not what your country/i.test(t1.text || ''), t1?.text || t1?.error);

    // Tier 2 — fake-microphone capture via the useMicPcm-style Web Audio graph.
    const t2 = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(proc); proc.connect(g); g.connect(ctx.destination);
      await new Promise((r) => setTimeout(r, 4500));
      proc.disconnect(); stream.getTracks().forEach((t) => t.stop());
      const rate = ctx.sampleRate; await ctx.close();
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const samples = new Float32Array(total); let o = 0; for (const c of chunks) { samples.set(c, o); o += c.length; }
      const bytes = new Uint8Array(samples.buffer);
      let bin = ''; const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      const out = await window.electronAPI.invoke('transcription:transcribe', { providerId: 'local-parakeet', audio: btoa(bin), pcm: true, sampleRate: rate, language: null });
      return { rate, frames: total, out };
    });
    ok('fake-mic capture transcribes (mic→PCM→IPC→engine)', t2?.out?.ok && /country/i.test(t2.out.text || ''), `${t2?.rate}Hz/${t2?.frames}smp → "${t2?.out?.text || t2?.out?.error}"`);

    try { await page.screenshot({ path: path.join(__dirname, 'e2e-dock.png') }); } catch (_) {}
  } finally {
    await app.close();
  }

  const pass = checks.every((c) => c.pass);
  console.log(`\nRESULT verify-app-e2e: ${pass ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.pass).length}/${checks.length})`);
  fs.writeFileSync(path.join(__dirname, 'verify-app-e2e-result.json'), JSON.stringify({ pass, checks }, null, 2));
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); fs.writeFileSync(path.join(__dirname, 'verify-app-e2e-result.json'), JSON.stringify({ pass: false, error: String(e?.stack || e), checks }, null, 2)); process.exit(1); });
