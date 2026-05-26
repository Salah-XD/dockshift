import { app, BrowserWindow, globalShortcut, screen, ipcMain, clipboard, nativeImage, shell, desktopCapturer, Tray, Menu, protocol } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import pty from 'node-pty';
import { spawn } from 'child_process';
import { SnapshotManager } from './src/workspace/SnapshotManager.js';
import { WindowTracker } from './src/workspace/WindowTracker.js';
import { TerminalManager } from './src/workspace/TerminalManager.js';
import { readJson, writeJsonAtomic, setCorruptionNotifier } from './electron-persistence.js';
import { setSecret, getSecret, hasSecret, deleteSecret, listSecrets, isEncryptionAvailable } from './electron-secrets.js';
import { PROVIDER_LIST, getProvider } from './electron-ai-providers.js';
import {
  TRANSCRIPTION_PROVIDER_LIST,
  DEFAULT_TRANSCRIPTION_PROVIDER_ID,
  getTranscriptionProvider,
  runTranscription,
  testTranscriptionProvider,
  TranscriptionError,
} from './electron-transcription-providers.js';
import { installShellIntegration, uninstallShellIntegration, isShellIntegrationInstalled, SHELL_INTEGRATION_VERSION } from './electron-shell-integration.js';
// electron-updater is CommonJS — interop via the default import.
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Custom protocol for the Vosk model file ──────────────────────────────────
// Must be registered as privileged BEFORE app.ready, so the renderer's `fetch`
// can load `vosk-model://en-us-small` like any other URL. The model file lives
// in userData/voskModels/ after first-use download; the actual handler in
// app.ready maps the protocol path to that file.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'vosk-model',
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true },
  },
]);

// ─── Load .env ────────────────────────────────────────────────────────────────
// Minimal .env parser (no dotenv dependency). Handles `KEY=value`, surrounding
// single/double quotes, inline `#` comments on unquoted values, and trims
// stray whitespace — the old regex kept quotes and trailing spaces verbatim,
// which silently broke API auth.
function parseEnvValue(raw) {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    // Quoted: strip the quotes, keep everything inside as-is.
    return value.slice(1, -1);
  }
  // Unquoted: a `#` begins a comment.
  const hashIndex = value.indexOf(' #');
  if (hashIndex !== -1) value = value.slice(0, hashIndex);
  return value.trim();
}

function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;
      if (process.env[key] !== undefined) continue; // real env wins
      process.env[key] = parseEnvValue(trimmed.slice(eq + 1));
    }
  } catch (err) {
    console.warn('[env] Failed to load .env:', err.message);
  }
}
loadEnv();

// ─── Single-instance lock ─────────────────────────────────────────────────────
// Required for the Windows shell-context-menu integration: when the user
// right-clicks a folder in Explorer and picks "Open with DockShift Terminal",
// Windows launches DockShift.exe again with `--shell-terminal "C:\..."` argv.
// We don't want two DockShifts running — instead, the second launch hands its
// argv to the first instance via the `second-instance` event below.
const SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!SINGLE_INSTANCE_LOCK) {
  // Another DockShift owns the lock. Quit immediately; the running instance
  // will receive our argv through `second-instance` and act on it.
  app.quit();
}

// Parse our custom `--shell-<kind> <path>` flags from a process argv array.
// Returns { type: 'terminal'|'note'|'clipboard', path: '...' } or null.
function parseShellArgs(argv) {
  if (!Array.isArray(argv)) return null;
  const flagIdx = argv.findIndex((a) => typeof a === 'string' && a.startsWith('--shell-'));
  if (flagIdx === -1) return null;
  const flag = argv[flagIdx];
  const pathArg = argv[flagIdx + 1];
  if (typeof pathArg !== 'string' || !pathArg) return null;
  let type;
  if (flag === '--shell-terminal') type = 'terminal';
  else if (flag === '--shell-note') type = 'note';
  else if (flag === '--shell-clipboard') type = 'clipboard';
  else return null;
  return { type, path: pathArg };
}

// Holds an intent parsed at first-launch (before mainWindow exists). The
// renderer-ready handler picks it up once panels are mounted.
let pendingShellIntent = parseShellArgs(process.argv);

// ─── Clipboard History Manager ────────────────────────────────────────────────

const HEX_COLOR_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
const URL_RE = /^(https?:\/\/|ftp:\/\/|www\.)\S+/i;
const MAX_HISTORY = 200;

