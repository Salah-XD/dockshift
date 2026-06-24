// Verifies electron-paste.js insertText() — clipboard save/set/restore + the
// mode='clipboard' short-circuit. Pure orchestration (clipboard + keystroke are
// injected), so this runs under plain Node with fakes — no Electron, no real paste.
//   node verify-paste.mjs
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { insertText } from '../../../electron-paste.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checks = [];
const ok = (n, c, d) => { checks.push({ name: n, pass: !!c, detail: d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeClipboard(initial = '') {
  let v = initial;
  return { readText: () => v, writeText: (t) => { v = t; }, _get: () => v };
}

// ── Case A: mode='clipboard' writes text and sends NO keystroke ────────────────
{
  const clip = fakeClipboard('ORIG');
  let pasteCalls = 0;
  const res = await insertText('hello world', { mode: 'clipboard', clipboard: clip, sendPaste: async () => { pasteCalls++; } });
  ok("A: mode=clipboard returns pasted:false", res?.pasted === false, JSON.stringify(res));
  ok("A: clipboard holds the text", clip._get() === 'hello world', clip._get());
  ok("A: no synthetic keystroke sent", pasteCalls === 0, `calls=${pasteCalls}`);
}

// ── Case B: mode='paste' sets text, sends ^v once, then restores prior clipboard ─
{
  const clip = fakeClipboard('PREVIOUS-CLIP');
  let pasteCalls = 0;
  let clipAtPaste = null;
  const res = await insertText('dictated text', {
    mode: 'paste', clipboard: clip, restoreDelayMs: 30,
    sendPaste: async () => { pasteCalls++; clipAtPaste = clip._get(); },
  });
  ok('B: returns pasted:true', res?.pasted === true, JSON.stringify(res));
  ok('B: ^v sent exactly once', pasteCalls === 1, `calls=${pasteCalls}`);
  ok('B: text was on clipboard at paste time', clipAtPaste === 'dictated text', clipAtPaste);
  ok('B: text still present immediately after (restore pending)', clip._get() === 'dictated text', clip._get());
  await sleep(60);
  ok('B: prior clipboard restored after delay', clip._get() === 'PREVIOUS-CLIP', clip._get());
}

const pass = checks.every((c) => c.pass);
console.log(`\nRESULT verify-paste: ${pass ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.pass).length}/${checks.length})`);
fs.writeFileSync(path.join(__dirname, 'verify-paste-result.json'), JSON.stringify({ pass, checks }, null, 2));
process.exitCode = pass ? 0 : 1;
