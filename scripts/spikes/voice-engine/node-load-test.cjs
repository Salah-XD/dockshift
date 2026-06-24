// Stage A.1 — does the prebuilt sherpa-onnx-node binary load under PLAIN NODE?
'use strict';

function report(tag) {
  console.log(`\n[${tag}] runtime versions:`);
  console.log('  node    :', process.versions.node);
  console.log('  v8      :', process.versions.v8);
  console.log('  modules :', process.versions.modules, '(NODE_MODULE_VERSION / ABI)');
  console.log('  electron:', process.versions.electron || '(none — plain node)');
}

try {
  report('plain-node');
  const t0 = Date.now();
  const sherpa = require('sherpa-onnx-node');
  const loadMs = Date.now() - t0;

  const keys = Object.keys(sherpa).sort();
  console.log(`\n[plain-node] require('sherpa-onnx-node') OK in ${loadMs}ms`);
  console.log('[plain-node] exported keys:', keys.join(', '));

  if (typeof sherpa.OfflineRecognizer === 'undefined') {
    console.log('[plain-node] WARNING — OfflineRecognizer export missing');
  } else {
    console.log('[plain-node] OfflineRecognizer export present');
  }
  console.log('\nRESULT plain-node: PASS — native binary loads.');
  process.exit(0);
} catch (err) {
  report('plain-node');
  console.error('\nRESULT plain-node: FAIL — could not load native binary.');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
