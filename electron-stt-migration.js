/**
 * One-time settings migration: retire the legacy on-device Vosk engine.
 *
 * The voice initiative replaced the old `vosk-offline` provider (Vosk small
 * en-US WASM) with on-device Parakeet (sherpa-onnx) and flipped the default to
 * `local-parakeet`. But the active provider is resolved as
 * `settings.sttProvider || DEFAULT`, so the flip only reaches profiles that have
 * NO `sttProvider` saved. Anyone with `sttProvider: "vosk-offline"` would stay on
 * the retired engine forever. This migration moves them onto the current default
 * and reclaims the old ~40 MB Vosk model archive.
 *
 * Pure fs logic: the caller supplies `userDataDir` (and the default provider id)
 * so this is unit-testable without Electron. Self-limiting + idempotent — the
 * only trigger is the exact string `vosk-offline`, which the migration overwrites.
 */
import fs from 'node:fs';
import path from 'node:path';

const LEGACY_PROVIDER_ID = 'vosk-offline';

/**
 * @param {string} userDataDir       app.getPath('userData')
 * @param {string} defaultProviderId provider to migrate to (DEFAULT_TRANSCRIPTION_PROVIDER_ID)
 * @returns {{ migrated: boolean, reason?: string }}
 */
export function migrateLegacyVoskProvider(userDataDir, defaultProviderId) {
  const settingsPath = path.join(userDataDir, 'settings.json');

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return { migrated: false, reason: 'no-settings' };
  }
  if (!settings || settings.sttProvider !== LEGACY_PROVIDER_ID) {
    return { migrated: false, reason: 'not-vosk' };
  }

  // Flip the provider and persist atomically (write tmp + rename), matching the
  // app's writeJsonAtomic behavior so a crash mid-write can't corrupt settings.
  settings.sttProvider = defaultProviderId;
  const tmp = `${settingsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, settingsPath);

  // Reclaim the now-orphaned Vosk model archive (best-effort).
  try {
    fs.rmSync(path.join(userDataDir, 'voskModels'), { recursive: true, force: true });
  } catch { /* leave it if locked; harmless */ }

  return { migrated: true };
}