// "Is this code?" — scored heuristic. Each regex contributes 1 point on match
// (some strong-signal regexes contribute 2). Total >= 2 → tagged as `code`.
// Strong signals alone are enough to flip a snippet; weak signals need a
// partner to avoid mis-tagging prose like "I like the function of this app".
const CODE_SIGNALS = [
  // ── JavaScript / TypeScript ──
  { re: /\b(function|const|let|var|class|extends|import|export|return|typeof|instanceof)\b/, w: 1 },
  { re: /\b(async|await|yield|new|delete|undefined|null)\b/, w: 1 },
  { re: /=>\s*[{(]/, w: 2 },
  { re: /\bconsole\.(log|warn|error|info|debug)\s*\(/, w: 2 },
  { re: /\b(useState|useEffect|useMemo|useCallback|useRef)\s*\(/, w: 2 },

  // ── Python ──
  { re: /\b(def|elif|lambda|self|None|True|False|pass|yield|raise|with|as|nonlocal|global)\b/, w: 1 },
  { re: /^\s*from\s+\S+\s+import\b/m, w: 2 },
  { re: /^\s*import\s+\S+(\s+as\s+\S+)?\s*$/m, w: 1 },
  { re: /\bprint\s*\(/, w: 1 },
  { re: /:\s*$/m, w: 1 },

  // ── Java / C# / C / C++ ──
  { re: /\b(public|private|protected|static|void|int|String|float|double|long|short|boolean)\b/, w: 1 },
  { re: /^\s*(#include|#define|using\s+namespace)/m, w: 2 },
  { re: /\b(std::|namespace\s+\w+|template\s*<)/, w: 2 },

  // ── Rust / Go ──
  { re: /\b(fn|impl|trait|pub|mut|let\s+mut|match|enum|struct)\b/, w: 1 },
  { re: /\b(func|package|defer|chan|goroutine|interface)\b/, w: 1 },
  { re: /::\w+/, w: 1 },

  // ── SQL ──
  { re: /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT)\b/i, w: 1 },
  { re: /\b(CREATE|ALTER|DROP|TABLE|INDEX|VIEW|DATABASE|SCHEMA)\s+(TABLE|INDEX|VIEW|IF\s+(NOT\s+)?EXISTS|\w+)/i, w: 2 },

  // ── Shell ──
  { re: /^\s*#!\s*\/(usr\/)?bin\//, w: 3 },
  { re: /^\s*\$\s+\S+/m, w: 1 },
  { re: /\b(echo|grep|awk|sed|curl|wget|chmod|chown|sudo|apt-get|brew|npm|yarn|pnpm|pip|cargo|docker|kubectl|git)\s+/, w: 1 },
  { re: /\|\s*(grep|awk|sed|sort|uniq|head|tail|xargs|jq)\b/, w: 2 },

  // ── HTML / JSX / XML ──
  { re: /<\/?[a-zA-Z][\w-]*(\s+[\w-]+(=("[^"]*"|'[^']*'|\{[^}]*\}))?)*\s*\/?>/, w: 1 },
  { re: /^\s*(<\?xml|<!DOCTYPE|<html|<script|<style|<svg|<head|<body)/i, w: 2 },
  { re: /\bclassName\s*=\s*["{]/, w: 2 },

  // ── CSS / SCSS ──
  { re: /^\s*[.#&]?[\w-]+\s*\{[^}]*\}/m, w: 1 },
  { re: /^\s*[\w-]+\s*:\s*[^;]+;/m, w: 1 },
  { re: /@(media|keyframes|import|supports|font-face|tailwind|apply)\b/, w: 2 },
  { re: /\b(rgb|rgba|hsl|hsla|var)\s*\(/, w: 1 },

  // ── JSON / YAML / TOML ──
  { re: /^\s*\{[\s\S]*"[^"]+"\s*:/m, w: 1 },
  { re: /^\s*[\w-]+\s*:\s*(true|false|\d+|".*"|\[)/m, w: 1 },
  { re: /^\s*\[[\w-]+(\.[\w-]+)*\]\s*$/m, w: 2 },

  // ── Comments ──
  { re: /^\s*\/\/[^\n]*/m, w: 1 },
  { re: /\/\*[\s\S]*?\*\//, w: 1 },
  { re: /^\s*#\s+\w+/m, w: 1 },
  { re: /^\s*--\s+\w+/m, w: 1 },

  // ── Markdown fenced code ──
  { re: /```[\s\S]*```/, w: 3 },

  // ── Control flow & generic code shapes ──
  { re: /^\s*(if|for|while|switch|case|do|try|catch|finally|throw)\s*[({:]/m, w: 1 },
  { re: /[{};]\s*$/m, w: 1 },
  { re: /\b(true|false|null|nil)\b\s*[,;)\]}]/, w: 1 },
  { re: /==|!=|===|!==|<=|>=|&&|\|\||::|=>|->|\?\?/, w: 1 },
  { re: /^\s{2,}[^\s].*[{};:]\s*$/m, w: 1 }, // indented line ending with brace/semicolon/colon

  // ── PHP / Ruby / Perl sigils ──
  { re: /<\?php\b/, w: 3 },
  { re: /\$\w+\s*=\s*/, w: 1 },
  { re: /\b(end|require|require_relative|gem|attr_accessor)\b/, w: 1 },
];

function scoreCode(text) {
  let score = 0;
  for (const { re, w } of CODE_SIGNALS) {
    if (re.test(text)) score += w;
    if (score >= 3) return score;
  }
  return score;
}

/**
 * Build a Windows CF_HDROP clipboard buffer.
 * Structure: DROPFILES header (20 bytes) + UTF-16LE null-separated path list + double-null.
 *
 * typedef struct _DROPFILES {
 *   DWORD pFiles;  // offset to file list = 20
 *   POINT pt;      // drop point (ignored, set to 0,0)
 *   BOOL  fNC;     // non-client drop (false = 0)
 *   BOOL  fWide;   // Unicode paths (true = 1)
 * } DROPFILES;
 */
function buildCFHDROP(filePaths) {
  const header = Buffer.alloc(20);
  header.writeUInt32LE(20, 0);  // pFiles: file list starts right after header
  header.writeUInt32LE(0,  4);  // pt.x
  header.writeUInt32LE(0,  8);  // pt.y
  header.writeUInt32LE(0, 12);  // fNC = false
  header.writeUInt32LE(1, 16);  // fWide = true → UTF-16LE paths
  // Null-separated paths + double-null terminator, UTF-16LE
  const pathStr = filePaths.join('\0') + '\0\0';
  const pathBuf = Buffer.from(pathStr, 'ucs2');
  return Buffer.concat([header, pathBuf]);
}

class ClipboardHistoryManager {
  constructor(userDataPath) {
    this.historyFile = path.join(userDataPath, 'clipboard-history.json');
    this.imagesDir = path.join(userDataPath, 'clipboard-images');
    this.history = [];
    this.maxHistory = MAX_HISTORY; // overridable via the Settings panel
    this._lastHash = null;
    this._pollInterval = null;
    this._win = null;
    this._ensureDirs();
    this._load();
  }

  /**
   * Update the history cap (from the `clipboardMaxItems` setting) and trim
   * immediately if the new cap is smaller than the current history.
   * @param {number} limit
   */
  setMaxHistory(limit) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n < 1) return;
    this.maxHistory = Math.floor(n);
    if (this.history.length > this.maxHistory) {
      const removed = this.history.splice(this.maxHistory);
      for (const old of removed) {
        if (old.type === 'image' && old.content && fs.existsSync(old.content)) {
          fs.unlink(old.content, () => {});
        }
      }
      this._save();
    }
  }

  _ensureDirs() {
    fs.mkdirSync(this.imagesDir, { recursive: true });
  }

  _load() {
    // readJson preserves a corrupted history file as a `.corrupt-<ts>` backup
    // and notifies, instead of silently starting from an empty list.
    this.history = readJson(this.historyFile, []);
  }

  _save() {
    try {
      writeJsonAtomic(this.historyFile, this.history);
    } catch (e) {
      console.warn('[ClipboardHistory] Save error:', e.message);
    }
  }

  _hash(str) {
    return crypto.createHash('sha1').update(str).digest('hex');
  }

  _detectType(text) {
    const trimmed = text.trim();
    if (HEX_COLOR_RE.test(trimmed)) return 'color';
    if (URL_RE.test(trimmed)) return 'link';
    if (trimmed.length >= 6 && scoreCode(trimmed) >= 2) return 'code';
    return 'text';
  }

  _poll() {
    try {
      const formats = clipboard.availableFormats();

      // ── 1. Files — always try CF_HDROP directly (availableFormats returns MIME types,
      //    NOT Windows format names, so we can't gate on format strings) ──
      try {
        const rawFiles = clipboard.readBuffer('CF_HDROP');
        if (rawFiles && rawFiles.length > 20) {
          const pFiles = rawFiles.readUInt32LE(0);
          const fWide  = rawFiles.readUInt32LE(16);
          const pathBuf = rawFiles.slice(pFiles);
          const raw = fWide ? pathBuf.toString('ucs2') : pathBuf.toString('ascii');
          const paths = raw.split('\0').map(p => p.trim()).filter(Boolean);
          if (paths.length > 0) {
            const key = paths.join('\n');
            const hash = this._hash(key);
            if (hash !== this._lastHash) {
              this._push({ type: 'file', content: key, paths, preview: paths[0] });
              this._lastHash = hash;
            }
            return;
          }
        }
      } catch (_) { /* no CF_HDROP data — continue */ }

      // ── 2. Images — check MIME types from availableFormats ──
      if (formats.some(f => f.startsWith('image/'))) {
        const img = clipboard.readImage();
        if (!img.isEmpty()) {
          const pngData = img.toPNG();
          const hash = this._hash(pngData.toString('base64').slice(0, 256));
          if (hash !== this._lastHash) {
            try {
              const filename = `${Date.now()}.png`;
              const imgPath = path.join(this.imagesDir, filename);
              fs.writeFileSync(imgPath, pngData);

              let preview;
              try {
                const { width } = img.getSize();
                const thumbImg = width > 300 ? img.resize({ width: 300 }) : img;
                preview = `data:image/png;base64,${thumbImg.toPNG().toString('base64')}`;
              } catch (_) {
                preview = `data:image/png;base64,${pngData.toString('base64')}`;
              }

              this._push({ type: 'image', content: imgPath, preview });
              this._lastHash = hash;
            } catch (e) {
              console.warn('[ClipboardHistory] Image capture error:', e.message);
            }
          }
          return;
        }
      }

      // ── 3. Text / Links / Colors ──
      const text = clipboard.readText();
      if (!text) return;
      const hash = this._hash(text);
      if (hash === this._lastHash) return;
      this._lastHash = hash;

      const type = this._detectType(text);
      this._push({ type, content: text, preview: text });

    } catch (e) {
      console.warn('[ClipboardHistory] Poll error:', e.message);
    }
  }

  _push(partial) {
    const item = {
      id: crypto.randomUUID(),
      type: partial.type,
      content: partial.content,
      preview: partial.preview,
      timestamp: new Date().toISOString(),
    };

    // Deduplicate against most recent same-type item
    const recent = this.history.find(h => h.type === item.type && h.content === item.content);
    if (recent) {
      // Bubble to top with new timestamp instead of duplicating
      this.history = this.history.filter(h => h.id !== recent.id);
      recent.timestamp = item.timestamp;
      this.history.unshift(recent);
    } else {
      this.history.unshift(item);
      if (this.history.length > this.maxHistory) {
        const removed = this.history.splice(this.maxHistory);
        // Clean up orphaned image files
        for (const old of removed) {
          if (old.type === 'image' && old.content && fs.existsSync(old.content)) {
            fs.unlink(old.content, () => { });
          }
        }
      }
    }

    this._save();

    // ── Notify renderer ──────────────────────────────────────────────
    if (this._win && !this._win.isDestroyed()) {
      // IMPORTANT: send `recent` in the dedup path, NOT `item`.
      // If we sent `item` (new UUID) the renderer would store a different id
      // than what this.history holds, making copyItem(id) fail silently.
      const toSend = recent ?? item;
      this._win.webContents.send('clipboard:newItem', toSend);
    }
  }

  start(win) {
    this._win = win;
    if (this._pollInterval) return;
    // Seed hash from current clipboard so we don't immediately re-add existing content
    try {
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const pngData = img.toPNG();
        this._lastHash = this._hash(pngData.toString('base64').slice(0, 256));
      } else {
        const text = clipboard.readText();
        if (text) this._lastHash = this._hash(text);
      }
    } catch (_) { }
    this._pollInterval = setInterval(() => this._poll(), 500);
  }

  stop() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  getHistory() { return this.history; }

  deleteItem(id) {
    const item = this.history.find(h => h.id === id);
    if (item && item.type === 'image' && item.content && fs.existsSync(item.content)) {
      fs.unlink(item.content, () => { });
    }
    this.history = this.history.filter(h => h.id !== id);
    this._save();
  }

  clearAll() {
    for (const item of this.history) {
      if (item.type === 'image' && item.content && fs.existsSync(item.content)) {
        fs.unlink(item.content, () => { });
      }
    }
    this.history = [];
    this._save();
  }

  copyItem(id) {
    const item = this.history.find(h => h.id === id);
    if (!item) {
      console.warn('[ClipboardHistory] copyItem: id not found:', id);
      return false;
    }

    if (item.type === 'image') {
      try {
        // Primary: read from the saved PNG file
        const data = fs.readFileSync(item.content);
        const img  = nativeImage.createFromBuffer(data);
        clipboard.writeImage(img);
        this._lastHash = this._hash(img.toPNG().toString('base64').slice(0, 256));
      } catch (_) {
        // Fallback: recreate from the preview thumbnail stored in memory
        try {
          const b64 = item.preview.replace(/^data:image\/png;base64,/, '');
          const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
          clipboard.writeImage(img);
          this._lastHash = this._hash(img.toPNG().toString('base64').slice(0, 256));
        } catch (e2) {
          console.warn('[ClipboardHistory] copyItem image fallback error:', e2.message);
          return false;
        }
      }

    } else if (item.type === 'file') {
      // Prefer the stored paths array; fall back to parsing the content string
      const paths = Array.isArray(item.paths) && item.paths.length
        ? item.paths
        : item.content.split('\n').map(f => f.trim()).filter(Boolean);

      let written = false;
      try {
        // Primary: CF_HDROP (required for Windows Explorer file paste)
        const buf = buildCFHDROP(paths);
        clipboard.writeBuffer('CF_HDROP', buf);
        written = true;
      } catch (e1) {
        console.warn('[ClipboardHistory] CF_HDROP write error:', e1.message);
      }

      if (!written) {
        try {
          // Secondary: FileNameW (works in some apps but not Explorer)
          const buf = Buffer.from(paths.join('\0') + '\0\0', 'ucs2');
          clipboard.writeBuffer('FileNameW', buf);
          written = true;
        } catch (e2) {
          console.warn('[ClipboardHistory] FileNameW write error:', e2.message);
        }
      }

      if (!written) return false; // do not fall back to text for files
      this._lastHash = this._hash(item.content);

    } else {
      clipboard.writeText(item.content);
      this._lastHash = this._hash(item.content);
    }

    return true;
  }
}

let clipboardHistory = null;
function getClipboardHistory() {
  if (!clipboardHistory) {
    clipboardHistory = new ClipboardHistoryManager(app.getPath('userData'));
  }
  return clipboardHistory;
}

let mainWindow;
let isVisible = true;
let isDockExpanded = false;

// When a stored JSON file is found corrupted, tell the user instead of
// silently dropping their data — the original file is preserved as a
// `.corrupt-<ts>` backup by the persistence layer.
setCorruptionNotifier((filePath, backupPath) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('show-notification', {
    title: 'Recovered from a corrupted file',
    body: backupPath
      ? `${path.basename(filePath)} was unreadable. A backup was saved so nothing is lost.`
      : `${path.basename(filePath)} was unreadable and has been reset.`,
  });
});

/** @type {SnapshotManager | null} */
let snapshotManager = null;
const windowTracker = new WindowTracker();
const terminalManager = new TerminalManager();

// ─── Dock window ─────────────────────────────────────────────────────────────
// The window is a single, permanently fullscreen, transparent overlay — it is
// NEVER resized. Resizing a transparent window on Windows is visibly janky (the
// dock bar slides, because the OS changes x and width on separate frames), so:
//   • the window always covers the whole work area;
//   • while no panel is open it is made click-through with setIgnoreMouseEvents,
//     so the transparent area doesn't swallow clicks meant for the desktop —
//     the renderer re-enables hit-testing while the cursor is over the dock bar
//     (or a panel is open);
//   • the dock bar is positioned and dragged entirely in the renderer, since
//     `-webkit-app-region: drag` would drag the whole fullscreen window.
function getWorkArea() {
  return screen.getPrimaryDisplay().workAreaSize;
}

function getSnapshotManager() {
  if (!snapshotManager) {
    const workspaceDir = path.join(app.getPath('userData'), 'workspaces');
    snapshotManager = new SnapshotManager(workspaceDir);
  }
  return snapshotManager;
}

function createWindow() {
  // One permanently fullscreen, transparent overlay — never resized.
  const { width: sw, height: sh } = getWorkArea();

  mainWindow = new BrowserWindow({
    width: sw,
    height: sh,
    x: 0,
    y: 0,
    // important for clean overlay on Windows
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    // Non-activating overlay: clicking the dock bar (or any non-typing area)
    // must NOT pull focus from whatever the user is typing in. Typing panels
    // (Launcher, Notes, Terminal, HotkeyRecorder…) flip focusable→true on
    // demand via the `dock:activate` IPC; the blur handler resets it.
    focusable: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
    show: false,
  });

  const isDevelopment = process.env.NODE_ENV === 'development' || !app.isPackaged;
  const devPort = process.env.VITE_PORT || '5179';
  const indexPath = isDevelopment
    ? `http://localhost:${devPort}`
    : `file://${path.join(__dirname, 'dist', 'index.html')}`;

  // Click-outside-to-close: when the window loses focus while a panel is open
  // (user clicked another app, the taskbar, alt-tabbed away), tell the renderer
  // to collapse. The renderer owns panel state and does the actual close.
  // Also reset focusable→false so the next dock-bar click stays non-activating
  // (it gets flipped back to true on demand by `dock:activate`).
  mainWindow.on('blur', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFocusable(false);
      if (isDockExpanded) mainWindow.webContents.send('dock:blurClose');
    }
  });

  mainWindow.loadURL(indexPath);
  mainWindow.showInactive();

  // Collapsed by default → the fullscreen overlay is click-through everywhere.
  // The renderer re-enables hit-testing over the dock bar via dock:setMouseIgnore.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // Start clipboard history monitoring
  getClipboardHistory().start(mainWindow);

  // Apply saved preferences so they actually take effect on launch.
  applySettings(readSettings());

  // Hydrate the in-memory dock layout from disk so the renderer can ask
  // `dock:layout:get` and immediately get the user's last session.
  currentDockLayout = readDockLayout();

  // DevTools is NOT auto-opened. While DevTools is open, Chromium overlays the
  // live viewport size in the page corner on every window resize — which fires
  // each time the dock collapses/expands, and reads as a distracting flicker.
  // Open it manually with Ctrl+Shift+I, or set DOCKSHIFT_DEVTOOLS=1 to auto-open.
  if (isDevelopment && process.env.DOCKSHIFT_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ─── Welcome window ──────────────────────────────────────────────────────────
// Standalone first-run window with a normal Windows chrome and a taskbar entry.
// Lives as a separate BrowserWindow from the dock so it can have `frame: true`,
// `skipTaskbar: false`, and `transparent: false` — the dock's overlay options
// make it invisible to alt-tab and the taskbar, which is wrong for onboarding.
// Same Vite bundle is reused via a `#welcome` hash that src/main.jsx routes on.
let welcomeWindow = null;

function createWelcomeWindow() {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.focus();
    return;
  }
  welcomeWindow = new BrowserWindow({
    width: 720,
    height: 520,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: true,
    center: true,
    title: 'Welcome to DockShift',
    icon: path.join(app.getAppPath(), 'assets', 'icon.ico'),
    backgroundColor: '#101218',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false,
  });

  const isDevelopment = process.env.NODE_ENV === 'development' || !app.isPackaged;
  const devPort = process.env.VITE_PORT || '5179';
  const url = isDevelopment
    ? `http://localhost:${devPort}/#welcome`
    : `file://${path.join(__dirname, 'dist', 'index.html')}#welcome`;

  welcomeWindow.loadURL(url);
  welcomeWindow.once('ready-to-show', () => welcomeWindow?.show());

  // Closing the welcome window before completing onboarding quits the app —
  // we never want to land the user on the dock without them having seen the
  // terms checkbox.
  welcomeWindow.on('closed', () => {
    const wasCompleted = !!readSettings().hasCompletedWelcome;
    welcomeWindow = null;
    if (!wasCompleted && !mainWindow) {
      app.quit();
    }
  });
}

// Bring up the dock window, tray, and global shortcuts. Extracted so it can be
// called either at startup (when welcome was already completed) or after the
// user clicks "Get started" in the welcome window.
function startDock() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    return;
  }
  createWindow();
  createTray();

  const saved = readSettings().toggleDockShortcut;
  const r = registerToggleShortcut(saved || DEFAULT_TOGGLE_SHORTCUT);
  if (!r.ok && saved) {
    registerToggleShortcut(DEFAULT_TOGGLE_SHORTCUT);
  }
}

// In-memory mirror of the persisted dock layout. The renderer pushes updates
// here every time the user opens/closes a panel; we lazy-write them to disk
// (debounced) and read them on startup. `getCurrentDockLayoutSnapshot()`
// exposes the live value to the workspace snapshot path.
const dockLayoutFile = () => path.join(app.getPath('userData'), 'dock-layout.json');
const DEFAULT_DOCK_LAYOUT = {
  activeTabId: null,
  openWidgets: [],
  position: 'bottom-center',
};
let currentDockLayout = { ...DEFAULT_DOCK_LAYOUT };
let dockLayoutWriteTimer = null;

function readDockLayout() {
  const stored = readJson(dockLayoutFile(), null);
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_DOCK_LAYOUT };
  return { ...DEFAULT_DOCK_LAYOUT, ...stored };
}

function scheduleDockLayoutWrite() {
  if (dockLayoutWriteTimer) clearTimeout(dockLayoutWriteTimer);
  dockLayoutWriteTimer = setTimeout(() => {
    dockLayoutWriteTimer = null;
    try {
      writeJsonAtomic(dockLayoutFile(), currentDockLayout);
    } catch (err) {
      console.warn('[dock-layout] write failed:', err.message);
    }
  }, 400);
}

function getCurrentDockLayoutSnapshot() {
  return { ...currentDockLayout };
}

function getCurrentTerminalSnapshots() {
  // If you track terminals in-app, return them here. For now, snapshot is empty.
  return [];
}

// Notification handler - send to renderer to display
ipcMain.handle('notify', (event, { title, body }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('show-notification', { title, body });
  }
  return { success: true };
});

// ─── Clipboard History IPC ────────────────────────────────────────────────────
ipcMain.handle('clipboard:getHistory', () => {
  return getClipboardHistory().getHistory();
});

ipcMain.handle('clipboard:deleteItem', (_event, { id }) => {
  getClipboardHistory().deleteItem(id);
  return { ok: true };
});

ipcMain.handle('clipboard:clearAll', () => {
  getClipboardHistory().clearAll();
  return { ok: true };
});

ipcMain.handle('clipboard:copyItem', (_event, { id }) => {
  return getClipboardHistory().copyItem(id);
});

// Workspace Snapshot IPC
ipcMain.handle('workspace:save', async (_event, { name }) => {
  // Sanitize up front so the stored `name` field matches the on-disk filename
  // and never carries path-traversal payloads.
  const safeName = SnapshotManager.sanitizeName(name);

  const apps = await windowTracker.captureAppSnapshotsAsync();
  const terminals = getCurrentTerminalSnapshots();
  const dockLayout = getCurrentDockLayoutSnapshot();

  const snapshot = {
    name: safeName,
    createdAt: new Date().toISOString(),
    apps,
    terminals,
    dockLayout,
  };

  const manager = getSnapshotManager();
  await manager.saveSnapshot(safeName, snapshot);
  return snapshot;
});

ipcMain.handle('workspace:list', async () => {
  const manager = getSnapshotManager();
  const snapshots = await manager.listSnapshots();
  return snapshots;
});

ipcMain.handle('workspace:restore', async (event, { name }) => {
  const manager = getSnapshotManager();
  const snapshot = await manager.loadSnapshot(name);
  if (!snapshot) throw new Error(`Workspace "${name}" not found`);

  await windowTracker.restoreFromSnapshots(snapshot.apps || []);
  terminalManager.restoreTerminals(snapshot.terminals || []);

  // Notify renderer to restore dock layout
  event.sender.send('workspace:dockLayoutRestore', snapshot.dockLayout || null);

  return { ok: true };
});

ipcMain.handle('workspace:delete', async (_event, { name }) => {
  const manager = getSnapshotManager();
  await manager.deleteSnapshot(name);
  return { ok: true };
});

// Restore a dock layout from a workspace snapshot. The window never moves or
// resizes anymore — this just tells the renderer where to place the dock bar.
ipcMain.handle('dock:applyLayout', async (_event, { layout }) => {
  if (!mainWindow || mainWindow.isDestroyed() || !layout) return { ok: false };
  const map = { top: 'top-center', left: 'bottom-left', right: 'bottom-right', bottom: 'bottom-center' };
  const position = map[layout.position] || 'bottom-center';
  if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('dock:positionChanged', position);
  }
  return { ok: true };
});

// Track whether a panel is open. The window itself never resizes — it is
// permanently fullscreen — so this only updates the flag the `blur` handler
// and the show/hide logic read. Hit-testing is driven by `dock:setMouseIgnore`.
ipcMain.handle('dock:setExpanded', (_event, { expanded }) => {
  isDockExpanded = !!expanded;
  return { ok: true, expanded: isDockExpanded };
});

// Toggle whether the (always-fullscreen, transparent) overlay swallows mouse
// events. The renderer sends `ignore: true` when nothing should be hit-testable
// (collapsed dock, cursor away from the bar) and `false` when the dock bar is
// hovered/dragged or a panel is open. `forward: true` keeps mousemove flowing
// to the page so the renderer can still detect the cursor entering the bar.
ipcMain.handle('dock:setMouseIgnore', (_event, { ignore }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  mainWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
  return { ok: true };
});

// Activate / deactivate the dock window. The dock is created with
// `focusable: false` so clicking the bar never steals focus from the user's
// foreground app. When the user clicks INTO a typing element (input/textarea/
// xterm), the renderer fires `dock:activate` to flip focusable→true and pull
// focus to the webContents so the natural click-focus flow can land the caret
// inside the input. The `blur` handler resets focusable→false automatically.
ipcMain.handle('dock:activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  mainWindow.setFocusable(true);
  mainWindow.focus();
  mainWindow.webContents.focus();
  // setFocusable(true) drops the WS_EX_TOOLWINDOW style on Windows, which
  // makes the dock pop into the taskbar. Re-assert skipTaskbar so the icon
  // stays out of view even while the window is activated for typing.
  mainWindow.setSkipTaskbar(true);
  return { ok: true };
});

ipcMain.handle('dock:deactivate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  mainWindow.setFocusable(false);
  return { ok: true };
});

// Read the persisted dock layout (active panel, open widgets, edge). Renderer
// calls this once on mount so the dock reopens to whatever the user had open
// last. Returns the in-memory mirror so it never blocks on disk.
ipcMain.handle('dock:layout:get', () => getCurrentDockLayoutSnapshot());

// Renderer pushes layout changes here whenever the user opens/closes a panel
// or the dock edge changes. Merge into the in-memory mirror and schedule a
// debounced write so we don't hammer disk on rapid toggles.
ipcMain.handle('dock:layout:save', (_event, { layout } = {}) => {
  if (!layout || typeof layout !== 'object') return { ok: false };
  const next = { ...currentDockLayout };
  if ('activeTabId' in layout) next.activeTabId = layout.activeTabId ?? null;
  if (Array.isArray(layout.openWidgets)) next.openWidgets = layout.openWidgets.slice(0, 32);
  if (typeof layout.position === 'string') next.position = layout.position;
  currentDockLayout = next;
  scheduleDockLayoutWrite();
  return { ok: true };
});

// IPC Handlers for Clipboard
ipcMain.handle('clipboard:copy', async (event, text) => {
  try {
    if (typeof text !== 'string' || text.length > 1000000) {
      throw new Error('Invalid clipboard content');
    }
    clipboard.writeText(text);
    return { success: true };
  } catch (error) {
    console.error('Clipboard error:', error);
    throw error;
  }
});

// ─── Notes IPC ────────────────────────────────────────────────────────────────
const notesFile = () => path.join(app.getPath('userData'), 'notes.json');
function readNotes() {
  return readJson(notesFile(), []);
}
function writeNotes(notes) {
  writeJsonAtomic(notesFile(), notes);
}

ipcMain.handle('notes:list', () => readNotes());
ipcMain.handle('notes:save', (_e, { note }) => {
  const notes = readNotes();
  const idx = notes.findIndex(n => n.id === note.id);
  if (idx >= 0) notes[idx] = note; else notes.unshift(note);
  writeNotes(notes);
  return { ok: true };
});
ipcMain.handle('notes:delete', (_e, { id }) => {
  writeNotes(readNotes().filter(n => n.id !== id));
  return { ok: true };
});
ipcMain.handle('notes:togglePin', (_e, { id }) => {
  const notes = readNotes();
  const note = notes.find(n => n.id === id);
  if (note) { note.pinned = !note.pinned; writeNotes(notes); }
  return { ok: true };
});

// ─── AI Chat IPC (multi-provider) ─────────────────────────────────────────────
//
// Provider selection lives in settings.json (`aiProvider`, `aiModel`). API
// keys live in the encrypted secrets store — except Gemini, which also accepts
// a `.env` VITE_GEMINI_API_KEY as a dev-time override so existing setups keep
// working without re-entering the key.

/** Resolve the API key for a provider: secrets store first, .env fallback for Gemini. */
function resolveApiKey(provider) {
  if (provider.keyless) return '';
  const stored = getSecret(provider.keyName);
  if (stored) return stored;
  if (provider.id === 'gemini') {
    const envKey = process.env.VITE_GEMINI_API_KEY;
    if (envKey && envKey !== 'your_api_key_here') return envKey;
  }
  return null;
}

/** The provider + model the user has selected (with sane defaults). */
function getActiveProvider() {
  const settings = readSettings();
  const provider = getProvider(settings.aiProvider) || getProvider('gemini');
  const model = settings.aiModel || provider.defaultModel;
  return { provider, model };
}

/** True if a provider is ready to use (keyless, or has a resolvable key). */
function providerReady(provider) {
  return provider.keyless || resolveApiKey(provider) !== null;
}

// Renderer gates the AI panel on this before letting a user type a doomed prompt.
ipcMain.handle('ai:status', () => {
  const { provider, model } = getActiveProvider();
  return {
    hasKey: providerReady(provider),
    provider: provider.id,
    providerLabel: provider.label,
    model,
  };
});

// Static provider catalog for the Settings "AI / Models" picker.
ipcMain.handle('ai:providers', () => ({
  providers: PROVIDER_LIST,
  encryptionAvailable: isEncryptionAvailable(),
}));

// ── AI model lists ───────────────────────────────────────────────────────────
// Live model catalogs fetched from each provider, with the curated `models[]`
// as a never-fail fallback. Successful live results are cached briefly so
// reopening Settings or flipping providers doesn't re-hit the network; failures
// are NOT cached, so a retry happens as soon as e.g. Ollama is started.
const MODEL_LIST_TTL = 5 * 60 * 1000;
const modelListCache = new Map(); // providerId -> { at, payload }

ipcMain.handle('ai:listModels', async (_e, { provider: providerId } = {}) => {
  const provider = getProvider(providerId) || getActiveProvider().provider;
  if (!provider) {
    return { ok: false, models: [], source: 'fallback', reason: 'unknown-provider' };
  }

  const cached = modelListCache.get(provider.id);
  if (cached && Date.now() - cached.at < MODEL_LIST_TTL) return cached.payload;

  const curated = provider.models || [];
  let payload;
  try {
    if (typeof provider.listModels !== 'function') {
      payload = { ok: true, models: curated, source: 'fallback', reason: 'no-fetcher' };
    } else {
      const apiKey = resolveApiKey(provider);
      if (!provider.keyless && !apiKey) {
        payload = { ok: false, models: curated, source: 'fallback', reason: 'no-key' };
      } else {
        const live = await provider.listModels({ apiKey });
        const models = Array.isArray(live) ? live.filter(Boolean) : [];
        payload = models.length
          ? { ok: true, models, source: 'live' }
          : { ok: false, models: curated, source: 'fallback', reason: 'empty' };
      }
    }
  } catch (err) {
    // Never throw across IPC — always degrade to the curated list.
    payload = { ok: false, models: curated, source: 'fallback', reason: err?.message || 'fetch-failed' };
  }

  // Only cache genuine live results — keep retrying on failure.
  if (payload.source === 'live') {
    modelListCache.set(provider.id, { at: Date.now(), payload });
  }
  return payload;
});

/** Run a chat turn on the active provider. `onChunk` may be undefined. */
async function runChat(prompt, onChunk, signal) {
  const { provider, model } = getActiveProvider();
  const apiKey = resolveApiKey(provider);
  if (!provider.keyless && apiKey === null) {
    throw new Error(`No API key configured for ${provider.label}. Add one in Settings.`);
  }
  return provider.chat({ apiKey, model, prompt, onChunk, signal });
}

// Total-time and idle timeouts so a slow or stalled provider doesn't hang the
// chat panel forever. Tunable here — generous enough to absorb cold-start
// latency on Ollama / OpenRouter, tight enough to surface a real network
// failure within a minute.
const AI_CHAT_TOTAL_TIMEOUT_MS = 60_000;     // non-streaming: hard cap on the whole request
const AI_STREAM_IDLE_TIMEOUT_MS = 60_000;    // streaming: max gap between chunks
const AI_STREAM_FIRST_CHUNK_TIMEOUT_MS = 45_000; // streaming: max wait for the first chunk

class AiTimeoutError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'AiTimeoutError';
    this.code = 'TIMEOUT';
  }
}

/**
 * Run `runChat` under an AbortController. If `idleMs` is set, the timer
 * resets every time a chunk arrives (idle/streaming mode). Otherwise the
 * timer is a single hard deadline (total/non-streaming mode).
 */
async function runChatWithTimeout(prompt, onChunk, { totalMs, idleMs, firstChunkMs }) {
  const ctrl = new AbortController();
  let timer = null;
  let receivedChunk = false;
  const trip = (msg) => {
    if (ctrl.signal.aborted) return;
    ctrl.abort(new AiTimeoutError(msg));
  };
  const arm = (ms, msg) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => trip(msg), ms);
  };

  if (idleMs) {
    arm(firstChunkMs ?? idleMs, 'AI request stalled — no response from provider');
  } else if (totalMs) {
    arm(totalMs, 'AI request timed out');
  }

  const wrappedChunk = onChunk
    ? (delta) => {
        receivedChunk = true;
        if (idleMs) arm(idleMs, 'AI stream stalled — no new tokens');
        onChunk(delta);
      }
    : undefined;

  try {
    return await runChat(prompt, wrappedChunk, ctrl.signal);
  } catch (err) {
    // Surface our timeout as the canonical error even when fetch wraps it.
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof AiTimeoutError) {
      throw ctrl.signal.reason;
    }
    if (err?.name === 'AbortError' && idleMs && !receivedChunk) {
      throw new AiTimeoutError('AI request stalled — no response from provider');
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Non-streaming chat — kept for callers that just want the final text.
ipcMain.handle('ai:chat', async (_e, { prompt }) => {
  try {
    const text = await runChatWithTimeout(prompt, undefined, { totalMs: AI_CHAT_TOTAL_TIMEOUT_MS });
    return { text: text || 'No response.' };
  } catch (err) {
    if (err instanceof AiTimeoutError) {
      return { text: '', error: err.message, code: 'TIMEOUT' };
    }
    throw err;
  }
});

// Streaming chat. The renderer calls this, then listens on the push channels
// `ai:streamChunk` / `ai:streamDone` / `ai:streamError`, all tagged with the
// `streamId` returned here so multiple panels could stream independently.
let _streamSeq = 0;
ipcMain.handle('ai:chatStream', async (e, { prompt }) => {
  const streamId = `s${++_streamSeq}`;
  const send = (channel, payload) => {
    if (e.sender && !e.sender.isDestroyed()) e.sender.send(channel, { streamId, ...payload });
  };
  // Run detached — resolve the invoke immediately with the id so the renderer
  // can start listening; chunks arrive over the push channels.
  (async () => {
    try {
      const text = await runChatWithTimeout(
        prompt,
        (delta) => send('ai:streamChunk', { delta }),
        { idleMs: AI_STREAM_IDLE_TIMEOUT_MS, firstChunkMs: AI_STREAM_FIRST_CHUNK_TIMEOUT_MS },
      );
      send('ai:streamDone', { text: text || 'No response.' });
    } catch (err) {
      console.error('[AI:chatStream] Error:', err.message);
      const code = err instanceof AiTimeoutError ? 'TIMEOUT' : (err.code || undefined);
      send('ai:streamError', { error: err.message || 'Failed to get response', code });
    }
  })();
  return { streamId };
});

// ─── Vosk offline speech model — download + cache + custom protocol ─────────
//
// The renderer's Voice panel uses `vosk-browser` to run speech recognition
// entirely on-device (WASM in a Web Worker, no network). The model is too big
// to ship in the installer, so it's downloaded once on first use, cached in
// userData, and served back to the renderer via the `vosk-model://` protocol.

const VOSK_MODELS = {
  'en-us-small': {
    url: 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz',
    expectedBytes: 40 * 1024 * 1024, // ~40 MB — used for progress when the server omits Content-Length
    label: 'English (small)',
  },
};

const DEFAULT_VOSK_MODEL_ID = 'en-us-small';

function voskModelsDir() {
  return path.join(app.getPath('userData'), 'voskModels');
}
function voskModelPath(id) {
  return path.join(voskModelsDir(), `${id}.tar.gz`);
}
function ensureVoskDir() {
  fs.mkdirSync(voskModelsDir(), { recursive: true });
}

/**
 * Inspect what's cached on disk. The renderer calls this to decide whether to
 * show the "Download model" prompt or jump straight to recording.
 */
ipcMain.handle('stt:voskModel:status', (_e, payload = {}) => {
  const id = payload.id || DEFAULT_VOSK_MODEL_ID;
  const meta = VOSK_MODELS[id];
  if (!meta) return { id, installed: false, error: `Unknown model: ${id}` };
  const filePath = voskModelPath(id);
  let installed = false;
  let sizeBytes = 0;
  try {
    const stat = fs.statSync(filePath);
    // A partial download (renamed-in but smaller than expected) would be
    // unusable; treat anything under 1 MB as "not installed" so the user
    // re-downloads instead of seeing a cryptic Vosk worker error.
    if (stat.size > 1024 * 1024) {
      installed = true;
      sizeBytes = stat.size;
    }
  } catch (_) { /* file missing */ }
  return {
    id,
    installed,
    sizeBytes,
    expectedBytes: meta.expectedBytes,
    label: meta.label,
    protocolUrl: installed ? `vosk-model://${id}` : null,
  };
});

/**
 * Stream the model archive from upstream to disk, pushing progress events to
 * the renderer as it goes. The renderer drives a single progress bar from these.
 * Uses fetch (Node 18+ global) so we get redirect-following for free.
 */
ipcMain.handle('stt:voskModel:download', async (e, payload = {}) => {
  const id = payload.id || DEFAULT_VOSK_MODEL_ID;
  const meta = VOSK_MODELS[id];
  if (!meta) return { ok: false, error: `Unknown model: ${id}` };

  ensureVoskDir();
  const dest = voskModelPath(id);
  const tmp = `${dest}.part`;
  // Wipe any prior aborted download so the partial file doesn't poison this one.
  try { fs.unlinkSync(tmp); } catch (_) {}

  const send = (phase, downloaded, total) => {
    if (e.sender && !e.sender.isDestroyed()) {
      e.sender.send('stt:voskModel:progress', { id, phase, downloaded, total });
    }
  };

  try {
    send('starting', 0, meta.expectedBytes);
    const response = await fetch(meta.url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    const headerTotal = parseInt(response.headers.get('content-length') || '0', 10);
    const total = headerTotal > 0 ? headerTotal : meta.expectedBytes;

    const file = fs.createWriteStream(tmp);
    const reader = response.body.getReader();
    let downloaded = 0;
    let lastProgressAt = 0;

    // Backpressure-aware copy: await the write callback so the renderer can't
    // outrun the disk on slow drives.
    const writeChunk = (chunk) => new Promise((resolve, reject) => {
      file.write(chunk, (err) => (err ? reject(err) : resolve()));
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writeChunk(value);
      downloaded += value.length;
      // Throttle: at most one progress message per ~100ms to keep IPC light.
      const now = Date.now();
      if (now - lastProgressAt > 100) {
        send('downloading', downloaded, total);
        lastProgressAt = now;
      }
    }
    await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())));

    // Atomic swap so a crash mid-download can't leave a half-file at the real path.
    fs.renameSync(tmp, dest);
    send('done', downloaded, total);
    return { ok: true, protocolUrl: `vosk-model://${id}`, sizeBytes: downloaded };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    const msg = err?.message || 'Download failed';
    send('error', 0, meta.expectedBytes);
    return { ok: false, error: msg };
  }
});

/**
 * Delete a cached model. Surfaced so power-users can free disk; not wired into
 * the UI yet but available via `window.electronAPI.invoke`.
 */
ipcMain.handle('stt:voskModel:remove', (_e, payload = {}) => {
  const id = payload.id || DEFAULT_VOSK_MODEL_ID;
  try { fs.unlinkSync(voskModelPath(id)); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ─── Voice-to-Text (transcription) IPC ────────────────────────────────────────
//
// The Voice panel and Voice settings UI go through this namespace exclusively;
// `ai:transcribe` is kept below as a backwards-compatible shim that resolves
// the active STT provider the same way and returns the legacy `{ text }` shape.

/**
 * Resolve the API key for an STT provider:
 *   1. encrypted secrets store (the canonical source)
 *   2. shared Gemini key fallback when the user picked Gemini for STT but only
 *      has the chat-side `gemini` key configured.
 *   3. .env `VITE_GEMINI_API_KEY` (dev-time convenience, same as chat AI)
 */
function resolveSttApiKey(provider) {
  if (!provider || provider.keyless) return '';
  if (provider.keyName) {
    const stored = getSecret(provider.keyName);
    if (stored) return stored;
  }
  if (provider.id === 'gemini') {
    const envKey = process.env.VITE_GEMINI_API_KEY;
    if (envKey && envKey !== 'your_api_key_here') return envKey;
  }
  return null;
}

/** Pick the active STT provider object based on persisted settings. */
function getActiveSttProvider() {
  const settings = readSettings();
  const id = settings.sttProvider || DEFAULT_TRANSCRIPTION_PROVIDER_ID;
  return getTranscriptionProvider(id) || getTranscriptionProvider(DEFAULT_TRANSCRIPTION_PROVIDER_ID);
}

/** Endpoint override (per-provider) from settings.sttEndpoints. */
function getSttEndpoint(providerId) {
  const settings = readSettings();
  const map = settings.sttEndpoints && typeof settings.sttEndpoints === 'object'
    ? settings.sttEndpoints
    : {};
  const v = map[providerId];
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/** Catalog + per-provider readiness for the Voice settings UI. */
ipcMain.handle('transcription:providers', () => {
  const savedNames = new Set(listSecrets());
  const savedId = readSettings().sttProvider || DEFAULT_TRANSCRIPTION_PROVIDER_ID;
  // Stale settings from a previous version can point at a provider that's been
  // removed. Resolve back to the default so the renderer never lands on a
  // provider id that isn't in the catalog.
  const activeId = getTranscriptionProvider(savedId)
    ? savedId
    : DEFAULT_TRANSCRIPTION_PROVIDER_ID;
  const providers = TRANSCRIPTION_PROVIDER_LIST.map((p) => ({
    ...p,
    hasKey: p.keyless ? true : (p.keyName ? savedNames.has(p.keyName) : false),
    endpoint: getSttEndpoint(p.id) || p.defaultEndpoint || '',
  }));
  return {
    providers,
    activeId,
    encryptionAvailable: isEncryptionAvailable(),
  };
});

/**
 * Run a transcription with the (optionally overridden) active provider.
 * `providerId` is accepted so the renderer can transcribe with a specific
 * provider without persisting it — used by the "Test Connection" probe.
 */
ipcMain.handle('transcription:transcribe', async (_e, payload = {}) => {
  const { audio, mimeType, language, providerId } = payload;
  if (!audio) {
    return { ok: false, error: 'No audio data received.', code: 'config' };
  }
  const provider = providerId
    ? (getTranscriptionProvider(providerId) || getActiveSttProvider())
    : getActiveSttProvider();
  if (!provider) {
    return { ok: false, error: 'No transcription provider configured.', code: 'config' };
  }
  try {
    const result = await runTranscription({
      provider,
      apiKey: resolveSttApiKey(provider),
      endpoint: getSttEndpoint(provider.id),
      audioBase64: audio,
      mimeType: mimeType || 'audio/webm',
      language: language ?? null,
    });
    return {
      ok: true,
      text: result.text,
      detectedLanguage: result.detectedLanguage,
      durationMs: result.durationMs,
      provider: result.provider,
      providerLabel: provider.label,
    };
  } catch (err) {
    const code = err instanceof TranscriptionError ? err.code : 'unknown';
    console.warn('[transcription:transcribe]', provider.id, code, err.message);
    return { ok: false, error: err.message || 'Transcription failed.', code, provider: provider.id };
  }
});

/**
 * Test a provider's credentials + endpoint without performing a real
 * transcription. The renderer passes the providerId because the user may be
 * testing a provider they haven't yet activated.
 */
ipcMain.handle('transcription:test', async (_e, { providerId } = {}) => {
  const provider = getTranscriptionProvider(providerId) || getActiveSttProvider();
  if (!provider) return { ok: false, error: 'Unknown provider.', code: 'config' };
  try {
    const out = await testTranscriptionProvider({
      provider,
      apiKey: resolveSttApiKey(provider),
      endpoint: getSttEndpoint(provider.id),
    });
    return { ok: true, info: out?.info || 'Connection successful.', provider: provider.id };
  } catch (err) {
    const code = err instanceof TranscriptionError ? err.code : 'unknown';
    return { ok: false, error: err.message || 'Connection failed.', code, provider: provider.id };
  }
});

/**
 * Backwards-compatible shim. The old `ai:transcribe` channel used Gemini /
 * OpenAI directly from `electron-ai-providers.js`; we now route it through the
 * STT executor so anything that still calls it (or third-party plugins) keeps
 * working but benefits from provider switching and auto-detect.
 */
ipcMain.handle('ai:transcribe', async (_e, { audio, language } = {}) => {
  if (!audio) throw new Error('Transcription failed: no audio');
  const provider = getActiveSttProvider();
  if (!provider) throw new Error('Transcription failed: no provider configured');
  try {
    const result = await runTranscription({
      provider,
      apiKey: resolveSttApiKey(provider),
      endpoint: getSttEndpoint(provider.id),
      audioBase64: audio,
      mimeType: 'audio/webm',
      language: language || null,
    });
    return { text: result.text || '' };
  } catch (err) {
    console.error('[AI:Transcribe] Error:', err.message);
    throw new Error('Transcription failed: ' + (err.message || 'Unknown error'));
  }
});

// ─── Secrets IPC ──────────────────────────────────────────────────────────────
// The renderer can set / check / delete / list secret NAMES only — a raw key
// value is never returned across this boundary.
ipcMain.handle('secrets:set', (_e, { name, value }) => setSecret(name, value));
ipcMain.handle('secrets:has', (_e, { name }) => ({ has: hasSecret(name) }));
ipcMain.handle('secrets:delete', (_e, { name }) => { deleteSecret(name); return { ok: true }; });
ipcMain.handle('secrets:list', () => ({ names: listSecrets() }));

// ─── Screenshot IPC ───────────────────────────────────────────────────────────
const screenshotsDir = () => path.join(app.getPath('userData'), 'screenshots');
const screenshotsIndex = () => path.join(app.getPath('userData'), 'screenshots-index.json');

function ensureScreenshotsDir() { fs.mkdirSync(screenshotsDir(), { recursive: true }); }
function readScreenshotIndex() {
  return readJson(screenshotsIndex(), []);
}
function writeScreenshotIndex(idx) {
  writeJsonAtomic(screenshotsIndex(), idx);
}

ipcMain.handle('screenshot:getSources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 400, height: 400 },
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    preview: s.thumbnail.toDataURL()
  }));
});

ipcMain.handle('screenshot:capture', async (_e, { mode, sourceId }) => {
  ensureScreenshotsDir();
  const sources = await desktopCapturer.getSources({
    types: mode === 'window' ? ['window'] : ['screen'],
    thumbnailSize: { width: 1920, height: 1080 },
  });
  if (!sources.length) return { screenshot: null };
  
  let source;
  if (mode === 'window' && sourceId) {
    source = sources.find(s => s.id === sourceId);
  } else {
    source = sources[0];
  }
  if (!source) return { screenshot: null };

  const img = source.thumbnail;
  if (img.isEmpty()) return { screenshot: null };

  const id = crypto.randomUUID();
  const filename = `${Date.now()}.png`;
  const filePath = path.join(screenshotsDir(), filename);
  fs.writeFileSync(filePath, img.toPNG());

  // Create thumbnail preview
  let preview;
  try {
    const { width } = img.getSize();
    const thumbImg = width > 400 ? img.resize({ width: 400 }) : img;
    preview = `data:image/png;base64,${thumbImg.toPNG().toString('base64')}`;
  } catch (_) {
    preview = `data:image/png;base64,${img.toPNG().toString('base64')}`;
  }

  const entry = { id, path: filePath, preview, timestamp: new Date().toISOString(), mode };
  const idx = readScreenshotIndex();
  idx.unshift(entry);
  if (idx.length > 50) idx.splice(50);
  writeScreenshotIndex(idx);

  return { screenshot: entry };
});

ipcMain.handle('screenshot:getHistory', () => readScreenshotIndex());
ipcMain.handle('screenshot:delete', (_e, { id }) => {
  const idx = readScreenshotIndex();
  const item = idx.find(s => s.id === id);
  if (item?.path && fs.existsSync(item.path)) fs.unlinkSync(item.path);
  writeScreenshotIndex(idx.filter(s => s.id !== id));
  return { ok: true };
});
ipcMain.handle('screenshot:copy', (_e, { id }) => {
  const idx = readScreenshotIndex();
  const item = idx.find(s => s.id === id);
  if (item?.path && fs.existsSync(item.path)) {
    const data = fs.readFileSync(item.path);
    clipboard.writeImage(nativeImage.createFromBuffer(data));
    return { ok: true };
  }
  return { ok: false };
});
ipcMain.handle('screenshot:open', (_e, { id }) => {
  const idx = readScreenshotIndex();
  const item = idx.find(s => s.id === id);
  // Validate path is within screenshots directory to prevent path traversal
  if (item?.path) {
    const resolvedPath = path.resolve(item.path);
    const resolvedDir = path.resolve(screenshotsDir());
    if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
      console.warn('[Screenshot] Path traversal attempt blocked:', item.path);
      return { ok: false };
    }
    shell.openPath(resolvedPath);
  }
  return { ok: true };
});

// ─── Settings IPC ─────────────────────────────────────────────────────────────
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  return readJson(settingsFile(), {});
}

/**
 * Move the dock bar to one of the four preset positions. The window is
 * permanently fullscreen, so this just broadcasts the preset to the renderer,
 * which positions (and snaps) the dock bar within the overlay.
 */
function applyDockPosition(position) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('dock:positionChanged', position);
  }
}

