/**
 * Verifies the welcome-screen voice step + default-provider flip + auto-download
 * persistence, in the real app via Playwright. Uses a fresh profile with both
 * Parakeet models junctioned (so welcome:complete's auto-download is a no-op).
 *   V3_DIR=<extracted v3> V2_DIR=<extracted v2> USERDATA=<fresh temp> node verify-welcome.cjs
 */
'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const ELECTRON_EXE = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const USERDATA = process.env.USERDATA;
const checks = [];
const ok = (n, c, d) => { checks.push({ name: n, pass: !!c, detail: d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

function seedModel(id, srcDir) {
  const dest = path.join(USERDATA, 'sttModels', id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) fs.symlinkSync(path.resolve(srcDir), dest, 'junction');
  fs.writeFileSync(path.join(dest, '.ready.json'), JSON.stringify({ id, modelType: 'nemo_transducer', installedAt: new Date().toISOString() }));
}

(async () => {
  fs.mkdirSync(USERDATA, { recursive: true });
  seedModel('parakeet-v3', process.env.V3_DIR);
  seedModel('parakeet-v2', process.env.V2_DIR);
  // No settings.json → welcome screen shows.

  const app = await electron.launch({
    executablePath: ELECTRON_EXE, cwd: REPO,
    args: [REPO, `--user-data-dir=${USERDATA}`],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.electronAPI, null, { timeout: 20000 });

    // Default-provider flip: with no sttProvider set, the active provider resolves
    // to on-device Parakeet.
    const prov = await page.evaluate(() => window.electronAPI.invoke('transcription:providers'));
    ok('default provider flipped to local-parakeet', prov?.activeId === 'local-parakeet', prov?.activeId);

    // Navigate intro → features → voice.
    await page.locator('button', { hasText: 'Next' }).click();
    await page.locator('button', { hasText: 'Next' }).click();
    await page.waitForSelector('text=Your voice engine', { timeout: 8000 });
    ok('welcome voice step renders', true);

    ok('lists Parakeet v3 as Recommended', (await page.locator('text=Parakeet v3').count()) > 0 && (await page.locator('text=Recommended').count()) > 0);
    ok('lists Parakeet v2', (await page.locator('text=Parakeet v2').count()) > 0);
    ok('lists Whisper as Soon', (await page.locator('text=Whisper').first().count()) > 0 && (await page.locator('text=Soon').count()) > 0);
    ok('shows Accuracy + Speed bars', (await page.locator('text=Accuracy').count()) > 0 && (await page.locator('text=Speed').count()) > 0);
    ok('shows Multilingual / English badges', (await page.locator('text=Multilingual').count()) > 0 && (await page.locator('text=English').count()) > 0);

    try { await page.screenshot({ path: path.join(__dirname, 'welcome-voice.png') }); } catch (_) {}

    // Select Parakeet v2, then complete onboarding via IPC (model already present
    // → auto-download is a no-op). Assert persisted settings.
    await page.locator('button', { hasText: 'Parakeet v2' }).click();
    // welcome:complete persists settings then closes this window — the evaluate
    // promise rejects with "page closed", which is expected; settings are already
    // written on the main side by then.
    await page.evaluate(() => { window.electronAPI.invoke('welcome:complete', { analyticsEnabled: false, voiceProvider: 'local-parakeet', voiceModel: 'parakeet-v2' }); })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));

    const settings = JSON.parse(fs.readFileSync(path.join(USERDATA, 'settings.json'), 'utf8'));
    ok('welcome:complete persisted sttProvider=local-parakeet', settings.sttProvider === 'local-parakeet', settings.sttProvider);
    ok('welcome:complete persisted sttModel=parakeet-v2', settings.sttModel === 'parakeet-v2', settings.sttModel);
    ok('welcome:complete set hasCompletedWelcome', settings.hasCompletedWelcome === true);
  } finally {
    await app.close();
  }
  const pass = checks.every((c) => c.pass);
  console.log(`\nRESULT verify-welcome: ${pass ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.pass).length}/${checks.length})`);
  fs.writeFileSync(path.join(__dirname, 'verify-welcome-result.json'), JSON.stringify({ pass, checks }, null, 2));
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); fs.writeFileSync(path.join(__dirname, 'verify-welcome-result.json'), JSON.stringify({ pass: false, error: String(e?.stack || e), checks }, null, 2)); process.exit(1); });
