/**
 * End-to-end verification of the dictation pill (Voice Phase 2) in the REAL app.
 *
 * Confirms: (1) the global hotkey is registered; (2) the pill window exists as a
 * non-activating overlay on the #pill route; (3) driving its start/stop lifecycle
 * captures fake-mic PCM, transcribes via voice:pill:transcribe, and auto-inserts
 * the text — asserted via insertMode='clipboard' so it's deterministic (no focused
 * editable / SendKeys needed; electron-paste's keystroke path is unit-tested).
 *
 * Prereqs: Vite dev server on :5173, `npm install playwright` (no-save), extracted
 * Parakeet v3 in MODEL_SRC.
 *   MODEL_SRC=<dir> WAV=<en.wav> TEST_UD=<temp> node verify-pill.cjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seedUserData() {
  fs.mkdirSync(path.join(TEST_UD, 'sttModels'), { recursive: true });
  fs.writeFileSync(path.join(TEST_UD, 'settings.json'), JSON.stringify({
    hasCompletedWelcome: true,
    sttProvider: 'local-parakeet',
    voiceInsertMode: 'clipboard', // deterministic: assert the transcript on the clipboard
  }, null, 2));
  const dest = path.join(TEST_UD, 'sttModels', MODEL_ID);
  if (!fs.existsSync(dest)) fs.symlinkSync(path.resolve(MODEL_SRC), dest, 'junction');
  fs.writeFileSync(path.join(dest, '.ready.json'), JSON.stringify({ id: MODEL_ID, modelType: 'nemo_transducer', installedAt: new Date().toISOString() }));
}

(async () => {
  seedUserData();
  const app = await electron.launch({
    executablePath: ELECTRON_EXE,
    cwd: REPO,
    args: [REPO, `--user-data-dir=${TEST_UD}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  try {
    await app.firstWindow();
    await sleep(2500); // let startDock register the hotkey + create the pill window

    // 1) Global hotkey registered.
    const hotkeyRegistered = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Shift+Space'));
    ok('global hotkey Control+Shift+Space registered', hotkeyRegistered);

    // 2) Pill window exists on the #pill route, non-activating + skipTaskbar.
    const pillInfo = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((b) => (b.webContents.getURL() || '').includes('#pill'));
      if (!w) return null;
      return { focusable: w.isFocusable(), loaded: !w.webContents.isLoading() };
    });
    ok('pill window exists (#pill route)', !!pillInfo, JSON.stringify(pillInfo));
    ok('pill window is non-activating (focusable:false)', pillInfo && pillInfo.focusable === false);

    // 3) Drive the lifecycle the hotkey would: show + start → (capture) → stop.
    await app.evaluate(({ BrowserWindow, clipboard }) => {
      clipboard.writeText('SENTINEL-BEFORE'); // so we can detect the transcript replacing it
      const w = BrowserWindow.getAllWindows().find((b) => (b.webContents.getURL() || '').includes('#pill'));
      w.showInactive();
      w.webContents.send('voice:pill:start');
    });
    const pillVisible = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((b) => (b.webContents.getURL() || '').includes('#pill'));
      return w ? w.isVisible() : false;
    });
    ok('pill shows on start (showInactive)', pillVisible);

    await sleep(1800); // capture fake-mic audio
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((b) => (b.webContents.getURL() || '').includes('#pill'));
      w.webContents.send('voice:pill:stop');
    });

    // 4) Poll the clipboard for the transcript (first decode loads the model → allow time).
    let clip = '';
    for (let i = 0; i < 40; i++) {
      await sleep(750);
      clip = await app.evaluate(({ clipboard }) => clipboard.readText());
      if (clip && clip !== 'SENTINEL-BEFORE') break;
    }
    ok('pill transcribed + auto-inserted (clipboard mode)', /ask not what your country/i.test(clip), `"${clip}"`);

    // 5) Pill auto-dismissed (hidden) after the done flash.
    await sleep(1500);
    const hiddenAfter = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((b) => (b.webContents.getURL() || '').includes('#pill'));
      return w ? !w.isVisible() : false;
    });
    ok('pill auto-dismisses after done', hiddenAfter);
  } catch (e) {
    console.error('FATAL', e);
  } finally {
    await app.close();
  }
  const pass = checks.every((c) => c.pass);
  console.log(`\nRESULT verify-pill: ${pass ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.pass).length}/${checks.length})`);
  fs.writeFileSync(path.join(__dirname, 'verify-pill-result.json'), JSON.stringify({ pass, checks }, null, 2));
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