/**
 * Apply every setting that has a runtime effect. Called both from the
 * Settings panel (settings:set) and once at startup so saved preferences
 * actually take effect — previously dockPosition and clipboardMaxItems were
 * persisted but silently ignored.
 */
function applySettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  if (mainWindow && !mainWindow.isDestroyed() && typeof settings.alwaysOnTop === 'boolean') {
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
  }
  if (typeof settings.launchOnStartup === 'boolean') {
    // In dev, process.execPath is node_modules/electron/dist/electron.exe — registering
    // that in the Run key launches the default Electron welcome window at boot. Only
    // register for packaged builds, and pass an explicit path so the entry is unambiguous.
    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: settings.launchOnStartup,
        path: process.execPath,
        args: []
      });
    } else if (settings.launchOnStartup) {
      console.warn('[settings] launchOnStartup ignored in dev (would register node_modules electron.exe)');
    }
  }
  if (settings.clipboardMaxItems != null) {
    getClipboardHistory().setMaxHistory(settings.clipboardMaxItems);
  }
  if (settings.dockPosition) {
    applyDockPosition(settings.dockPosition);
  }
}

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, { settings }) => {
  // Merge rather than overwrite: callers (Settings panel, ThemeContext, …)
  // each own only a subset of keys, so a partial write must not wipe the rest.
  writeJsonAtomic(settingsFile(), { ...readSettings(), ...settings });
  // Apply only what changed — applySettings guards each key by presence, so
  // toggling the theme won't, say, re-snap a window the user dragged.
  applySettings(settings);
  return { ok: true };
});

