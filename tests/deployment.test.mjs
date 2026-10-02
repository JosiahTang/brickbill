import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { readServerSettings, parseTokenAuthorizations, validatePdfRuntime } from '../server/config.ts';

test('production startup requires explicit project, persistent data path and project tokens', () => {
  assert.throws(() => readServerSettings({ REPORTING_MODE: 'production', REPORTING_HOST: '0.0.0.0',
    REPORTING_DATA_DIR: resolve('test-data') }), /可用项目/);
  assert.throws(() => readServerSettings({ REPORTING_MODE: 'production', REPORTING_DEMO_PROJECTS: 'enabled' }), /REPORTING_DATA_DIR/);
  assert.throws(() => readServerSettings({ REPORTING_MODE: 'production', REPORTING_DEMO_PROJECTS: 'enabled',
    REPORTING_DATA_DIR: resolve('test-data') }), /REPORTING_TOKENS_JSON/);
  assert.throws(() => readServerSettings({ REPORTING_HOST: '0.0.0.0' }), /非本机监听/);
  assert.throws(() => readServerSettings({ REPORTING_MODE: 'production', REPORTING_DEMO_PROJECTS: 'enabled',
    REPORTING_DATA_DIR: './data', REPORTING_TOKENS_JSON: '{"token":["dalipu-demo"]}' }), /绝对路径/);
  const settings = readServerSettings({ REPORTING_MODE: 'production', REPORTING_HOST: '0.0.0.0',
    REPORTING_DATA_DIR: resolve('test-data'), REPORTING_DEMO_PROJECTS: 'enabled', REPORTING_TOKENS_JSON: '{"token":["dalipu-demo"]}' });
  assert.equal(settings.includeDemoProjects, true);
  assert.equal(settings.host, '0.0.0.0');
  assert.equal(settings.dataDirectory, resolve('test-data'));
  assert.equal(readServerSettings({ REPORTING_MODE: 'production', REPORTING_PROJECTS_FILE: resolve('projects.json'),
    REPORTING_DATA_DIR: resolve('test-data'), REPORTING_TOKENS_JSON: '{"token":["real-project"]}' }).includeDemoProjects, false);
  assert.equal(readServerSettings({}).includeDemoProjects, true);
});

test('token and PDF settings fail before service startup when malformed', () => {
  assert.throws(() => parseTokenAuthorizations('{broken'), /有效 JSON/);
  assert.throws(() => parseTokenAuthorizations('{"token":[]}'), /非空项目 ID/);
  assert.throws(() => readServerSettings({ REPORTING_PDF_ENABLED_PROJECTS: 'dalipu-demo' }), /PDF_PYTHON/);
  assert.throws(() => validatePdfRuntime({ REPORTING_PDF_ENABLED_PROJECTS: 'dalipu-demo',
    REPORTING_PDF_PYTHON: '/missing/python', REPORTING_PDF_FALLBACK_FONT: '/missing/font.ttf' }), /不存在/);
});

test('deployed API starts with explicit config and reprints the same file after restart', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), `brickbill-t23-${process.pid}-`));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const webProbe = createServer(); webProbe.listen(0, '127.0.0.1'); await once(webProbe, 'listening');
  const webPort = webProbe.address().port; await new Promise(resolve => webProbe.close(resolve));
  const environment = { ...process.env, REPORTING_MODE: 'production', REPORTING_HOST: '127.0.0.1',
    REPORTING_PORT: String(port), REPORTING_DATA_DIR: directory, REPORTING_DEMO_PROJECTS: 'enabled',
    REPORTING_PROJECTS_FILE: '', REPORTING_TOKENS_JSON: '{"test-token":["dalipu-demo"]}',
    REPORTING_PDF_ENABLED_PROJECTS: '' };
  let processHandle;
  let webHandle;
  async function start() {
    const child = spawn(process.execPath, ['--experimental-strip-types', 'server/main.ts'], {
      cwd: resolve('.'), env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk.toString(); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`API exited before readiness: ${errors}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return child;
      } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    child.kill(); throw new Error(`API readiness timed out: ${errors}`);
  }
  async function stop(child) {
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('API shutdown timed out')), 5000))]);
  }
  function smoke(extra) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/smoke-deployment.mjs'], {
      cwd: resolve('.'), encoding: 'utf8', timeout: 120_000, windowsHide: true,
      env: { ...environment, BRICKBILL_SMOKE_URL: `http://127.0.0.1:${port}`,
        BRICKBILL_SMOKE_TOKEN: 'test-token', ...extra } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  }
  try {
    processHandle = await start();
    webHandle = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort)], {
      cwd: resolve('.'), env: { ...environment, REPORTING_DEV_API_URL: `http://127.0.0.1:${port}` },
      windowsHide: true, stdio: 'ignore' });
    let proxied = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${webPort}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok && (await response.json()).status === 'ok') { proxied = true; break; }
      } catch { /* wait for Vite startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(proxied, 'frontend dev server forwards /api to the reporting service');
    const page = await fetch(`http://127.0.0.1:${webPort}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="app"/);
    const issued = smoke({ BRICKBILL_SMOKE_CREATE_DEMO: '1' });
    assert.ok(issued.generationId);
    assert.equal(issued.sha256.length, 64);
    await stop(processHandle); processHandle = undefined;
    processHandle = await start();
    const reprinted = smoke({ BRICKBILL_SMOKE_GENERATION_ID: issued.generationId });
    assert.equal(reprinted.sha256, issued.sha256);
    assert.equal(reprinted.pageCount, issued.pageCount);
  } finally {
    if (webHandle && webHandle.exitCode === null) webHandle.kill();
    if (processHandle && processHandle.exitCode === null) processHandle.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
