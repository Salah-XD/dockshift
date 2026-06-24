/**
 * Local STT model catalog — download, verify (SHA-256), extract, status, remove.
 *
 * Generalizes the Vosk-only first-use downloader (`stt:voskModel:*` in
 * electron-main.js) to a multi-model catalog for the `localNative` providers
 * (Parakeet / Whisper). Models are never bundled in the installer; they download
 * on first use into `userData/sttModels/<id>/`, are verified by SHA-256 before
 * extraction, and are marked ready with a `.ready.json` manifest.
 *
 * Used by `electron-transcription-providers.js` (to resolve a provider's model
 * directory for `electron-sherpa-engine.js`) and by the `stt:model:*` IPC
 * handlers in electron-main.js (catalog list / download / remove).
 *
 * Security invariant (spec §10): we NEVER extract an archive whose SHA-256 is
 * unknown or mismatched. Catalog entries without a pinned `sha256` are listed
 * but cannot be installed until a checksum is pinned.
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

/* ── Catalog (spec §5) ──────────────────────────────────────────────────────
 * `sha256` is the checksum of the downloadable archive. `installBytes` is the
 * approximate extracted footprint (for the "free up disk" UI). `modelType` maps
 * to the sherpa engine config. `languages: null` means "all / not restricted".
 */
const ASR_MODEL_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

export const MODEL_CATALOG = {
  'parakeet-v3': {
    id: 'parakeet-v3',
    label: 'Parakeet v3 (offline, 25 European languages)',
    modelType: 'nemo_transducer',
    archive: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    url: `${ASR_MODEL_BASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
    downloadBytes: 487170055,
    installBytes: 645 * 1024 * 1024,
    // 25 EU languages supported by Parakeet TDT 0.6B v3 (no Hindi/CJK/Arabic).
    languages: ['en', 'bg', 'hr', 'cs', 'da', 'nl', 'et', 'fi', 'fr', 'de', 'el',
      'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk'],
    default: true,
    // 1–5 qualitative ratings shown on the welcome comparison cards.
    accuracy: 4,
    speed: 5,
    timestamps: true, // sherpa returns token-level timestamps for this model
  },
  'parakeet-v2': {
    id: 'parakeet-v2',
    label: 'Parakeet v2 (offline, English only — best EN accuracy)',
    modelType: 'nemo_transducer',
    archive: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    url: `${ASR_MODEL_BASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
    sha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
    downloadBytes: 482468385,
    installBytes: 645 * 1024 * 1024,
    languages: ['en'],
    accuracy: 5,
    speed: 5,
    timestamps: true,
  },
  'whisper-medium': {
    id: 'whisper-medium',
    label: 'Whisper medium (offline, 99 languages incl. Hindi/CJK/Arabic)',
    modelType: 'whisper',
    archive: 'sherpa-onnx-whisper-medium.tar.bz2',
    url: `${ASR_MODEL_BASE}/sherpa-onnx-whisper-medium.tar.bz2`,
    sha256: null, // TODO: pin checksum + verify whisper engine path before enabling install
    downloadBytes: 1842 * 1024 * 1024,
    installBytes: 3000 * 1024 * 1024,
    languages: null, // multilingual — the non-European fallback
    accuracy: 5,
    speed: 2,
    timestamps: false,
  },
  'whisper-small': {
    id: 'whisper-small',
    label: 'Whisper small (offline, 99 languages, lighter)',
    modelType: 'whisper',
    archive: 'sherpa-onnx-whisper-small.tar.bz2',
    url: `${ASR_MODEL_BASE}/sherpa-onnx-whisper-small.tar.bz2`,
    sha256: null, // TODO: pin checksum + verify whisper engine path before enabling install
    downloadBytes: 610 * 1024 * 1024,
    installBytes: 1100 * 1024 * 1024,
    languages: null,
    accuracy: 4,
    speed: 3,
    timestamps: false,
  },
};

export const DEFAULT_MODEL_ID = 'parakeet-v3';

/* ── Paths ──────────────────────────────────────────────────────────────── */

export function getModelsDir(opts = {}) {
  return opts.modelsDir || path.join(app.getPath('userData'), 'sttModels');
}
export function getModelDir(id, opts = {}) {
  return path.join(getModelsDir(opts), id);
}
function markerPath(id, opts = {}) {
  return path.join(getModelDir(id, opts), '.ready.json');
}

/* ── Catalog accessors ──────────────────────────────────────────────────── */

export function getModel(id) {
  return MODEL_CATALOG[id] || null;
}

/** Does this model claim to support `lang` (ISO-639-1)? `null` languages = all. */
export function modelSupportsLanguage(id, lang) {
  const m = getModel(id);
  if (!m) return false;
  if (!m.languages) return true;
  if (!lang || lang === 'auto') return true;
  return m.languages.includes(String(lang).split('-')[0].toLowerCase());
}

/* ── Required-file check (mirrors the engine's resolver) ────────────────── */

function hasFile(dir, ...names) {
  return names.some((n) => fs.existsSync(path.join(dir, n)));
}
function requiredFilesPresent(dir, modelType) {
  if (!hasFile(dir, 'tokens.txt')) return false;
  if (modelType === 'nemo_transducer') {
    return hasFile(dir, 'encoder.int8.onnx', 'encoder.onnx')
      && hasFile(dir, 'decoder.int8.onnx', 'decoder.onnx')
      && hasFile(dir, 'joiner.int8.onnx', 'joiner.onnx');
  }
  if (modelType === 'whisper') {
    // sherpa whisper packages may prefix file names with the model size.
    const enc = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /encoder.*\.onnx$/.test(f));
    const dec = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /decoder.*\.onnx$/.test(f));
    return enc && dec;
  }
  return false;
}