// Onboarding finished — persist the user's first-run choices, apply them, then
// hand off from the welcome window to the dock. Launch-on-startup is always
// recorded as true (no toggle in the welcome anymore); analytics reflects the
// switch the user actually saw.
ipcMain.handle('welcome:complete', (_e, payload = {}) => {
  const next = {
    ...readSettings(),
    hasCompletedWelcome: true,
    launchOnStartup: true,
    analyticsEnabled: !!payload.analyticsEnabled,
  };
  writeJsonAtomic(settingsFile(), next);
  applySettings(next);

  startDock();

  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.close();
  }
  return { ok: true };
});

// ─── Launcher IPC ─────────────────────────────────────────────────────────────
function getStartMenuPaths() {
  return [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
}

function scanApps(dir, results = [], depth = 0) {
  if (depth > 3) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanApps(full, results, depth + 1);
      } else if (entry.name.endsWith('.lnk') || entry.name.endsWith('.url')) {
        results.push({
          name: entry.name.replace(/\.(lnk|url)$/i, ''),
          path: full,
          type: 'app',
        });
      }
    }
  } catch (_) {}
  return results;
}

// Common user folders surfaced as launcher results. Uses Electron's built-in
// path resolver so the locations come back correctly translated (e.g. localized
// shell folder names, OneDrive-redirected Documents) instead of hard-coded
// %USERPROFILE%\Documents strings.
function scanFolders() {
  const ids = ['home', 'desktop', 'documents', 'downloads', 'pictures', 'videos', 'music'];
  const out = [];
  for (const id of ids) {
    try {
      const p = app.getPath(id);
      if (!p || !fs.existsSync(p)) continue;
      out.push({
        name: id === 'home' ? 'Home' : (path.basename(p) || id[0].toUpperCase() + id.slice(1)),
        path: p,
        type: 'folder',
      });
    } catch (_) { /* path id unsupported on this OS — skip */ }
  }
  return out;
}

