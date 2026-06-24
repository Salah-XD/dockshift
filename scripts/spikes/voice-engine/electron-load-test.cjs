// Stage A.2 — does the SAME binary load under the ELECTRON runtime (the ABI risk, issue #1945)?
// Run with the project's electron, NOT plain node, and WITHOUT ELECTRON_RUN_AS_NODE
// (that flag would run plain node and defeat the test).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const out = {
  ranAs: process.versions.electron ? 'electron' : 'node-or-run-as-node',
  versions: {
    node: process.versions.node,
    electron: process.versions.electron || null,
    modules: process.versions.modules, // ABI
    v8: process.versions.v8,
  },
  load: null,
  keys: null,
  error: null,
};

try {
  const sherpa = require('sherpa-onnx-node');
  out.load = 'PASS';
  out.keys = Object.keys(sherpa).sort();
  out.hasOfflineRecognizer = typeof sherpa.OfflineRecognizer !== 'undefined';
} catch (err) {
  out.load = 'FAIL';
  out.error = err && err.stack ? err.stack : String(err);
}

fs.writeFileSync(path.join(__dirname, 'electron-result.json'), JSON.stringify(out, null, 2));
process.stdout.write('\n[electron] ' + JSON.stringify(out, null, 2) + '\n');

try {
  const { app } = require('electron');
  if (app && typeof app.whenReady === 'function') {
    app.disableHardwareAcceleration();
    app.whenReady().then(() => {
      process.stdout.write(`[electron] app ready — load=${out.load}, electron=${out.versions.electron}, abi=${out.versions.modules}\n`);
      app.quit();
    });
    app.on('window-all-closed', () => app.quit());
  } else {
    process.exit(out.load === 'PASS' ? 0 : 1);
  }
} catch (e) {
  process.exit(out.load === 'PASS' ? 0 : 1);
}
