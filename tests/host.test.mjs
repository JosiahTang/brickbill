import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostBridge } from '../src/bridge/host.ts';

function override(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name];
}
class FakeFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(buffer => {
      this.result = `data:application/octet-stream;base64,${Buffer.from(buffer).toString('base64')}`;
      this.onload?.();
    }).catch(error => { this.error = error; this.onerror?.(); });
  }
}
function simulator(versions) {
  const listeners = new Set(), requests = [];
  const webview = {
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    postMessage(message) {
      requests.push(message);
      queueMicrotask(() => {
        const version = message.action === 'GET_CAPABILITIES' ? 1 : message.version;
        const result = message.action === 'GET_CAPABILITIES' ? { supportedVersions: versions } : { saved: true, action: message.action };
        const reply = { channel: 'report-designer', version, id: message.id, ok: true, result };
        for (const listener of listeners) listener({ data: reply });
      });
    },
  };
  return { webview, requests };
}
function installWindow(webview) { return override('window', { chrome: { webview } }); }

test('host negotiates v2 for complete template packages and generated files', async () => {
  const host = simulator([1, 2]);
  const restores = [installWindow(host.webview), override('FileReader', FakeFileReader)];
  try {
    const bridge = await createHostBridge();
    assert.equal(bridge.supportsPackageSave, true);
    const template = { contractVersion: 2, packageId: 'template.demo', projectId: 'demo', name: 'demo', revision: 0, status: 'draft' };
    const savedTemplate = await bridge.savePackage('multi-sheet.xlsx', new Uint8Array([1, 2, 3]), template);
    assert.equal(savedTemplate.status, 'acknowledged');
    const savedFile = await bridge.saveGenerated('certificate.xlsx', new Uint8Array([4, 5]),
      { projectId: 'demo', generationId: 'gen-demo', sha256: 'a'.repeat(64) });
    assert.equal(savedFile.status, 'acknowledged');
    assert.deepEqual(host.requests.map(request => [request.version, request.action]), [
      [1, 'GET_CAPABILITIES'], [2, 'SAVE_TEMPLATE_PACKAGE'], [2, 'SAVE_GENERATION'],
    ]);
    assert.equal(host.requests[1].payload.templatePackage.packageId, 'template.demo');
    assert.equal(host.requests[2].payload.generationId, 'gen-demo');
    bridge.dispose();
  } finally { restores.reverse().forEach(restore => restore()); }
});

test('v1-only hosts receive no v2 payload and retain the legacy single-document save action', async () => {
  const host = simulator([1]);
  const originalTimer = globalThis.setTimeout;
  const downloads = [];
  const restores = [
    installWindow(host.webview), override('FileReader', FakeFileReader),
    override('document', { createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }), body: { appendChild() {} } }),
    override('setTimeout', (fn, delay, ...args) => originalTimer(fn, Math.min(delay ?? 0, 20), ...args)),
  ];
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test'; URL.revokeObjectURL = () => {};
  try {
    const bridge = await createHostBridge();
    assert.equal(bridge.supportsPackageSave, false);
    const templateResult = await bridge.savePackage('package.xlsx', new Uint8Array([1]), { packageId: 'template.demo' });
    assert.equal(templateResult.status, 'download-requested');
    assert.deepEqual(downloads, ['package.xlsx']);
    const doc = { schemaVersion: 1, id: 'doc', revision: 0, name: 'doc', sheetName: 'Main', syntax: 'mustache', rows: 1, cols: 1,
      rowHeightPx: [20], colWidthPx: [60], cells: {}, merges: [], blocks: [] };
    const legacyResult = await bridge.save('single.xlsx', new Uint8Array([2]), doc);
    assert.equal(legacyResult.status, 'acknowledged');
    assert.deepEqual(host.requests.map(request => [request.version, request.action]), [[1, 'GET_CAPABILITIES'], [1, 'SAVE_TEMPLATE']]);
    bridge.dispose();
  } finally {
    URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;
    restores.reverse().forEach(restore => restore());
  }
});