const SYSTEM_COMMANDS = [
  { name: 'Calculator', path: 'calc.exe', type: 'system' },
  { name: 'Notepad', path: 'notepad.exe', type: 'system' },
  { name: 'Task Manager', path: 'taskmgr.exe', type: 'system' },
  { name: 'Control Panel', path: 'control.exe', type: 'system' },
  { name: 'File Explorer', path: 'explorer.exe', type: 'system' },
  { name: 'Command Prompt', path: 'cmd.exe', type: 'system' },
  { name: 'PowerShell', path: 'powershell.exe', type: 'system' },
  { name: 'Settings', path: 'ms-settings:', type: 'system' },
];

// Per-type result caps so a search like "do" doesn't return 20 apps and crowd
// out matching folders. The renderer groups by type into sections, so balanced
// representation matters more than a flat top-20.
const LAUNCHER_TYPE_CAPS = { app: 8, folder: 6, system: 4, url: 4, file: 4 };
const LAUNCHER_MAX_RESULTS = 20;

let cachedItems = null;
let cacheTime = 0;

ipcMain.handle('launcher:search', (_e, { query }) => {
  // Refresh cache every 60s
  if (!cachedItems || Date.now() - cacheTime > 60000) {
    cachedItems = [];
    for (const dir of getStartMenuPaths()) cachedItems = scanApps(dir, cachedItems);
    cachedItems.push(...SYSTEM_COMMANDS);
    cachedItems.push(...scanFolders());
    cacheTime = Date.now();
  }
  const q = (query || '').toLowerCase();
  if (!q) return [];

  // Lower score = better. Exact match wins, then prefix, then substring.
  const scored = [];
  for (const item of cachedItems) {
    const name = item.name.toLowerCase();
    if (!name.includes(q)) continue;
    let score;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else score = 2;
    scored.push({ item, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.item.name.localeCompare(b.item.name);
  });

  // Apply per-type caps while preserving global score order — so the single
  // best match (regardless of type) stays at index 0 for the renderer's
  // "Best Match" section.
  const counts = {};
  const out = [];
  for (const { item } of scored) {
    const t = item.type || 'file';
    counts[t] = (counts[t] || 0) + 1;
    if (counts[t] > (LAUNCHER_TYPE_CAPS[t] || 4)) continue;
    out.push(item);
    if (out.length >= LAUNCHER_MAX_RESULTS) break;
  }
  return out;
});

ipcMain.handle('launcher:open', async (_e, { path: appPath, type }) => {
  try {
    // Validate appPath to prevent injection
    if (typeof appPath !== 'string' || appPath.length > 1024) {
      throw new Error('Invalid application path');
    }

    if (type === 'system' && appPath.startsWith('ms-')) {
      // Only allow ms-settings: URIs
      if (!/^ms-[a-z]+:/i.test(appPath)) throw new Error('Invalid system URI');
      await shell.openExternal(appPath);
    } else if (type === 'system') {
      // Use spawn with argument array instead of exec to prevent command injection
      const child = spawn('cmd.exe', ['/c', 'start', '""', appPath], {
        detached: true, stdio: 'ignore'
      });
      child.unref();
    } else {
      // Validate the path exists and is a file (not a shell command)
      if (!fs.existsSync(appPath)) throw new Error('Path not found');
      await shell.openPath(appPath);
    }
    return { ok: true };
  } catch (err) {
    console.warn('[Launcher] open error:', err.message);
    return { ok: false, error: err.message };
  }
});

// ─── App icons ────────────────────────────────────────────────────────────────
// Extract the real icon for a file path (.exe / .lnk / .url / any file) so the
// launcher and workspace lists can show actual app icons instead of generic
// glyphs. Results are cached by path; an unresolvable path returns '' and the
// renderer falls back to its generic icon. Bare command names (e.g. `calc.exe`)
// and URI schemes (e.g. `ms-settings:`) won't resolve — that's expected.
//
// LRU-bounded: a `Map` preserves insertion order, so re-`set`ing a key on hit
// promotes it to "most recent." Once we hit `ICON_CACHE_LIMIT`, the oldest
// entry (front of iteration) is evicted. Caps long-session memory growth on
// machines with thousands of installed apps.
const ICON_CACHE_LIMIT = 500;
const iconCache = new Map();
ipcMain.handle('app:getIcon', async (_e, { path: filePath } = {}) => {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 1024) return '';
  if (iconCache.has(filePath)) {
    const cached = iconCache.get(filePath);
    iconCache.delete(filePath);
    iconCache.set(filePath, cached);
    return cached;
  }
  let url = '';
  try {
    if (fs.existsSync(filePath)) {
      // For Start Menu shortcuts (.lnk), Windows hands back the generic
      // shortcut overlay icon rather than the target program's icon. Resolve
      // the shortcut to its target so we fetch the actual app icon (Adobe,
      // VS Code, OpenCode, etc. all show up via Start Menu .lnk files).
      let iconSource = filePath;
      if (filePath.toLowerCase().endsWith('.lnk')) {
        try {
          const info = shell.readShortcutLink(filePath);
          if (info && info.target && fs.existsSync(info.target)) {
            iconSource = info.target;
          }
        } catch (_) { /* keep the .lnk as the source */ }
      }
      const img = await app.getFileIcon(iconSource, { size: 'large' });
      if (img && !img.isEmpty()) {
        // Windows sometimes returns a 1×1 placeholder for paths it can't
        // resolve (UWP-virtualized exes, certain protected system paths).
        // isEmpty() is false but the image is visually invisible — bail
        // here so the renderer falls back to the line-icon.
        const size = img.getSize();
        if (size && size.width >= 8 && size.height >= 8) url = img.toDataURL();
      }
    }
  } catch (_) { /* unresolvable — fall through to '' */ }
  iconCache.set(filePath, url);
  if (iconCache.size > ICON_CACHE_LIMIT) {
    iconCache.delete(iconCache.keys().next().value);
  }
  return url;
});

