/**
 * Auto-insert transcribed text into whatever app currently has focus.
 *
 * Used by the voice dictation pill (Phase 2): the pill window is non-activating
 * (`showInactive`), so the OS foreground window stays the user's target app, and
 * a synthetic Ctrl+V lands the clipboard there. We always restore the user's
 * prior clipboard afterward so dictation never clobbers what they had copied.
 *
 * Mechanism is PowerShell `SendKeys('^v')` — no native module, lowest
 * antivirus-false-positive surface. Text fidelity (Unicode/emoji) comes from the
 * clipboard, not synthetic typing, so SendKeys' literal-text quirks don't apply.
 *
 * `insertText` is electron-free and takes `clipboard` + `sendPaste` as inputs so
 * the orchestration (save → set → paste → restore) is unit-testable without
 * Electron or actually pasting. The caller in electron-main.js passes Electron's
 * `clipboard`; `sendPaste` defaults to the real PowerShell keystroke.
 */
import { execFile } from 'node:child_process';

/** Fire a single synthetic Ctrl+V via PowerShell SendKeys (no native dep). */
export function sendCtrlV() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', "$w = New-Object -ComObject WScript.Shell; $w.SendKeys('^v')"],
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/**
 * Insert `text` into the focused app.
 *
 * @param {string} text
 * @param {object} opts
 * @param {'paste'|'clipboard'} [opts.mode='paste']  'clipboard' = copy only, no keystroke
 * @param {number} [opts.restoreDelayMs=400]         delay before restoring prior clipboard
 * @param {{readText:()=>string, writeText:(s:string)=>void}} opts.clipboard  Electron clipboard
 * @param {() => Promise<void>} [opts.sendPaste]      keystroke sender (injectable for tests)
 * @returns {Promise<{pasted: boolean}>}
 */
export async function insertText(text, opts = {}) {
  const { mode = 'paste', restoreDelayMs = 400, clipboard, sendPaste = sendCtrlV } = opts;
  if (!clipboard) throw new Error('insertText: clipboard is required');

  // Clipboard-only mode: leave the text on the clipboard for the user to paste
  // themselves. No synthetic keystroke, nothing to restore.
  if (mode === 'clipboard') {
    clipboard.writeText(text);
    return { pasted: false };
  }

  const prev = clipboard.readText();
  clipboard.writeText(text);
  await sendPaste();
  // Restore after a delay so the paste keystroke has consumed the clipboard first.
  setTimeout(() => {
    try { clipboard.writeText(prev); } catch { /* clipboard busy; harmless */ }
  }, restoreDelayMs);
  return { pasted: true };
}