/* ── Status ─────────────────────────────────────────────────────────────── */

export function isInstalled(id, opts = {}) {
  const m = getModel(id);
  if (!m) return false;
  const dir = getModelDir(id, opts);
  return fs.existsSync(markerPath(id, opts)) && requiredFilesPresent(dir, m.modelType);
}

function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) total += dirSizeBytes(p);
      else total += fs.statSync(p).size;
    } catch { /* skip */ }
  }
  return total;
}

/** A model is "multilingual" if it has no language restriction or more than one. */
export function isMultilingual(id) {
  const m = getModel(id);
  if (!m) return false;
  return m.languages === null || (Array.isArray(m.languages) && m.languages.length > 1);
}

export function getStatus(id, opts = {}) {
  const m = getModel(id);
  if (!m) return { id, installed: false, error: `Unknown model: ${id}` };
  const installed = isInstalled(id, opts);
  return {
    id,
    label: m.label,
    modelType: m.modelType,
    languages: m.languages,
    multilingual: isMultilingual(id),
    accuracy: m.accuracy ?? null,
    speed: m.speed ?? null,
    installable: !!m.sha256,
    installed,
    downloading: isDownloading(id),
    downloadBytes: m.downloadBytes,
    installBytes: m.installBytes,
    sizeOnDisk: installed ? dirSizeBytes(getModelDir(id, opts)) : 0,
    isDefault: !!m.default,
  };
}

/** Catalog shape sent to the renderer (`stt:models:list`). */
export function listModels(opts = {}) {
  return Object.keys(MODEL_CATALOG).map((id) => getStatus(id, opts));
}

/* ── SHA-256 verification ───────────────────────────────────────────────── */

export function sha256File(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const total = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();
    let read = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      read += chunk.length;
      onProgress?.(read, total);
    });
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function verifyArchive(filePath, expectedSha256, onProgress) {
  if (!expectedSha256) {
    throw new Error('refusing to install: no pinned SHA-256 for this model');
  }
  const actual = await sha256File(filePath, onProgress);
  if (actual.toLowerCase() !== String(expectedSha256).toLowerCase()) {
    throw new Error(`checksum mismatch: expected ${expectedSha256}, got ${actual}`);
  }
  return actual;
}

/* ── Extraction ─────────────────────────────────────────────────────────── */

/**
 * Extract a `.tar.bz2`/`.tar.gz` into `destDir`, stripping the archive's single
 * top-level folder so model files land directly in destDir. Uses Windows' bundled
 * bsdtar (`tar`), which auto-detects bzip2/gzip.
 */
export function extractArchiveTo(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    execFile('tar', ['-xf', archivePath, '--strip-components=1', '-C', destDir], (err, _stdout, stderr) => {
      if (err) reject(new Error(`extract failed: ${stderr || err.message}`));
      else resolve(destDir);
    });
  });
}

/* ── Install pipeline ───────────────────────────────────────────────────── */

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeMarker(id, sha256, opts = {}) {
  const m = getModel(id);
  fs.writeFileSync(markerPath(id, opts), JSON.stringify({
    id, sha256, modelType: m.modelType, installedAt: new Date().toISOString(),
  }, null, 2));
}

/**
 * Verify a local archive and extract it into the model's slot atomically:
 * extract into `<id>.incoming`, validate required files, then swap into place
 * and write the ready marker. Factored out so it can be tested without a network
 * download (and reused by `downloadModel`).
 */