// ─── Terminal IPC ─────────────────────────────────────────────────────────────
// One persistent pty for the whole app session. The renderer reattaches to it
// on every panel reopen (via `terminal:ensure` + `terminal:getBuffer` replay)
// instead of restarting the shell each time. `terminal:spawn` is kept as the
// explicit "Restart" action.
let ptyProcess = null;
let ptyBuffer = '';
const PTY_BUFFER_MAX = 256 * 1024; // cap the replay buffer at ~256 KB

// MOTD banner — an ASCII ">>" double-chevron logo, run as a real PowerShell
// `-Command` at shell startup so it lives in ConPTY's own screen buffer and
// survives resizes/repaints (a banner written straight to xterm gets wiped the
// moment ConPTY repaints on a resize). Built with [char]0x2588 + single-quoted
// strings so the command line carries no unicode and no double-quotes.
const TERMINAL_BANNER = [
  '$b=[string][char]0x2588+[string][char]0x2588',
  "Write-Host ''",
  "Write-Host ('   '+$b+'     '+$b) -ForegroundColor Blue",
  "Write-Host ('     '+$b+'     '+$b) -ForegroundColor Cyan",
  "Write-Host ('       '+$b+'     '+$b) -ForegroundColor White",
  "Write-Host ('     '+$b+'     '+$b) -ForegroundColor Cyan",
  "Write-Host ('   '+$b+'     '+$b) -ForegroundColor Blue",
  "Write-Host ''",
  "Write-Host '   DockShift Terminal ' -ForegroundColor White -NoNewline",
  "Write-Host '- PowerShell session ready' -ForegroundColor DarkGray",
  "Write-Host '   Ctrl+Shift+C/V copy-paste   Ctrl+F search   Ctrl+(+/-) zoom' -ForegroundColor DarkGray",
  "Write-Host ''",
].join('; ');

