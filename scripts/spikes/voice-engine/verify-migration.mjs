// Verifies the one-time legacy-Vosk → on-device-Parakeet settings migration.
// Pure fs logic (migrateLegacyVoskProvider takes a userDataDir), so this runs
// under plain Node with throwaway temp profiles — no Electron, no Vite.
//   node verify-migration.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateLegacyVoskProvider } from '../../../electron-stt-migration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checks = [];
const ok = (n, c, d) => { checks.push({ name: n, pass: !!c, detail: d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const DEFAULT = 'local-parakeet';

/** Fresh throwaway userData dir seeded with the given settings + optional vosk model. */
function makeProfile(settings, { withVoskModel = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mig-'));
  if (settings !== null) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  if (withVoskModel) {
    const vd = path.join(dir, 'voskModels');
    fs.mkdirSync(vd, { recursive: true });
    fs.writeFileSync(path.join(vd, 'en-us-small.tar.gz'), 'dummy-archive');
  }
  return dir;
}
const readSettings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));

// ── Case A: a vosk-offline profile is migrated to the default, model reclaimed ──
{
  const dir = makeProfile(
    { sttProvider: 'vosk-offline', sttLanguage: 'en-GB', theme: 'dark', hasCompletedWelcome: true },
    { withVoskModel: true },
  );
  const res = migrateLegacyVoskProvider(dir, DEFAULT);
  const s = readSettings(dir);
  ok('A: reports migrated', res?.migrated === true, JSON.stringify(res));
  ok('A: sttProvider flipped to default', s.sttProvider === DEFAULT, s.sttProvider);
  ok('A: unrelated settings preserved', s.theme === 'dark' && s.sttLanguage === 'en-GB' && s.hasCompletedWelcome === true);
  ok('A: voskModels dir reclaimed', !fs.existsSync(path.join(dir, 'voskModels')));
}

// ── Case B: a non-Vosk provider is left completely untouched ────────────────────
{
  const dir = makeProfile({ sttProvider: 'gemini', sttLanguage: 'en-US' });
  const res = migrateLegacyVoskProvider(dir, DEFAULT);
  const s = readSettings(dir);
  ok('B: reports not migrated', res?.migrated === false, JSON.stringify(res));
  ok('B: sttProvider untouched', s.sttProvider === 'gemini', s.sttProvider);
}

// ── Case C: a profile with no sttProvider key is left untouched ─────────────────
{
  const dir = makeProfile({ theme: 'light' });
  const res = migrateLegacyVoskProvider(dir, DEFAULT);
  const s = readSettings(dir);
  ok('C: no sttProvider → not migrated', res?.migrated === false && s.sttProvider === undefined);
}

// ── Case D: missing settings.json does not throw ───────────────────────────────
{
  const dir = makeProfile(null);
  let threw = false;
  let res;
  try { res = migrateLegacyVoskProvider(dir, DEFAULT); } catch { threw = true; }
  ok('D: missing settings.json handled without throwing', !threw && res?.migrated === false);
}

const pass = checks.every((c) => c.pass);
console.log(`\nRESULT verify-migration: ${pass ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.pass).length}/${checks.length})`);
fs.writeFileSync(path.join(__dirname, 'verify-migration-result.json'), JSON.stringify({ pass, checks }, null, 2));
process.exitCode = pass ? 0 : 1;