export async function installFromArchive(id, archivePath, { onProgress, ...opts } = {}) {
  const m = getModel(id);
  if (!m) throw new Error(`Unknown model: ${id}`);

  onProgress?.({ id, phase: 'verifying', downloaded: 0, total: m.downloadBytes });
  let lastVerifyAt = 0;
  await verifyArchive(archivePath, m.sha256, (read, total) => {
    // Throttle to ~100ms (like the download loop) so hashing a ~464MB file does
    // not flood the IPC channel with thousands of progress events.
    const now = Date.now();
    if (now - lastVerifyAt > 100 || read === total) {
      onProgress?.({ id, phase: 'verifying', downloaded: read, total });
      lastVerifyAt = now;
    }
  });

  const finalDir = getModelDir(id, opts);
  const incoming = `${finalDir}.incoming`;
  rmrf(incoming);

  onProgress?.({ id, phase: 'extracting', downloaded: 0, total: m.installBytes });
  await extractArchiveTo(archivePath, incoming);
  if (!requiredFilesPresent(incoming, m.modelType)) {
    rmrf(incoming);
    throw new Error(`extracted archive is missing required ${m.modelType} files`);
  }

  rmrf(finalDir);
  fs.renameSync(incoming, finalDir);
  writeMarker(id, m.sha256, opts);
  onProgress?.({ id, phase: 'done', downloaded: m.downloadBytes, total: m.downloadBytes });
  return { ok: true, id, dir: finalDir };
}

/**
 * Download a model archive (with resume), verify, extract, mark ready.
 *
 * @param {string} id
 * @param {object} [args]
 * @param {(p:{id,phase,downloaded,total})=>void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.modelsDir]   override base dir (testing)
 */
/** Models with a download currently in flight (dedupes welcome + panel triggers). */
const _downloading = new Set();
export function isDownloading(id) { return _downloading.has(id); }

export async function downloadModel(id, { onProgress, signal, ...opts } = {}) {
  const m = getModel(id);
  if (!m) return { ok: false, error: `Unknown model: ${id}` };
  if (!m.sha256) return { ok: false, error: `${m.label}: checksum not pinned yet — install disabled.` };
  if (_downloading.has(id)) return { ok: true, id, inFlight: true };
  if (isInstalled(id, opts)) return { ok: true, id, dir: getModelDir(id, opts), alreadyInstalled: true };
  _downloading.add(id);

  const dir = getModelsDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  const archivePath = path.join(dir, m.archive);
  const partPath = `${archivePath}.part`;

  const emit = (phase, downloaded, total) => onProgress?.({ id, phase, downloaded, total });

  try {
    // Resume if a partial download exists.
    let startAt = 0;
    try { startAt = fs.statSync(partPath).size; } catch { startAt = 0; }

    emit('starting', startAt, m.downloadBytes);
    const headers = startAt > 0 ? { Range: `bytes=${startAt}-` } : {};
    const response = await fetch(m.url, { redirect: 'follow', headers, signal });
    if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('empty response body');

    const resuming = response.status === 206;
    if (!resuming) startAt = 0; // server ignored Range — restart cleanly
    const headerTotal = parseInt(response.headers.get('content-length') || '0', 10);
    const total = (resuming && headerTotal > 0) ? startAt + headerTotal
      : (headerTotal > 0 ? headerTotal : m.downloadBytes);

    const file = fs.createWriteStream(partPath, { flags: resuming ? 'a' : 'w' });
    const reader = response.body.getReader();
    let downloaded = startAt;
    let lastAt = 0;
    const writeChunk = (chunk) => new Promise((res, rej) => file.write(chunk, (e) => (e ? rej(e) : res())));

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writeChunk(value);
      downloaded += value.length;
      const now = Date.now();
      if (now - lastAt > 100) { emit('downloading', downloaded, total); lastAt = now; }
    }
    await new Promise((res, rej) => file.end((e) => (e ? rej(e) : res())));

    fs.renameSync(partPath, archivePath);

    // Verify + extract + mark ready.
    await installFromArchive(id, archivePath, { onProgress, ...opts });

    // The archive is no longer needed once extracted.
    try { fs.unlinkSync(archivePath); } catch { /* keep if locked; harmless */ }
    return { ok: true, id, dir: getModelDir(id, opts) };
  } catch (err) {
    // Keep `.part` so a retry can resume; only the verified archive/dir are cleaned.
    const msg = err?.name === 'AbortError' ? 'cancelled' : (err?.message || 'download failed');
    emit('error', 0, m.downloadBytes);
    return { ok: false, error: msg };
  } finally {
    _downloading.delete(id);
  }
}

/* ── Removal ────────────────────────────────────────────────────────────── */

export function removeModel(id, opts = {}) {
  const dir = getModelDir(id, opts);
  rmrf(dir);
  rmrf(`${dir}.incoming`);
  try { fs.unlinkSync(path.join(getModelsDir(opts), getModel(id)?.archive || '')); } catch { /* ignore */ }
  return { ok: true, id };
}