/** Spawn a fresh pty, wire its data/exit, and make it the current session. */
function spawnPty(cwdOverride) {
  const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
  const shellArgs = os.platform() === 'win32'
    ? ['-NoLogo', '-NoExit', '-Command', TERMINAL_BANNER]
    : [];
  // Filter sensitive environment variables before passing to the PTY.
  // This is a *denylist of patterns* rather than a list of known key names —
  // any var whose name looks secret-ish (e.g. a user's own GOOGLE_API_KEY)
  // is stripped, not just the handful we happen to ship with.
  const safeEnv = { ...process.env };
  const SECRET_NAME_RE = /(KEY|SECRET|TOKEN|PASS(WORD|WD)?|CREDENTIAL|PRIVATE|AUTH|SESSION|COOKIE|SIGNATURE|CERT)/i;
  for (const key of Object.keys(safeEnv)) {
    if (SECRET_NAME_RE.test(key)) {
      delete safeEnv[key];
    }
  }

  // Validate the cwd override before passing to PTY — node-pty inherits the
  // parent process cwd on a non-existent path, which would silently land the
  // shell somewhere unexpected.
  let cwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
  if (cwdOverride && typeof cwdOverride === 'string') {
    try {
      if (fs.statSync(cwdOverride).isDirectory()) cwd = cwdOverride;
    } catch { /* fall back to home */ }
  }

  const proc = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: safeEnv,
  });
  ptyBuffer = '';

  proc.onData((data) => {
    if (ptyProcess !== proc) return; // a newer pty has replaced this one
    // Keep a capped scrollback so a reopened panel can replay it.
    ptyBuffer = (ptyBuffer + data).slice(-PTY_BUFFER_MAX);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:onData', data);
    }
  });

  proc.onExit(() => {
    if (ptyProcess !== proc) return; // already replaced — stale exit
    ptyProcess = null;
    ptyBuffer = '';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:onExit');
    }
  });

  ptyProcess = proc;
}

// Explicit restart — always kills the current shell and spawns a fresh one.
ipcMain.handle('terminal:spawn', () => {
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch (_) { /* already dead */ }
  }
  ptyProcess = null;
  spawnPty();
  return { ok: true };
});

// Spawn only if there's no live shell — used on panel open so a reopened panel
// reattaches to the existing session instead of restarting it.
ipcMain.handle('terminal:ensure', () => {
  if (ptyProcess) return { ok: true, alreadyRunning: true };
  spawnPty();
  return { ok: true, alreadyRunning: false };
});

// Current scrollback, for replaying into a freshly-created xterm instance.
ipcMain.handle('terminal:getBuffer', () => ptyBuffer);

ipcMain.handle('terminal:write', (_e, { data }) => {
  if (ptyProcess) ptyProcess.write(data);
});

ipcMain.handle('terminal:resize', (_e, { cols, rows }) => {
  if (ptyProcess) {
    try { ptyProcess.resize(cols, rows); } catch (err) {}
  }
});

// Open a terminal hyperlink in the default browser — http/https only.
ipcMain.handle('terminal:openLink', (_e, { url }) => {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false };
    shell.openExternal(u.href);
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
});

// Generic external-link opener for in-app UI (Terms / Privacy links in the
// welcome modal, etc). Same http/https guard as terminal:openLink — kept
// separate so a renderer that only needs one capability doesn't get both.
ipcMain.handle('app:openExternal', (_e, { url }) => {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false };
    shell.openExternal(u.href);
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
});

// ─── Browser IPC ──────────────────────────────────────────────────────────────
const bookmarksFile = () => path.join(app.getPath('userData'), 'browser-bookmarks.json');
const browserHistFile = () => path.join(app.getPath('userData'), 'browser-history.json');

ipcMain.handle('browser:getBookmarks', () => readJson(bookmarksFile(), []));
ipcMain.handle('browser:saveBookmark', (_e, { url, title }) => {
  const bm = readJson(bookmarksFile(), []);
  if (!bm.find(b => b.url === url)) { bm.unshift({ url, title, addedAt: new Date().toISOString() }); }
  if (bm.length > 50) bm.splice(50);
  writeJsonAtomic(bookmarksFile(), bm);
  return { ok: true };
});
ipcMain.handle('browser:getHistory', () => readJson(browserHistFile(), []));
ipcMain.handle('browser:addHistory', (_e, { url, title }) => {
  let hist = readJson(browserHistFile(), []);
  hist = hist.filter(h => h.url !== url);
  hist.unshift({ url, title, visitedAt: new Date().toISOString() });
  if (hist.length > 100) hist.splice(100);
  writeJsonAtomic(browserHistFile(), hist);
  return { ok: true };
});

// Animated opacity fade for the dock show/hide flow. setOpacity is instant,
// so we step values in JS at ~60fps with a smoothstep ease for a natural
// curve. Holds the active timer so a rapid toggle replaces the in-flight
// fade instead of fighting it.
let toggleFadeTimer = null;
function fadeWindowOpacity(target, durationMs) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (toggleFadeTimer) {
    clearInterval(toggleFadeTimer);
    toggleFadeTimer = null;
  }
  const start = mainWindow.getOpacity();
  if (start === target) return;
  const startTime = Date.now();
  toggleFadeTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(toggleFadeTimer);
      toggleFadeTimer = null;
      return;
    }
    const elapsed = Date.now() - startTime;
    const t = Math.min(1, elapsed / durationMs);
    // Smoothstep: t² · (3 − 2t) — gentle S-curve, slow on both ends.
    const eased = t * t * (3 - 2 * t);
    mainWindow.setOpacity(start + (target - start) * eased);
    if (t >= 1) {
      clearInterval(toggleFadeTimer);
      toggleFadeTimer = null;
    }
  }, 16);
}

function toggleWindowVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isVisible) {
    // Mouse-ignore flips to true immediately so the foreground app receives
    // clicks even during the fade-out (otherwise a click landing on the
    // half-faded dock would still be intercepted).
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    fadeWindowOpacity(0, 180);
    isVisible = false;
  } else {
    // Restore hit-testing before starting the fade-in so the dock is
    // interactive from the first frame the user can see it.
    mainWindow.setIgnoreMouseEvents(!isDockExpanded, { forward: true });
    fadeWindowOpacity(1, 180);
    isVisible = true;
  }
  refreshTrayMenu();
}

// ─── Toggle hotkey ────────────────────────────────────────────────────────────
// User-customizable, persisted in settings.json under `toggleDockShortcut`.
// Whatever's currently registered lives here so we can unregister cleanly when
// the user picks a new combo.
const DEFAULT_TOGGLE_SHORTCUT = 'Control+Shift+D';
let currentToggleShortcut = null;

function registerToggleShortcut(accelerator) {
  const accel = String(accelerator || '').trim() || DEFAULT_TOGGLE_SHORTCUT;
  if (currentToggleShortcut && currentToggleShortcut !== accel) {
    globalShortcut.unregister(currentToggleShortcut);
  } else if (currentToggleShortcut === accel && globalShortcut.isRegistered(accel)) {
    return { ok: true, accelerator: accel };
  }
  let ok = false;
  try {
    ok = globalShortcut.register(accel, toggleWindowVisibility);
  } catch (err) {
    return { ok: false, error: err.message || 'Invalid shortcut' };
  }
  if (!ok) {
    // register() returns false silently when the combo is already taken by
    // another app or is malformed. Fall back to the previous binding so the
    // dock isn't left without a hotkey.
    if (currentToggleShortcut && currentToggleShortcut !== accel) {
      globalShortcut.register(currentToggleShortcut, toggleWindowVisibility);
    }
    return { ok: false, error: 'Shortcut is already in use by another app' };
  }
  currentToggleShortcut = accel;
  refreshTrayMenu();
  return { ok: true, accelerator: accel };
}

ipcMain.handle('settings:hotkey:set', (_e, { accelerator } = {}) => {
  const result = registerToggleShortcut(accelerator);
  if (result.ok) {
    writeJsonAtomic(settingsFile(), {
      ...readSettings(),
      toggleDockShortcut: result.accelerator,
    });
  }
  return result;
});

// ─── System tray ──────────────────────────────────────────────────────────────
let tray = null;

function trayIconPath() {
  // Lookup chain, tray-first:
  //   1. assets/tray-icon.png  — dedicated tray art: bold, edge-to-edge, no
  //      frame. Best practice: ship a 32x32 (or 64x64) PNG sized for the
  //      Windows tray slot. The app icon keeps its branded frame separately.
  //   2. assets/icon.png       — 256x256 app icon as a fallback. Looks
  //      framed in the tray but works.
  //   3. assets/icon.ico       — last resort if the PNG is missing.
  const tray = path.join(app.getAppPath(), 'assets', 'tray-icon.png');
  if (fs.existsSync(tray)) return tray;
  const png = path.join(app.getAppPath(), 'assets', 'icon.png');
  if (fs.existsSync(png)) return png;
  return path.join(app.getAppPath(), 'assets', 'icon.ico');
}

function formatAcceleratorForTray(accel) {
  if (!accel) return '';
  return accel
    .replace(/CommandOrControl/gi, 'Ctrl')
    .replace(/Control/gi, 'Ctrl')
    .replace(/\bMeta\b/g, 'Win')
    .replace(/\+/g, '+');
}

function buildTrayMenu() {
  const shortcut = formatAcceleratorForTray(currentToggleShortcut || DEFAULT_TOGGLE_SHORTCUT);
  return Menu.buildFromTemplate([
    {
      label: isVisible ? 'Hide Dock' : 'Show Dock',
      accelerator: currentToggleShortcut || DEFAULT_TOGGLE_SHORTCUT,
      click: toggleWindowVisibility,
    },
    { type: 'separator' },
    {
      label: 'Quit DockShift',
      click: () => app.quit(),
    },
  ]);
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
  const shortcut = formatAcceleratorForTray(currentToggleShortcut || DEFAULT_TOGGLE_SHORTCUT);
  tray.setToolTip(`DockShift • ${shortcut}`);
}

function createTray() {
  if (tray) return;
  const image = nativeImage.createFromPath(trayIconPath());
  if (image.isEmpty()) {
    console.warn('[tray] icon not found at', trayIconPath());
    return;
  }
  // Resize to 32px from the loaded source. Windows still renders into its
  // fixed tray slot, but giving Electron a 32x32 hint produces a sharper
  // result on 125%/150% DPI than letting it use the bare 16x16.
  const sized = image.resize({ width: 32, height: 32, quality: 'best' });
  tray = new Tray(sized);
  tray.on('click', toggleWindowVisibility);
  refreshTrayMenu();
}

// ─── Anonymous heartbeat (opt-in usage analytics) ────────────────────────────
// Default OFF. When enabled in Settings → System, the app sends a single
// JSON ping to the landing site's /api/heartbeat once per launch + once per
// 24h while running. Ping payload is anonymous (stable UUID + version + OS
// string + locale); the server adds country/region from Vercel's edge geo
// headers. No personally identifying information ever leaves the machine.
const HEARTBEAT_ENDPOINT = 'https://dock-shift.vercel.app/api/heartbeat';
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
let heartbeatTimer = null;
let lastHeartbeatAt = 0;

function installIdFile() {
  return path.join(app.getPath('userData'), 'install-id.json');
}

function getOrCreateInstallId() {
  const file = installIdFile();
  try {
    const data = readJson(file, null);
    if (data && typeof data.id === 'string' && data.id.length >= 32) return data.id;
  } catch (_) {}
  const id = crypto.randomUUID();
  try {
    writeJsonAtomic(file, { id, createdAt: new Date().toISOString() });
  } catch (err) {
    console.warn('[heartbeat] could not persist install id:', err.message);
  }
  return id;
}

