/**
 * UI check: mount the real VoicePanel React component in the running app and
 * confirm the localNative provider renders the record control (model installed).
 * Reuses the profile seeded by verify-app-e2e.cjs (TEST_UD) — no re-copy.
 *   TEST_UD=<seeded userdata> WAV=<en.wav> node verify-app-ui.cjs
 */
'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const ELECTRON_EXE = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEST_UD = process.env.TEST_UD;
const WAV = process.env.WAV;
const checks = [];
const ok = (name, cond, detail) => { checks.push({ name, pass: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

(async () => {
  const app = await electron.launch({
    executablePath: ELECTRON_EXE,
    cwd: REPO,
    args: [REPO, `--user-data-dir=${TEST_UD}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.electronAPI, null, { timeout: 20000 });

    // Open the Voice panel via the dock item (transparent/click-through → force).
    await page.click('button[data-dock-action="mic"]', { force: true, timeout: 10000 });

    // Panel renders its title + the active provider badge.
    await page.waitForSelector('text=Voice to Text', { timeout: 10000 });
    ok('VoicePanel mounts (title visible)', true);

    const hasOnDeviceBadge = await page.locator('text=On-device — Parakeet').count();
    ok('shows the on-device Parakeet provider', hasOnDeviceBadge > 0);

    // Model is installed → record control shown, no download CTA.
    const recordBtn = await page.waitForSelector('button[title="Start recording"]', { timeout: 10000 }).catch(() => null);
    ok('record control rendered (no doomed-download gate)', !!recordBtn);

    const downloadCta = await page.locator('text=Download model').count();
    ok('no "Download model" CTA when model installed', downloadCta === 0);

    try { await page.screenshot({ path: path.join(__dirname, 'e2e-voicepanel.png') }); } catch (_) {}
  } finally {
    await app.close();
  }
  const pass = checks.every((c) => c.pass);
  console.log(`\nRESULT verify-app-ui: ${pass ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.pass).length}/${checks.length})`);
  fs.writeFileSync(path.join(__dirname, 'verify-app-ui-result.json'), JSON.stringify({ pass, checks }, null, 2));
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); fs.writeFileSync(path.join(__dirname, 'verify-app-ui-result.json'), JSON.stringify({ pass: false, error: String(e?.stack || e), checks }, null, 2)); process.exit(1); });
