// Verifies the REAL catalog module (../../../electron-stt-models.js) under Electron:
// SHA-256 verify (good + bad), atomic extract from a local archive, catalog->engine
// integration, language-coverage logic, removal, and one real network downloadModel.
//   LOCAL_ARCHIVE=<parakeet .tar.bz2> TEST_BASE=<temp dir> electron verify-catalog.mjs
import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as catalog from '../../../electron-stt-models.js';
import { transcribePcm, unloadAll } from '../../../electron-sherpa-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_ARCHIVE = process.env.LOCAL_ARCHIVE;
const TEST_BASE = process.env.TEST_BASE;
const ID = 'parakeet-v3';

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
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.ch; c++) { const p = dataOff + (i * fmt.ch + c) * bps; acc += bps === 2 ? buf.readInt16LE(p) / 32768 : buf.readFloatLE(p); }
    out[i] = acc / fmt.ch;
  }
  return { samples: out, sampleRate: fmt.rate };
}
const pcmB64 = (s) => Buffer.from(s.buffer, s.byteOffset, s.byteLength).toString('base64');

async function run() {
  const offlineDir = path.join(TEST_BASE, 'offline');
  const downloadDir = path.join(TEST_BASE, 'download');

  // A) Catalog listing + installability gating.
  const list = catalog.listModels({ modelsDir: offlineDir });
  const v3 = list.find((m) => m.id === ID);
  const wMed = list.find((m) => m.id === 'whisper-medium');
  ok('catalog lists parakeet-v3 as installable + not-yet-installed', v3 && v3.installable && !v3.installed);
  ok('catalog gates un-pinned models (whisper-medium not installable)', wMed && wMed.installable === false);

  // B) SHA-256 verification (good + bad).
  let goodOk = false; try { await catalog.verifyArchive(LOCAL_ARCHIVE, catalog.getModel(ID).sha256); goodOk = true; } catch { goodOk = false; }
  ok('verifyArchive accepts correct SHA-256', goodOk);
  let badRejected = false; try { await catalog.verifyArchive(LOCAL_ARCHIVE, 'deadbeef'.repeat(8)); } catch { badRejected = true; }
  ok('verifyArchive rejects wrong SHA-256', badRejected);

  // C) Atomic install from a local archive (no re-download).
  const inst = await catalog.installFromArchive(ID, LOCAL_ARCHIVE, { modelsDir: offlineDir });
  ok('installFromArchive succeeds', inst.ok);
  ok('isInstalled true after install', catalog.isInstalled(ID, { modelsDir: offlineDir }));
  const st = catalog.getStatus(ID, { modelsDir: offlineDir });
  ok('getStatus reports sizeOnDisk > 600MB', st.sizeOnDisk > 600 * 1024 * 1024, `${Math.round(st.sizeOnDisk / 1024 / 1024)}MB`);

  // D) Catalog -> engine integration (the real handoff the provider will use).
  const modelDir = catalog.getModelDir(ID, { modelsDir: offlineDir });
  const wavPath = path.join(modelDir, 'test_wavs', 'en.wav');
  ok('installed model includes test_wavs/en.wav', existsSync(wavPath));
  const { samples, sampleRate } = parseWav(readFileSync(wavPath));
  const r = await transcribePcm({ modelId: ID, modelDir, modelType: catalog.getModel(ID).modelType, pcmFloat32Base64: pcmB64(samples), sampleRate });
  ok('engine transcribes from catalog-resolved dir', /ask not what your country/i.test(r.text), `"${r.text}"`);
  unloadAll();

  // E) Language-coverage logic (spec §5).
  ok('parakeet-v3 supports en', catalog.modelSupportsLanguage(ID, 'en'));
  ok('parakeet-v3 does NOT support hi (Hindi)', !catalog.modelSupportsLanguage(ID, 'hi'));
  ok('whisper-medium supports hi (multilingual)', catalog.modelSupportsLanguage('whisper-medium', 'hi'));

  // F) Removal.
  catalog.removeModel(ID, { modelsDir: offlineDir });
  ok('isInstalled false after removeModel', !catalog.isInstalled(ID, { modelsDir: offlineDir }));

  // G) Real end-to-end network download (streaming + verify + extract + cleanup).
  console.log('\n[downloadModel] starting real network download…');
  let lastPct = -1;
  const dl = await catalog.downloadModel(ID, {
    modelsDir: downloadDir,
    onProgress: ({ phase, downloaded, total }) => {
      if (phase === 'downloading' && total) { const pct = Math.floor((downloaded / total) * 100); if (pct >= lastPct + 20) { lastPct = pct; console.log(`  download ${pct}%`); } }
      else if (phase !== 'downloading') console.log(`  phase=${phase}`);
    },
  });
  ok('downloadModel ok', dl.ok, dl.error || '');
  ok('isInstalled true after downloadModel', catalog.isInstalled(ID, { modelsDir: downloadDir }));
  ok('archive deleted after extract', !existsSync(path.join(downloadDir, catalog.getModel(ID).archive)));
  catalog.removeModel(ID, { modelsDir: downloadDir });

  const pass = checks.every((c) => c.pass);
  console.log(`\nRESULT verify-catalog: ${pass ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.pass).length}/${checks.length})`);
  writeFileSync(path.join(__dirname, 'verify-catalog-result.json'), JSON.stringify({ pass, checks }, null, 2));
  return pass;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let pass = false;
  try { pass = await run(); } catch (e) { console.error('FAIL', e); writeFileSync(path.join(__dirname, 'verify-catalog-result.json'), JSON.stringify({ pass: false, error: String(e?.stack || e), checks }, null, 2)); }
  app.quit();
  process.exitCode = pass ? 0 : 1;
});
app.on('window-all-closed', () => app.quit());