async function sendHeartbeat({ force = false } = {}) {
  const settings = readSettings();
  if (!settings.analyticsEnabled) return;
  if (!force && Date.now() - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;

  const payload = {
    id: getOrCreateInstallId(),
    version: app.getVersion(),
    os: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    locale: app.getLocale() || 'unknown',
  };

  try {
    // AbortController so a network blackhole doesn't hang the timer.
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(HEARTBEAT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (res.ok) {
      lastHeartbeatAt = Date.now();
    } else {
      console.warn('[heartbeat] non-2xx response:', res.status);
    }
  } catch (err) {
    // Silent — we don't want a flaky network to surface as a user error.
    console.warn('[heartbeat] failed:', err.message || err);
  }
}

function startHeartbeatLoop() {
  // Fire immediately, then on a 24h interval. Both gated by analyticsEnabled
  // inside sendHeartbeat — toggling off in Settings stops sending without
  // needing to clear the timer.
  sendHeartbeat();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

ipcMain.handle('analytics:setEnabled', (_e, { enabled } = {}) => {
  const next = !!enabled;
  writeJsonAtomic(settingsFile(), { ...readSettings(), analyticsEnabled: next });
  if (next) {
    // Force-send right away so the user sees their install reflected on the
    // dashboard within seconds of opting in.
    lastHeartbeatAt = 0;
    sendHeartbeat({ force: true });
  }
  return { ok: true, enabled: next };
});

ipcMain.handle('analytics:getStatus', () => {
  return {
    enabled: !!readSettings().analyticsEnabled,
    installId: getOrCreateInstallId(),
    lastSentAt: lastHeartbeatAt ? new Date(lastHeartbeatAt).toISOString() : null,
  };
});

// ─── Auto-updater ─────────────────────────────────────────────────────────────
// electron-updater pulls release manifests from GitHub Releases (configured in
// package.json `build.publish`). We expose a small state machine to the
// renderer instead of relying on the OS toast that `checkForUpdatesAndNotify`
// produces — users get a real in-app indicator and a manual "Check now" /
// "Restart and install" pair in Settings → About.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let updateCheckTimer = null;

const updateState = {
  status: 'idle',          // idle | checking | available | downloading | downloaded | not-available | error | unsupported
  currentVersion: app.getVersion(),
  latestVersion: null,
  releaseNotes: null,
  releaseName: null,
  progress: null,          // { percent, transferred, total, bytesPerSecond }
  error: null,
  lastCheckedAt: null,
};

function broadcastUpdateState() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('updater:state', updateState);
  }
}

function setUpdateState(patch) {
  Object.assign(updateState, patch);
  broadcastUpdateState();
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    setUpdateState({ status: 'unsupported' });
    return;
  }

  // Defaults are already what we want (autoDownload=true, autoInstallOnAppQuit=true)
  // — set explicitly so a future electron-updater bump can't surprise us.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = !!readSettings().receivePrerelease;

  autoUpdater.on('checking-for-update', () => {
    setUpdateState({ status: 'checking', error: null });
  });
  autoUpdater.on('update-available', (info) => {
    setUpdateState({
      status: 'downloading',
      latestVersion: info?.version || null,
      releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : null,
      releaseName: info?.releaseName || null,
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      error: null,
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    setUpdateState({
      status: 'not-available',
      latestVersion: info?.version || updateState.currentVersion,
      lastCheckedAt: new Date().toISOString(),
      error: null,
    });
  });
  autoUpdater.on('download-progress', (p) => {
    setUpdateState({
      status: 'downloading',
      progress: {
        percent: Math.round(p?.percent || 0),
        transferred: p?.transferred || 0,
        total: p?.total || 0,
        bytesPerSecond: p?.bytesPerSecond || 0,
      },
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({
      status: 'downloaded',
      latestVersion: info?.version || updateState.latestVersion,
      progress: null,
      error: null,
    });
  });
  autoUpdater.on('error', (err) => {
    console.warn('[updater] error:', err?.message || err);
    setUpdateState({
      status: 'error',
      error: (err && err.message) ? err.message : 'Update check failed',
    });
  });

  // Initial check + recurring poll. Long sessions still see updates without
  // needing an app restart.
  triggerUpdateCheck();
  updateCheckTimer = setInterval(triggerUpdateCheck, UPDATE_CHECK_INTERVAL_MS);
}

function triggerUpdateCheck() {
  if (!app.isPackaged) {
    setUpdateState({ status: 'unsupported' });
    return;
  }
  // Don't stomp an in-flight download with a fresh check.
  if (updateState.status === 'downloading' || updateState.status === 'downloaded') return;
  setUpdateState({ status: 'checking', error: null });
  autoUpdater.checkForUpdates().catch((err) => {
    setUpdateState({
      status: 'error',
      error: (err && err.message) ? err.message : 'Update check failed',
    });
  });
}

ipcMain.handle('updater:status', () => updateState);

ipcMain.handle('updater:check', () => {
  triggerUpdateCheck();
  return updateState;
});

ipcMain.handle('updater:install', () => {
  if (!app.isPackaged || updateState.status !== 'downloaded') {
    return { ok: false, error: 'No update is ready to install' };
  }
  // isSilent=true uses the NSIS one-click installer flow; isForceRunAfter=true
  // relaunches DockShift after the install completes.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return { ok: true };
});

ipcMain.handle('app:getVersion', () => app.getVersion());

app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

// Renderer is mounted and listening for `shell:openPanel` / `notify`. If we
// were launched from the Explorer context menu (pendingShellIntent set at
// startup), act on it now that the renderer can receive the dispatch.
ipcMain.handle('shell:rendererReady', () => {
  if (pendingShellIntent) {
    const intent = pendingShellIntent;
    pendingShellIntent = null;
    handleShellIntent(intent);
  }
  return { ok: true };
});

// Windows Explorer context-menu integration — install/remove/probe. Install
// writes the user's installed exe path into the registry; running in dev
// (node_modules\electron.exe) would point Explorer at a useless target, so
// the renderer should gate the toggle on `status.devMode === false`.
ipcMain.handle('shell:integrationStatus', async () => {
  const installed = await isShellIntegrationInstalled();
  return {
    ok: true,
    platform: process.platform,
    installed,
    devMode: !app.isPackaged,
    exePath: process.execPath,
  };
});

ipcMain.handle('shell:install', async () => {
  if (!app.isPackaged) {
    return { ok: false, error: 'Available in installed builds only — the dev exe path would be invalid.' };
  }
  const r = await installShellIntegration(process.execPath);
  if (r.ok) {
    // Stamp the installed version so the on-ready refresh skips this user
    // until the next entry-set change bumps SHELL_INTEGRATION_VERSION.
    writeJsonAtomic(settingsFile(), { ...readSettings(), shellIntegrationVersion: SHELL_INTEGRATION_VERSION });
  }
  return r;
});

ipcMain.handle('shell:uninstall', async () => {
  const r = await uninstallShellIntegration();
  // Clear the stamp so a future Install click writes a fresh one rather
  // than relying on a stale version recorded before the uninstall.
  writeJsonAtomic(settingsFile(), { ...readSettings(), shellIntegrationVersion: 0 });
  return r;
});

// On startup: if this user already opted into the menu in a prior version but
// our entry set has moved forward since (new entry, renamed flag, changed
// AppliesTo filter), silently re-install so auto-updates ship menu changes
// without requiring a manual click in Settings. No-op for users who never
// opted in (probe returns false) and for dev mode.
async function maybeRefreshShellIntegration() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try {
    const installed = await isShellIntegrationInstalled();
    if (!installed) return; // never opted in — leave alone
    const settings = readSettings();
    const stored = Number(settings.shellIntegrationVersion) || 0;
    if (stored >= SHELL_INTEGRATION_VERSION) return;
    const r = await installShellIntegration(process.execPath);
    if (r.ok) {
      writeJsonAtomic(settingsFile(), { ...readSettings(), shellIntegrationVersion: SHELL_INTEGRATION_VERSION });
    }
  } catch { /* silent — this path isn't user-facing */ }
}

// When a second DockShift launch happens (Windows Explorer "Open with…"
// context menu), hand its argv to the running instance and act on it here.
app.on('second-instance', (_event, argv) => {
  const intent = parseShellArgs(argv);
  if (intent) handleShellIntent(intent);
  // Surface the dock so the user actually sees something happen.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.showInactive();
    mainWindow.setIgnoreMouseEvents(!isDockExpanded, { forward: true });
  } else {
    startDock();
  }
});

// Act on a parsed shell intent. For 'terminal' we respawn the pty at the new
// cwd and open the Terminal panel; for 'note' we create a note from the file
// content and open the Notes panel; for 'clipboard' we push the path into the
// history (no panel opened — silent, matches the "copy to clipboard" verb).
function handleShellIntent(intent) {
  if (!intent || !intent.path) return;
  if (intent.type === 'terminal') {
    let cwd = intent.path;
    try {
      const stat = fs.statSync(cwd);
      if (!stat.isDirectory()) cwd = path.dirname(cwd);
    } catch { return; }
    // Kill the current shell so the new panel lands at the requested folder.
    if (ptyProcess) { try { ptyProcess.kill(); } catch (_) {} ptyProcess = null; }
    spawnPty(cwd);
    sendToRenderer('shell:openPanel', { panel: 'terminal' });
  } else if (intent.type === 'note') {
    let raw = '';
    try {
      const stat = fs.statSync(intent.path);
      if (!stat.isFile() || stat.size > 1_000_000) return; // 1MB cap
      raw = fs.readFileSync(intent.path, 'utf8');
    } catch { return; }
    // NotesPanel's editor is contenteditable HTML — escape the file contents
    // so file text containing tags renders as text, and turn newlines into
    // <br> so paragraph structure is preserved.
    const esc = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/\r\n|\r|\n/g, '<br>');
    const now = new Date().toISOString();
    const note = {
      id: crypto.randomUUID(),
      title: path.basename(intent.path),
      body: esc,
      pinned: false,
      fontSize: 13,
      createdAt: now,
      updatedAt: now,
    };
    const notes = readNotes();
    notes.unshift(note);
    writeNotes(notes);
    sendToRenderer('shell:openPanel', { panel: 'notes', noteId: note.id });
  } else if (intent.type === 'clipboard') {
    if (clipboardHistory && typeof clipboardHistory._push === 'function') {
      clipboardHistory._push({
        type: 'text',
        content: intent.path,
        preview: intent.path,
      });
    }
    sendToRenderer('show-notification', { title: 'DockShift Clipboard', body: `Path copied: ${path.basename(intent.path)}` });
  }
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

app.on('ready', () => {
  const settings = readSettings();

  // Serve cached Vosk model files to the renderer via a custom protocol so
  // `vosk-browser`'s fetch can load them with no special CORS dance and no
  // ad-hoc local HTTP server. The path component (or hostname) selects which
  // model — only one shipped today, but the shape supports more.
  protocol.handle('vosk-model', async (request) => {
    try {
      const url = new URL(request.url);
      const id = (url.hostname || url.pathname.replace(/^\//, '').split('/')[0] || '').trim();
      const meta = VOSK_MODELS[id];
      if (!meta) return new Response('Unknown model', { status: 404 });
      const filePath = voskModelPath(id);
      const buffer = await fs.promises.readFile(filePath);
      return new Response(buffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Length': String(buffer.length),
          'Cache-Control': 'no-store',
        },
      });
    } catch (err) {
      return new Response(`Model load failed: ${err.message}`, { status: 500 });
    }
  });

  // Auto-updater and heartbeat are dock-independent — start them either way so
  // a user who's stuck on the welcome screen still gets background updates.
  setupAutoUpdater();
  startHeartbeatLoop();

  // Carry forward the user's Explorer context-menu state across auto-updates.
  // No-op when the user never opted in or when the stamped version is current.
  maybeRefreshShellIntegration();

  if (settings.hasCompletedWelcome) {
    startDock();
  } else {
    createWelcomeWindow();
  }

  // If we were launched from the Explorer context menu, act on the intent
  // once the renderer has had a chance to subscribe. The renderer signals
  // readiness via `shell:rendererReady`; we drain `pendingShellIntent` then.
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (clipboardHistory) clipboardHistory.stop();
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
});
