import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readServerSettings, parseTokenActorIds, parseTokenAuthorizations, validatePdfRuntime } from '../server/config.ts';
import { LocalSnapshotRepository } from '../server/repositories/local.ts';
import {
  assertSmokeHelperContainerOwner, composeSmokeArguments, composeSmokeEnvironment, createComposeRestoreResult, createComposeSmokeResult,
  finalizeComposeSmokeOutcome, isMissingDockerContainerError, isMissingDockerResourceError,
  assertDockerCommandResult, persistComposeSmokeOutcome, resolveComposeSmokeMode,
  dockerTarBackupArguments, dockerTarRestoreArguments, dockerVolumeRemoveArguments,
  dockerVolumeLookupArguments, parseComposePublishedUrl, parseDockerVolumeList, requireSmokeGenerationId,
} from '../scripts/compose-smoke-result.mjs';
import { inspectDeploymentEvidence, verifyDeploymentBackupEvidence } from '../scripts/deployment-evidence.mjs';
import { verifyGenerationDependencies } from '../scripts/deployment-dependencies.mjs';
import { waitForChildClose, runChildProcess } from '../scripts/compose-smoke-process.mjs';
import { createExclusiveArchiveSink, removePartialArchive } from '../scripts/compose-smoke-archive.mjs';

const execFileAsync = promisify(execFile);

async function runComposeScenario(scenario) {
  const directory = await mkdtemp(resolve(tmpdir(), 'brickbill-t42-entry-'));
  const commandLog = resolve(directory, 'commands.jsonl');
  try {
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(resolve('tests/fixtures/deployment/compose-process-stub.mjs')).href,
      resolve('scripts/ci-compose-smoke.mjs')], {
      cwd: directory, encoding: 'utf8', timeout: 15_000, windowsHide: true,
      env: { ...process.env, BRICKBILL_SMOKE_TOKEN: 't42-test-token', BRICKBILL_SMOKE_PROJECT: 'dalipu-demo',
        BRICKBILL_SMOKE_GENERATION_ID: '', BRICKBILL_SMOKE_CREATE_DEMO: '1', BRICKBILL_SMOKE_EXPECT_PDF: '',
        BRICKBILL_TEST_COMPOSE_SCENARIO: scenario, BRICKBILL_TEST_COMMAND_LOG: commandLog },
    });
    assert.equal(child.error, undefined, child.error?.message);
    const runs = await readdir(resolve(directory, 'output/t38')).catch(error => {
      throw new Error(`CLI did not create its run directory: ${child.stderr || child.stdout}`, { cause: error });
    });
    assert.equal(runs.length, 1, 'the actual CLI must create exactly one isolated run directory');
    const runDirectory = resolve(directory, 'output/t38', runs[0]);
    const optionalJson = async name => {
      try { return JSON.parse(await readFile(resolve(runDirectory, name), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    };
    return { child, failure: await optionalJson('compose-failure.json'), result: await optionalJson('compose-smoke-result.json'),
      commands: (await readFile(commandLog, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line)),
      files: await readdir(runDirectory) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('T42.1: the smoke CLI preserves process errors and diagnoses missing or malformed output', async () => {
  for (const [scenario, expected] of [
    ['ENOENT', /ENOENT/], ['EPERM', /EPERM/], ['ETIMEDOUT', /ETIMEDOUT/],
    ['nonzero', /synthetic smoke refused request/], ['empty', /未返回 JSON/], ['invalid-json', /无效 JSON/],
  ]) {
    const run = await runComposeScenario(scenario);
    assert.notEqual(run.child.status, 0, scenario);
    assert.equal(run.failure?.status, 'failed', scenario);
    assert.match(run.failure.primaryFailure, expected, `${scenario}: ${run.failure.primaryFailure}`);
    assert.doesNotMatch(run.failure.primaryFailure, /reading 'trim'/);
    assert.equal(run.result, undefined);
  }
});

test('T42.2: cleanup rejects mixed diagnostics and unexpected exits even when they mention a missing resource', () => {
  for (const [description, child] of [
    ['daemon error with missing text on stdout', { status: 1, stderr: 'Cannot connect to the Docker daemon', stdout: 'No such image: sample' }],
    ['mixed stderr lines', { status: 1, stderr: 'No such image: sample\npermission denied', stdout: '' }],
    ['missing text embedded in another error', { status: 1, stderr: 'permission denied: No such image: sample', stdout: '' }],
    ['missing error on stdout only', { status: 1, stderr: '', stdout: 'No such image: sample' }],
    ['unexpected exit', { status: 2, stderr: 'No such image: sample', stdout: '' }],
    ['signal exit', { status: null, signal: 'SIGTERM', stderr: 'No such image: sample', stdout: '' }],
    ['unexpected stdout', { status: 1, stderr: 'No such image: sample', stdout: 'permission denied' }],
    ['wrong resource type', { status: 1, stderr: 'No such volume: sample', stdout: '' }],
  ]) assert.throws(() => assertDockerCommandResult(child, 'image inspect', 'image'), undefined, description);
  assert.equal(isMissingDockerResourceError('No such image: sample\nCannot connect to the Docker daemon', 'image'), false);
  assert.equal(assertDockerCommandResult({ status: 1, stdout: '[]\n', stderr: 'Error: No such image: sample\n' },
    'image inspect', 'image'), false);
  assert.equal(assertDockerCommandResult({ status: 1, stdout: '[]', stderr: 'Error response from daemon: get sample_data: no such volume' },
    'volume inspect', 'volume'), false);
  assert.equal(assertDockerCommandResult({ status: 1, stdout: '', stderr: 'Error response from daemon: No such container: sample-helper' },
    'container inspect', 'container'), false);
});

test('T42.3: the actual smoke entry continues cleanup, persists failures, and exits with the outcome status', async () => {
  const success = await runComposeScenario('success');
  assert.equal(success.child.status, 0, success.child.stderr);
  assert.equal(success.failure, undefined);
  assert.equal(success.result.status, 'passed');
  assert.equal(success.result.deploymentEvidenceVersion, 3);
  assert.equal(success.result.restoreSnapshotReused, true);
  assert.match(success.result.backupSha256, /^[a-f0-9]{64}$/);
  for (const file of ['reporting-data.tgz', 'backup-evidence.json', 'compose.log', 'restore-compose.log'])
    assert.ok(success.files.includes(file), file);

  for (const scenario of ['main-and-cleanup-failure', 'cleanup-only-failure']) {
    const run = await runComposeScenario(scenario);
    assert.equal(run.child.status, 1, run.child.stderr);
    assert.equal(run.failure.status, 'failed');
    assert.equal(run.failure.code, 'COMPOSE_SMOKE_CLEANUP_FAILED');
    assert.ok(run.failure.cleanupErrors.length >= 4, JSON.stringify(run.failure));
    assert.match(run.failure.cleanupErrors.join('\n'), /helper cleanup failure/);
    assert.match(run.failure.cleanupErrors.join('\n'), /restore logs/);
    assert.match(run.failure.cleanupErrors.join('\n'), /compose down/);
    assert.match(run.failure.cleanupErrors.join('\n'), /image cleanup failure/);
    assert.doesNotMatch(run.child.stdout, /backup and empty-volume restore passed/);
    assert.ok(run.files.includes('compose-failure.json'));

    const commands = run.commands;
    const backupInspect = commands.findIndex(({ args }) => args[0] === 'container' && args[1] === 'inspect' && args[2].endsWith('-backup'));
    const sourceLogs = commands.findIndex(({ args }) => args[0] === 'compose' && args[3] === 'logs' && args[2].startsWith('brickbill-smoke-'));
    const sourceDown = commands.findIndex(({ args }) => args[0] === 'compose' && args[3] === 'down' && args[2].startsWith('brickbill-smoke-'));
    const webRemoval = commands.findIndex(({ args }) => args[0] === 'image' && args[1] === 'rm' && args[2].endsWith('-web:local'));
    assert.ok(backupInspect >= 0 && sourceLogs > backupInspect && sourceDown > sourceLogs && webRemoval > sourceDown,
      'later helper, logging, Compose and image cleanup must all run after earlier failures');
    if (scenario === 'main-and-cleanup-failure') {
      assert.match(run.failure.primaryFailure, /exited 7/);
      assert.equal(run.result, undefined);
    } else {
      assert.equal(run.failure.primaryFailure, undefined);
      assert.equal(run.result.status, 'failed');
      assert.equal(run.result.deploymentEvidenceVersion, 3);
      assert.equal(run.result.code, 'COMPOSE_SMOKE_CLEANUP_FAILED');
      assert.ok(commands.some(({ args }) => args[0] === 'volume' && args[1] === 'rm'),
        'the owned restore volume must still be cleaned after Compose down fails');
    }
  }
});

test('T40.1: the API runtime files copied by Dockerfile start outside the workspace', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'brickbill-t40-api-package-'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  let child;
  try {
    const dockerfile = await readFile(resolve('Dockerfile'), 'utf8');
    const apiStage = dockerfile.split(/FROM [^\r\n]+ AS api\r?\n/)[1]?.split(/\r?\nFROM /)[0];
    assert.ok(apiStage, 'the deployment regression must inspect the actual API stage');
    // Stage only its local COPY inputs; node_modules is the explicit api-deps stage dependency.
    for (const line of apiStage.split(/\r?\n/).filter(line => line.startsWith('COPY ') && !line.startsWith('COPY --from='))) {
      const match = /^COPY ([\w./*-]+) ([\w./-]+)$/.exec(line);
      assert.ok(match, `unsupported local COPY in this focused packaging regression: ${line}`);
      const [, source, destination] = match;
      for (const input of source === 'package*.json' ? ['package.json', 'package-lock.json'] : [source]) {
        const target = resolve(directory, destination, ...(destination === './' ? [basename(input)] : []));
        await mkdir(resolve(target, '..'), { recursive: true });
        await cp(resolve(input), target, { recursive: true, errorOnExist: true });
      }
    }
    await symlink(resolve('node_modules'), resolve(directory, 'node_modules'), 'junction');
    child = spawn(process.execPath, ['--experimental-strip-types', 'server/main.ts'], {
      cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, REPORTING_MODE: 'development', REPORTING_HOST: '127.0.0.1',
        REPORTING_PORT: String(port), REPORTING_DATA_DIR: resolve(directory, 'data'),
        REPORTING_DEMO_PROJECTS: 'enabled', REPORTING_PROJECTS_FILE: '', REPORTING_TOKENS_JSON: '',
        REPORTING_TOKEN_ACTORS_JSON: '', REPORTING_PDF_ENABLED_PROJECTS: '' },
    });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, `packaged API exited before readiness: ${stderr}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { assert.equal((await response.json()).status, 'ok'); return; }
      } catch { /* Wait for this isolated API process only. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`packaged API did not start: ${stderr}`);
  } finally {
    if (child && child.exitCode === null) {
      const stopped = waitForChildClose(child, { timeoutMs: 5_000, label: 'T40 packaged API' });
      child.kill('SIGTERM'); await stopped;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('T34.5: compose smoke result requires the same project, generation, page count and file hash', () => {
  assert.deepEqual(composeSmokeArguments('brickbill-smoke-123', 'down', '--volumes', '--remove-orphans'),
    ['compose', '--project-name', 'brickbill-smoke-123', 'down', '--volumes', '--remove-orphans']);
  assert.throws(() => composeSmokeArguments('../unscoped-project', 'down', '--volumes'), /命名约束/);
  const first = { projectId: 'dalipu-demo', generationId: 'gen-one', pageCount: 3, sha256: 'a'.repeat(64),
    dependencySha256: 'c'.repeat(64), dependencyCount: 2 };
  assert.deepEqual(createComposeSmokeResult(first, structuredClone(first), 'brickbill-smoke-123'), {
    status: 'passed', projectId: 'dalipu-demo', generationId: 'gen-one', pageCount: 3, sha256: 'a'.repeat(64),
    dependencySha256: 'c'.repeat(64), dependencyCount: 2,
    restartSnapshotReused: true, deploymentStage: 'restart', composeProjectName: 'brickbill-smoke-123',
  });
  for (const change of [
    { projectId: 'general-mes-demo' }, { generationId: 'gen-two' }, { pageCount: 4 }, { sha256: 'b'.repeat(64) },
  ]) assert.throws(() => createComposeSmokeResult(first, { ...first, ...change }, 'brickbill-smoke-123'), /服务重启后/);
  assert.throws(() => createComposeSmokeResult(first, { ...first, sha256: 'invalid' }, 'brickbill-smoke-123'), /SHA-256/);
});

test('T34.5: restart-only deployment evidence stays pending until an isolated restore is verified', () => {
  const restartOnly = { status: 'passed', projectId: 'dalipu-demo', generationId: 'gen-one', pageCount: 3,
    sha256: 'a'.repeat(64), restartSnapshotReused: true };
  const context = { projectId: 'dalipu-demo', acceptanceVersion: 2 };
  assert.equal(inspectDeploymentEvidence(restartOnly, context).status, 'pending');
  const restored = { ...restartOnly, restoreSnapshotReused: true, restoreMethod: 'empty-directory',
    restoreTargetEmptyBeforeCopy: true, restoreGenerationId: 'gen-one', restorePageCount: 3, restoreSha256: 'a'.repeat(64) };
  assert.deepEqual(inspectDeploymentEvidence(restored, context), { status: 'passed' });
  assert.equal(inspectDeploymentEvidence({ ...restored, deploymentEvidenceVersion: 5 }, context).code,
    'DEPLOYMENT_EVIDENCE_VERSION_UNSUPPORTED');
  for (const change of [
    { restoreTargetEmptyBeforeCopy: false }, { restoreGenerationId: 'gen-two' },
    { restorePageCount: 2 }, { restoreSha256: 'b'.repeat(64) }, { restoreMethod: 'unknown' },
  ]) assert.equal(inspectDeploymentEvidence({ ...restored, ...change }, context).status, 'failed');
});

test('T35.1: compose smoke binds a random loopback port and resolves only its own endpoint', () => {
  assert.deepEqual(composeSmokeEnvironment('brickbill-smoke-abc'), {
    BRICKBILL_PORT: '', BRICKBILL_BIND: '127.0.0.1',
    BRICKBILL_API_IMAGE: 'brickbill-smoke-brickbill-smoke-abc-api:local',
    BRICKBILL_WEB_IMAGE: 'brickbill-smoke-brickbill-smoke-abc-web:local',
  });
  assert.equal(parseComposePublishedUrl('127.0.0.1:32781\n'), 'http://127.0.0.1:32781');
  assert.throws(() => parseComposePublishedUrl('0.0.0.0:32781'), /仅允许本机地址/);
  assert.throws(() => parseComposePublishedUrl('127.0.0.1:abc'), /端口/);
  assert.throws(() => parseComposePublishedUrl('127.0.0.1:30001\n127.0.0.1:30002'), /唯一/);
  assert.doesNotThrow(() => requireSmokeGenerationId(undefined, false));
  assert.throws(() => requireSmokeGenerationId(undefined, true), /不能仅以健康检查标记通过/);
  assert.doesNotThrow(() => requireSmokeGenerationId('generation-1', true));
});

test('T36.1: isolated Compose smoke only creates an explicit synthetic demo generation', () => {
  assert.deepEqual(resolveComposeSmokeMode({ projectId: 'dalipu-demo', createDemo: true }), { mode: 'synthetic-demo' });
  assert.throws(() => resolveComposeSmokeMode({ projectId: 'real-customer', generationId: 'gen-real' }), /独立数据卷/);
  assert.throws(() => resolveComposeSmokeMode({ projectId: 'dalipu-demo', generationId: 'gen-existing' }), /独立数据卷/);
  assert.throws(() => resolveComposeSmokeMode({ projectId: 'dalipu-demo' }), /显式启用/);
  assert.throws(() => resolveComposeSmokeMode({ projectId: 'real-customer', createDemo: true }), /仅支持/);
  const child = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/ci-compose-smoke.mjs'], {
    cwd: resolve('.'), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, BRICKBILL_SMOKE_TOKEN: 'regression-token', BRICKBILL_SMOKE_PROJECT: 'dalipu-demo',
      BRICKBILL_SMOKE_GENERATION_ID: 'already-existing' },
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /独立数据卷/);
  assert.doesNotMatch(child.stderr, /docker is not recognized|ENOENT/i);
});

test('T36.2: restore runs with ownership privileges and rejects unreadable or damaged archives before extraction', () => {
  const args = dockerTarRestoreArguments('sha256:abc', 'brickbill-smoke-restore_reporting-data',
    'brickbill-smoke-test-run-restore', 'test-run');
  assert.ok(args.includes('--user') && args[args.indexOf('--user') + 1] === '0:0');
  const command = args.at(-1);
  assert.match(command, /find \/target -mindepth 1 -print -quit\) \|\| exit/);
  assert.match(command, /tar -tzf/);
  assert.ok(command.indexOf('tar -tzf') < command.indexOf('tar -C /target -xzf'));
  assert.match(command, /chown -R 10001:10001 \/target/);
});

test('T36.2: stalled Docker transfer is terminated and reported as a timeout', async () => {
  const listeners = new Map();
  const signals = [];
  const child = { once(event, callback) { listeners.set(event, callback); return this; },
    kill(signal) { signals.push(signal); if (signal === 'SIGTERM') setImmediate(() => listeners.get('close')?.(null)); return true; } };
  await assert.rejects(waitForChildClose(child, { timeoutMs: 10, label: '测试传输', killGraceMs: 20 }), /超过 10ms/);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('T37.1: a child that ignores termination is bounded and its helper container has a unique owner label', async () => {
  const listeners = new Map();
  const signals = [];
  const child = { once(event, callback) { listeners.set(event, callback); return this; },
    kill(signal) { signals.push(signal); return true; } };
  await assert.rejects(Promise.race([
    waitForChildClose(child, { timeoutMs: 5, label: 'T37 helper', killGraceMs: 10 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('child wait was unbounded')), 150)),
  ]), /超过 5ms/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);

  const backup = dockerTarBackupArguments('sha256:abc', 'brickbill-smoke-abc_reporting-data',
    'brickbill-smoke-abc-run-id-backup', 'abc-run-id');
  const restore = dockerTarRestoreArguments('sha256:abc', 'brickbill-smoke-abc_reporting-data',
    'brickbill-smoke-abc-run-id-restore', 'abc-run-id');
  for (const [args, name] of [[backup, 'brickbill-smoke-abc-run-id-backup'], [restore, 'brickbill-smoke-abc-run-id-restore']]) {
    assert.equal(args[args.indexOf('--name') + 1], name);
    assert.ok(args.includes('com.brickbill.smoke.run=abc-run-id'));
  }
  assert.doesNotThrow(() => assertSmokeHelperContainerOwner({ Config: { Labels: { 'com.brickbill.smoke.run': 'abc-run-id' } } }, 'abc-run-id'));
  assert.throws(() => assertSmokeHelperContainerOwner({ Config: { Labels: { 'com.brickbill.smoke.run': 'other-run' } } }, 'abc-run-id'), /所有权标签/);
  assert.throws(() => dockerTarBackupArguments('sha256:abc', 'brickbill-smoke-abc_reporting-data',
    'brickbill-smoke-other-run-backup', 'abc-run-id'), /绑定本次/);
});

test('T41.1: Compose commands have bounded waits and report spawn and exit failures', async () => {
  const listeners = new Map();
  const signals = [];
  const stalled = { once(event, callback) { listeners.set(event, callback); return this; },
    kill(signal) { signals.push(signal); return true; } };
  await assert.rejects(Promise.race([
    runChildProcess(stalled, { timeoutMs: 5, killGraceMs: 10, label: 'Compose 启动', command: 'docker', args: ['compose', 'up'] }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('command wait was unbounded')), 150)),
  ]), /超过 5ms/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);

  const failed = { once(event, callback) { listeners.set(event, callback); return this; }, kill() { return true; } };
  const failedRun = runChildProcess(failed, { timeoutMs: 100, label: 'Compose 清理', command: 'docker', args: ['compose', 'down'] });
  listeners.get('close')(2);
  await assert.rejects(failedRun, /docker compose down exited 2/);

  const spawnFailure = { once(event, callback) { listeners.set(event, callback); return this; }, kill() { return true; } };
  const spawnRun = runChildProcess(spawnFailure, { timeoutMs: 100, label: 'Compose spawn', command: 'docker' });
  listeners.get('error')(new Error('spawn denied'));
  await assert.rejects(spawnRun, /spawn denied/);
});

test('T41.2: Docker cleanup treats only missing resources as harmless and reports daemon errors', () => {
  assert.equal(isMissingDockerResourceError('Error: No such image: brickbill-smoke-test', 'image'), true);
  assert.equal(isMissingDockerResourceError('Error response from daemon: no such volume: brickbill-smoke-test_data', 'volume'), true);
  assert.equal(isMissingDockerResourceError('Cannot connect to the Docker daemon', 'image'), false);
  assert.equal(isMissingDockerResourceError('permission denied while connecting', 'volume'), false);

  assert.equal(assertDockerCommandResult({ status: 0, stdout: '[]', stderr: '' }, 'image inspect', 'image'), true);
  assert.equal(assertDockerCommandResult({ status: 1, stdout: '', stderr: 'No such image: sample' }, 'image inspect', 'image'), false);
  assert.throws(() => assertDockerCommandResult({ status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' },
    'image inspect', 'image'), /Cannot connect/);
  assert.throws(() => assertDockerCommandResult({ status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) },
    'image inspect', 'image'), /timed out/);
});

test('T41.3: smoke failure and cleanup failure are persisted as failed evidence without masking the primary cause', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'brickbill-t41-evidence-'));
  try {
    const passedRecord = { status: 'passed', projectId: 'dalipu-demo', generationId: 'gen-one', pageCount: 1,
      sha256: 'a'.repeat(64), restartSnapshotReused: true, restoreSnapshotReused: true };
    const outcome = finalizeComposeSmokeOutcome({ restoreRecord: passedRecord,
      primaryError: new Error('restore verification failed'), cleanupErrors: ['image cleanup timed out'] });
    await persistComposeSmokeOutcome({ outcome, outputDirectory: directory,
      sourceProjectName: 'brickbill-smoke-source', restoreProjectName: 'brickbill-restore-source' });

    const result = JSON.parse(await readFile(resolve(directory, 'compose-smoke-result.json'), 'utf8'));
    const failure = JSON.parse(await readFile(resolve(directory, 'compose-failure.json'), 'utf8'));
    assert.equal(outcome.status, 'failed');
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'COMPOSE_SMOKE_CLEANUP_FAILED');
    assert.equal(failure.primaryFailure, 'restore verification failed');
    assert.deepEqual(failure.cleanupErrors, ['image cleanup timed out']);
    assert.equal(failure.sourceProjectName, 'brickbill-smoke-source');

    const primaryOnly = await mkdtemp(resolve(tmpdir(), 'brickbill-t41-primary-failure-'));
    try {
      await persistComposeSmokeOutcome({ outcome: finalizeComposeSmokeOutcome({ primaryError: new Error('generation failed') }),
        outputDirectory: primaryOnly, sourceProjectName: 'brickbill-smoke-source', restoreProjectName: 'brickbill-restore-source' });
      const primaryFailure = JSON.parse(await readFile(resolve(primaryOnly, 'compose-failure.json'), 'utf8'));
      assert.equal(primaryFailure.status, 'failed');
      assert.equal(primaryFailure.primaryFailure, 'generation failed');
      assert.deepEqual(primaryFailure.cleanupErrors, []);
      await assert.rejects(readFile(resolve(primaryOnly, 'compose-smoke-result.json'), 'utf8'), { code: 'ENOENT' });
    } finally { await rm(primaryOnly, { recursive: true, force: true }); }

    const fresh = await mkdtemp(resolve(tmpdir(), 'brickbill-t41-passed-'));
    try {
      await persistComposeSmokeOutcome({ outcome: finalizeComposeSmokeOutcome({ restoreRecord: passedRecord }),
        outputDirectory: fresh, sourceProjectName: 'brickbill-smoke-source', restoreProjectName: 'brickbill-restore-source' });
      assert.equal(JSON.parse(await readFile(resolve(fresh, 'compose-smoke-result.json'), 'utf8')).status, 'passed');
      await assert.rejects(readFile(resolve(fresh, 'compose-failure.json'), 'utf8'), { code: 'ENOENT' });
    } finally { await rm(fresh, { recursive: true, force: true }); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T36.3: dependency verification pins template and views and detects missing or changed resources', async () => {
  const snapshot = { templateRef: { packageId: 'certificate', revision: 4 },
    viewRefs: [{ viewId: 'chemistry', version: '1.2.0' }],
    functionRefs: [{ functionId: 'hardness', version: '2.0.0' }] };
  const template = { projectId: 'dalipu-demo', packageId: 'certificate', revision: 4,
    viewRefs: snapshot.viewRefs, functionRefs: snapshot.functionRefs,
    resources: [{ resourceId: 'seal', mediaType: 'image/png', base64: Buffer.from('seal-bytes').toString('base64') }],
    pageDefinitions: [{ imagePlacements: [{ resourceId: 'seal' }] }] };
  const view = { viewId: 'chemistry', version: '1.2.0' };
  const hash = createHash('sha256').update('seal-bytes').digest('hex');
  const makeRequest = ({ omitResource = false, resourceBytes = 'seal-bytes', viewVersion = '1.2.0', templateName = 'Certificate' } = {}) => async path => {
    if (path.endsWith('/templates/certificate/versions/4')) return { version: 4, value: { ...template, name: templateName } };
    if (path.endsWith('/views/chemistry/versions/1.2.0')) return { version: viewVersion, value: { ...view, version: viewVersion } };
    if (path.endsWith('/templates/certificate/resources/seal')) {
      if (omitResource) throw new Error('missing resource');
      const bytes = Buffer.from(resourceBytes);
      return { mediaType: 'image/png', base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    if (path.endsWith('/designer-metadata')) return { functions: [{ functionId: 'hardness', version: '2.0.0' }] };
    throw new Error(`unexpected request ${path}`);
  };
  const result = await verifyGenerationDependencies('dalipu-demo', snapshot, makeRequest());
  assert.equal(result.resourceCount, 1);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  const changedPinnedContent = await verifyGenerationDependencies('dalipu-demo', snapshot, makeRequest({ templateName: 'Tampered' }));
  assert.notEqual(changedPinnedContent.sha256, result.sha256);
  await assert.rejects(verifyGenerationDependencies('dalipu-demo', snapshot, makeRequest({ omitResource: true })), /资源/);
  await assert.rejects(verifyGenerationDependencies('dalipu-demo', snapshot, makeRequest({ resourceBytes: 'changed' })), /资源/);
  await assert.rejects(verifyGenerationDependencies('dalipu-demo', snapshot, makeRequest({ viewVersion: '9.9.9' })), /视图/);
  assert.throws(() => createComposeRestoreResult({ projectId: 'dalipu-demo', generationId: 'g1', pageCount: 1,
    sha256: 'a'.repeat(64), dependencySha256: result.sha256, dependencyCount: 1 },
  { projectId: 'dalipu-demo', generationId: 'g1', pageCount: 1, sha256: 'a'.repeat(64),
    dependencySha256: changedPinnedContent.sha256, dependencyCount: 1 }, {
    sourceProjectName: 'brickbill-smoke-source', restoreProjectName: 'brickbill-smoke-restore',
    backupSha256: 'b'.repeat(64), restoreTargetEmptyBeforeCopy: true,
  }), /恢复后/);
});

test('T36.4: restore evidence version 3 requires matching pinned dependency digests while version 2 remains readable', () => {
  const legacy = { status: 'passed', projectId: 'dalipu-demo', generationId: 'gen-one', pageCount: 1,
    sha256: 'a'.repeat(64), restartSnapshotReused: true, deploymentEvidenceVersion: 2,
    backupSha256: 'b'.repeat(64), backupArchivePath: 'backup.tgz', restoreSnapshotReused: true,
    restoreMethod: 'empty-volume', restoreTargetEmptyBeforeCopy: true, restoreGenerationId: 'gen-one',
    restorePageCount: 1, restoreSha256: 'a'.repeat(64) };
  assert.equal(inspectDeploymentEvidence(legacy, { projectId: 'dalipu-demo', acceptanceVersion: 2 }).status, 'passed');
  const current = { ...legacy, deploymentEvidenceVersion: 3, dependencySha256: 'c'.repeat(64),
    restoreDependencySha256: 'c'.repeat(64), dependencyCount: 2, restoreDependencyCount: 2 };
  assert.equal(inspectDeploymentEvidence(current, { projectId: 'dalipu-demo', acceptanceVersion: 2 }).status, 'passed');
  assert.equal(inspectDeploymentEvidence({ ...current, restoreDependencySha256: 'd'.repeat(64) },
    { projectId: 'dalipu-demo', acceptanceVersion: 2 }).code, 'DEPLOYMENT_DEPENDENCY_MISMATCH');
  assert.equal(inspectDeploymentEvidence({ ...current, dependencyCount: undefined },
    { projectId: 'dalipu-demo', acceptanceVersion: 2 }).code, 'DEPLOYMENT_DEPENDENCY_INVALID');
  const final = finalizeComposeSmokeOutcome({ restoreRecord: current, cleanupErrors: ['image cleanup failed'] });
  assert.equal(final.status, 'failed');
  assert.equal(final.result.status, 'failed');
  assert.match(final.failure.message, /image cleanup failed/);
  assert.equal(finalizeComposeSmokeOutcome({ restoreRecord: current }).status, 'passed');
});

test('T37.2: legacy acceptance manifests cannot bypass an explicitly versioned deployment check', () => {
  const context = { projectId: 'dalipu-demo', acceptanceVersion: 1 };
  const historical = { status: 'passed', projectId: 'dalipu-demo', sha256: 'a'.repeat(64), restartSnapshotReused: true };
  assert.equal(inspectDeploymentEvidence(historical, context).status, 'passed');
  assert.equal(inspectDeploymentEvidence({ ...historical, deploymentEvidenceVersion: 9 }, context).code,
    'DEPLOYMENT_EVIDENCE_VERSION_UNSUPPORTED');
  const current = { ...historical, generationId: 'gen-one', pageCount: 1, deploymentEvidenceVersion: 3,
    backupSha256: 'b'.repeat(64), backupArchivePath: 'backup.tgz', restoreSnapshotReused: true,
    restoreMethod: 'empty-volume', restoreTargetEmptyBeforeCopy: true, restoreGenerationId: 'gen-one',
    restorePageCount: 1, restoreSha256: 'a'.repeat(64), dependencySha256: 'c'.repeat(64),
    restoreDependencySha256: 'd'.repeat(64), dependencyCount: 1, restoreDependencyCount: 1 };
  assert.equal(inspectDeploymentEvidence(current, context).code, 'DEPLOYMENT_DEPENDENCY_MISMATCH');
});

test('T38.3: Compose smoke and CI artifact upload use the T38 run directory', async () => {
  const workflow = await readFile(resolve('.github/workflows/ci.yml'), 'utf8');
  const smokeScript = await readFile(resolve('scripts/ci-compose-smoke.mjs'), 'utf8');
  const composeJob = workflow.split('\n  docker-compose-restart:')[1];
  assert.ok(composeJob, 'Docker Compose acceptance job must exist');
  assert.match(composeJob, /BRICKBILL_SMOKE_EXPECT_PDF:\s*['"]?1['"]?/);
  assert.match(smokeScript, /resolve\('output\/t38',\s*runId\)/);
  assert.match(composeJob, /name:\s*t38-compose-backup-restore-smoke/);
  assert.match(composeJob, /path:\s*output\/t38\//);
});

test('T39.1: required PDF verification fails instead of reporting runtime-dependent skips', () => {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', 'tests/pdf.test.mjs'], {
    cwd: resolve('.'), encoding: 'utf8', windowsHide: true,
    env: { ...childEnv, REPORTING_PDF_PYTHON: '', REPORTING_PDF_FALLBACK_FONT: '',
      BRICKBILL_REQUIRE_PDF_TESTS: '1' },
  });
  assert.notEqual(result.status, 0, 'required PDF verification must fail when its runtime is not configured');
  assert.match(`${result.stdout}\n${result.stderr}`, /PDF verification requires|PDF 验证要求/);
});

test('T39.4: PDF smoke evidence binds exact bytes across restart and empty-volume restore', () => {
  const pdfSha256 = 'd'.repeat(64);
  const restarted = { projectId: 'dalipu-demo', generationId: 'gen-pdf', pageCount: 2,
    sha256: 'a'.repeat(64), dependencySha256: 'b'.repeat(64), dependencyCount: 1,
    pdfAvailable: true, pdfSha256, pdfByteLength: 2048 };
  const afterRestart = structuredClone(restarted);
  const restartEvidence = createComposeSmokeResult(restarted, afterRestart, 'brickbill-smoke-source');
  assert.deepEqual({ pdfAvailable: restartEvidence.pdfAvailable, pdfSha256: restartEvidence.pdfSha256,
    pdfByteLength: restartEvidence.pdfByteLength }, { pdfAvailable: true, pdfSha256, pdfByteLength: 2048 });

  const restored = structuredClone(restarted);
  const evidence = createComposeRestoreResult(restarted, restored, {
    sourceProjectName: 'brickbill-smoke-source', restoreProjectName: 'brickbill-smoke-restore',
    backupSha256: 'c'.repeat(64), restoreTargetEmptyBeforeCopy: true,
  });
  assert.equal(evidence.deploymentEvidenceVersion, 4);
  assert.deepEqual({ pdfAvailable: evidence.pdfAvailable, pdfSha256: evidence.pdfSha256,
    pdfByteLength: evidence.pdfByteLength, restorePdfAvailable: evidence.restorePdfAvailable,
    restorePdfSha256: evidence.restorePdfSha256, restorePdfByteLength: evidence.restorePdfByteLength }, {
    pdfAvailable: true, pdfSha256, pdfByteLength: 2048,
    restorePdfAvailable: true, restorePdfSha256: pdfSha256, restorePdfByteLength: 2048,
  });
  assert.equal(inspectDeploymentEvidence(evidence, { projectId: 'dalipu-demo', acceptanceVersion: 2 }).status, 'passed');
  assert.equal(inspectDeploymentEvidence({ ...evidence, restorePdfSha256: 'e'.repeat(64) },
    { projectId: 'dalipu-demo', acceptanceVersion: 2 }).code, 'DEPLOYMENT_PDF_MISMATCH');
  assert.equal(inspectDeploymentEvidence({ ...evidence, restorePdfByteLength: 2047 },
    { projectId: 'dalipu-demo', acceptanceVersion: 2 }).code, 'DEPLOYMENT_PDF_MISMATCH');
  assert.throws(() => createComposeRestoreResult(restarted, { ...restored, pdfByteLength: 2047 }, {
    sourceProjectName: 'brickbill-smoke-source', restoreProjectName: 'brickbill-smoke-restore',
    backupSha256: 'c'.repeat(64), restoreTargetEmptyBeforeCopy: true,
  }), /PDF/);
});

test('T38.1: failed exclusive backups preserve prior archives and missing helper containers count as cleaned', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), `brickbill-t38-archive-${process.pid}-`));
  try {
    const existingPath = resolve(directory, 'existing.tgz');
    await writeFile(existingPath, 'keep these previous evidence bytes');
    const existingSink = createExclusiveArchiveSink(existingPath);
    await assert.rejects(pipeline(Readable.from([Buffer.from('replacement')]), existingSink.stream), /EEXIST/);
    await removePartialArchive(existingPath, existingSink.ownsFile());
    assert.equal((await readFile(existingPath, 'utf8')), 'keep these previous evidence bytes');

    const partialPath = resolve(directory, 'partial.tgz');
    const partialSink = createExclusiveArchiveSink(partialPath);
    await once(partialSink.stream, 'open');
    assert.equal(partialSink.ownsFile(), true);
    const closed = once(partialSink.stream, 'close');
    partialSink.stream.end('partial archive');
    await closed;
    await removePartialArchive(partialPath, partialSink.ownsFile());
    await assert.rejects(access(partialPath), { code: 'ENOENT' });

    assert.equal(isMissingDockerContainerError('Error: No such container: helper-1'), true);
    assert.equal(isMissingDockerContainerError('Cannot connect to the Docker daemon'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T38.2/T40.2: PDF smoke rejects invalid downloads and changes across reprint', async () => {
  const xlsx = Buffer.from('PK synthetic workbook');
  const generationRoot = '/api/projects/dalipu-demo/generations/generation-1';
  const generation = ({ pdfUrl = true } = {}) => ({ status: 'complete', pageCount: 1,
    ...(pdfUrl ? { pdfUrl: `${generationRoot}/file.pdf` } : {}),
    snapshot: { templateRef: { packageId: 'smoke-template', revision: 1 }, viewRefs: [], functionRefs: [],
      output: { sha256: createHash('sha256').update(xlsx).digest('hex') } } });

  async function invoke({ generationId = 'generation-1', pdfUrl = true, pdfStatus = 200,
    pdfBytes = Buffer.from('%PDF-1.7 smoke fixture'), pdfAfterReprintBytes, pdfAfterReprintStatus,
    expectPdf = true } = {}) {
    let reprinted = false, pdfBeforeReprint = 0, pdfAfterReprint = 0;
    const server = createHttpServer((request, response) => {
      const sendJson = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
      };
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      if (path === '/api/health') return sendJson(200, { status: 'ok' });
      if (path === '/api/projects') return sendJson(200, [{ projectId: 'dalipu-demo' }]);
      if (!generationId) return sendJson(404, { error: { code: 'NOT_FOUND' } });
      if (path === `${generationRoot}/file`) {
        response.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        return response.end(xlsx);
      }
      if (path === `${generationRoot}/reprint`) {
        reprinted = true; return sendJson(200, { reusedSnapshot: true });
      }
      if (path === `${generationRoot}/file.pdf`) {
        if (reprinted) pdfAfterReprint++; else pdfBeforeReprint++;
        response.writeHead(reprinted ? pdfAfterReprintStatus ?? pdfStatus : pdfStatus, { 'content-type': 'application/pdf' });
        return response.end(reprinted ? pdfAfterReprintBytes ?? pdfBytes : pdfBytes);
      }
      if (path === generationRoot) return sendJson(200, generation({ pdfUrl }));
      if (path === '/api/projects/dalipu-demo/templates/smoke-template/versions/1')
        return sendJson(200, { version: 1, value: { projectId: 'dalipu-demo', packageId: 'smoke-template', revision: 1,
          viewRefs: [], functionRefs: [], resources: [], pageDefinitions: [] } });
      return sendJson(404, { error: { code: 'NOT_FOUND' } });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const env = { ...process.env, BRICKBILL_SMOKE_URL: `http://127.0.0.1:${server.address().port}`,
        BRICKBILL_SMOKE_TOKEN: 'smoke-test-token', BRICKBILL_SMOKE_GENERATION_ID: generationId ?? '',
        BRICKBILL_SMOKE_REQUIRE_GENERATION: '1', BRICKBILL_SMOKE_EXPECT_PDF: expectPdf ? '1' : '' };
      try {
        const result = await execFileAsync(process.execPath, ['--experimental-strip-types', 'scripts/smoke-deployment.mjs'], {
          cwd: resolve('.'), encoding: 'utf8', timeout: 12_000, windowsHide: true, env,
          maxBuffer: 1024 * 1024,
        });
        return { status: 0, stdout: result.stdout, stderr: result.stderr, pdfBeforeReprint, pdfAfterReprint };
      } catch (error) {
        return { status: typeof error.code === 'number' ? error.code : null,
          stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }

  const passed = await invoke();
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.pdfBeforeReprint, 1, 'download the original PDF before calling reprint');
  assert.equal(passed.pdfAfterReprint, 1, 'download the PDF again after reprint');
  const noPdf = await invoke({ expectPdf: false, pdfUrl: false, pdfStatus: 503 });
  assert.equal(noPdf.status, 0, noPdf.stderr);
  assert.equal(noPdf.pdfBeforeReprint + noPdf.pdfAfterReprint, 0, 'XLSX-only smoke does not request PDF');
  for (const [scenario, pattern] of [
    [{ generationId: null }, /不能仅以健康检查标记通过/],
    [{ pdfUrl: false }, /PDF 项目开关或渲染环境未生效/],
    [{ pdfStatus: 503 }, /file\.pdf: HTTP 503/],
    [{ pdfBytes: Buffer.from('not-a-pdf') }, /PDF 文件签名错误/],
    [{ pdfAfterReprintBytes: Buffer.from('%PDF-1.7 changed bytes') }, /PDF.*重印|重印.*PDF/],
    [{ pdfAfterReprintBytes: Buffer.from('%PDF-1.7 different length fixture') }, /PDF.*重印|重印.*PDF/],
    [{ pdfAfterReprintStatus: 503 }, /file\.pdf: HTTP 503/],
  ]) {
    const result = await invoke(scenario);
    assert.notEqual(result.status, 0, 'required PDF acceptance must fail for the invalid scenario');
    assert.match(result.stderr, pattern);
  }
});

test('T35.2: volume backup commands read only the source and discover one project-owned volume', () => {
  assert.deepEqual(dockerVolumeLookupArguments('brickbill-smoke-abc'), [
    'volume', 'ls', '--quiet', '--filter', 'label=com.docker.compose.project=brickbill-smoke-abc',
    '--filter', 'label=com.docker.compose.volume=reporting-data',
  ]);
  assert.equal(parseDockerVolumeList('brickbill-smoke-abc_reporting-data\n'), 'brickbill-smoke-abc_reporting-data');
  assert.throws(() => parseDockerVolumeList('volume-a\nvolume-b\n'), /唯一/);
  assert.deepEqual(dockerTarBackupArguments('sha256:abc', 'brickbill-smoke-abc_reporting-data',
    'brickbill-smoke-test-run-backup', 'test-run'), [
    'run', '--rm', '--name', 'brickbill-smoke-test-run-backup', '--label', 'com.brickbill.smoke.run=test-run',
    '--volume', 'brickbill-smoke-abc_reporting-data:/source:ro', '--entrypoint', 'sh',
    'sha256:abc', '-c', 'tar -C /source -czf - .',
  ]);
  assert.deepEqual(dockerVolumeRemoveArguments('brickbill-smoke-restore', 'brickbill-smoke-restore_reporting-data'),
    ['volume', 'rm', 'brickbill-smoke-restore_reporting-data']);
  assert.throws(() => dockerVolumeRemoveArguments('brickbill-smoke-restore', 'other-project_data'), /只能清理/);
});

test('T35.3: an empty owned volume restore must reproduce the exact generation and carry versioned evidence', () => {
  assert.deepEqual(composeSmokeArguments('brickbill-restore-123', 'create', '--no-build'),
    ['compose', '--project-name', 'brickbill-restore-123', 'create', '--no-build']);
  const restarted = { projectId: 'dalipu-demo', generationId: 'gen-one', pageCount: 3, sha256: 'a'.repeat(64),
    dependencySha256: 'c'.repeat(64), dependencyCount: 2 };
  const restored = structuredClone(restarted);
  const evidence = createComposeRestoreResult(restarted, restored, {
    sourceProjectName: 'brickbill-smoke-source', restoreProjectName: 'brickbill-smoke-restore',
    backupSha256: 'c'.repeat(64), restoreTargetEmptyBeforeCopy: true,
  });
  assert.deepEqual(evidence, {
    deploymentEvidenceVersion: 3, status: 'passed', projectId: 'dalipu-demo', generationId: 'gen-one',
    pageCount: 3, sha256: 'a'.repeat(64), restartSnapshotReused: true, deploymentStage: 'restore',
    composeProjectName: 'brickbill-smoke-source', restoreSnapshotReused: true, restoreMethod: 'empty-volume',
    restoreTargetEmptyBeforeCopy: true, restoreGenerationId: 'gen-one', restorePageCount: 3,
    restoreSha256: 'a'.repeat(64), backupSha256: 'c'.repeat(64),
    dependencySha256: 'c'.repeat(64), restoreDependencySha256: 'c'.repeat(64),
    dependencyCount: 2, restoreDependencyCount: 2,
    backupArchivePath: 'reporting-data.tgz',
    restoreComposeProjectName: 'brickbill-smoke-restore',
  });
  assert.equal(inspectDeploymentEvidence(evidence, { projectId: 'dalipu-demo', acceptanceVersion: 2 }).status, 'passed');
  assert.throws(() => createComposeRestoreResult(restarted, { ...restored, sha256: 'b'.repeat(64) }, {
    sourceProjectName: 'brickbill-smoke-source', restoreProjectName: 'brickbill-smoke-restore',
    backupSha256: 'c'.repeat(64), restoreTargetEmptyBeforeCopy: true,
  }), /恢复后/);
  assert.throws(() => createComposeRestoreResult(restarted, restored, {
    sourceProjectName: 'brickbill-smoke-source', restoreProjectName: 'brickbill-smoke-restore',
    backupSha256: 'c'.repeat(64), restoreTargetEmptyBeforeCopy: false,
  }), /空卷/);
  assert.deepEqual(dockerTarRestoreArguments('sha256:abc', 'brickbill-smoke-restore_reporting-data',
    'brickbill-smoke-test-run-restore', 'test-run'), [
    'run', '--rm', '--interactive', '--name', 'brickbill-smoke-test-run-restore', '--label', 'com.brickbill.smoke.run=test-run',
    '--user', '0:0', '--volume', 'brickbill-smoke-restore_reporting-data:/target',
    '--entrypoint', 'sh', 'sha256:abc', '-c',
    'set -eu; target_entry=$(find /target -mindepth 1 -print -quit) || exit 71; test -z "$target_entry" || exit 72; echo EMPTY_TARGET_VERIFIED >&2; archive=$(mktemp); trap \'rm -f "$archive"\' EXIT; cat > "$archive"; tar -tzf "$archive" >/dev/null; tar -C /target -xzf "$archive"; chown -R 10001:10001 /target',
  ]);
});

test('T35.4: versioned restore evidence verifies backup bytes and rejects paths outside the evidence directory', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), `brickbill-t35-backup-${process.pid}-`));
  try {
    const archive = Buffer.from('synthetic archive bytes used only by this regression');
    await writeFile(resolve(directory, 'reporting-data.tgz'), archive);
    const evidence = { deploymentEvidenceVersion: 2, backupArchivePath: 'reporting-data.tgz',
      backupSha256: createHash('sha256').update(archive).digest('hex') };
    assert.deepEqual(await verifyDeploymentBackupEvidence(evidence, directory), { status: 'passed' });
    assert.equal((await verifyDeploymentBackupEvidence({ ...evidence, backupSha256: '0'.repeat(64) }, directory)).code,
      'DEPLOYMENT_BACKUP_HASH_MISMATCH');
    assert.equal((await verifyDeploymentBackupEvidence({ ...evidence, backupArchivePath: '../outside.tgz' }, directory)).code,
      'DEPLOYMENT_BACKUP_PATH_INVALID');
    assert.equal(inspectDeploymentEvidence({ status: 'passed', projectId: 'dalipu-demo', generationId: 'gen-one',
      pageCount: 1, sha256: 'a'.repeat(64), restartSnapshotReused: true, deploymentEvidenceVersion: 2 },
    { projectId: 'dalipu-demo', acceptanceVersion: 2 }).code, 'DEPLOYMENT_BACKUP_INVALID');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T33.3: stable token actor mappings validate against configured project tokens', () => {
  assert.deepEqual(parseTokenActorIds('{"qa-token":"employee-42"}', '{"qa-token":["dalipu-demo"]}'),
    { 'qa-token': 'employee-42' });
  assert.throws(() => parseTokenActorIds('{"unknown-token":"employee-42"}', '{"qa-token":["dalipu-demo"]}'), /必须同时配置/);
  assert.throws(() => parseTokenActorIds('{"qa-token":"  "}', '{"qa-token":["dalipu-demo"]}'), /稳定员工/);
  const settings = readServerSettings({ REPORTING_MODE: 'production', REPORTING_HOST: '127.0.0.1',
    REPORTING_DATA_DIR: resolve('test-data'), REPORTING_DEMO_PROJECTS: 'enabled',
    REPORTING_TOKENS_JSON: '{"qa-token":["dalipu-demo"]}',
    REPORTING_TOKEN_ACTORS_JSON: '{"qa-token":"employee-42"}' });
  assert.equal(settings.tokenActorsJson, '{"qa-token":"employee-42"}');
});

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

test('T33.4/T40.3: empty-directory restore reprints actual XLSX/PDF and rejects corrupted PDF sidecars', async () => {
  const pdfEnabled = !!(process.env.REPORTING_PDF_PYTHON && process.env.REPORTING_PDF_FALLBACK_FONT);
  if (process.env.BRICKBILL_REQUIRE_PDF_TESTS === '1') assert.ok(pdfEnabled, 'PDF restore verification requires its runtime');
  const directory = await mkdtemp(resolve(tmpdir(), `brickbill-t23-${process.pid}-`));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const restoredRoot = await mkdtemp(resolve(tmpdir(), 'brickbill-t33-restore-'));
  const restoredDirectory = resolve(restoredRoot, 'data');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const webProbe = createServer(); webProbe.listen(0, '127.0.0.1'); await once(webProbe, 'listening');
  const webPort = webProbe.address().port; await new Promise(resolve => webProbe.close(resolve));
  const environment = { ...process.env, REPORTING_MODE: 'production', REPORTING_HOST: '127.0.0.1',
    REPORTING_PORT: String(port), REPORTING_DATA_DIR: directory, REPORTING_DEMO_PROJECTS: 'enabled',
    REPORTING_PROJECTS_FILE: '', REPORTING_TOKENS_JSON: '{"test-token":["dalipu-demo"]}',
    REPORTING_PDF_ENABLED_PROJECTS: pdfEnabled ? 'dalipu-demo' : '' };
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
    const exited = waitForChildClose(child, { timeoutMs: 5_000, label: 'T40 restore API' });
    child.kill('SIGTERM'); await exited;
  }
  function smoke(extra) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/smoke-deployment.mjs'], {
      cwd: resolve('.'), encoding: 'utf8', timeout: 120_000, windowsHide: true,
      env: { ...environment, BRICKBILL_SMOKE_URL: `http://127.0.0.1:${port}`,
        BRICKBILL_SMOKE_TOKEN: 'test-token', BRICKBILL_SMOKE_REQUIRE_GENERATION: '1',
        BRICKBILL_SMOKE_EXPECT_PDF: pdfEnabled ? '1' : '', ...extra } });
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
    let originalPdf;
    if (pdfEnabled) {
      originalPdf = await new LocalSnapshotRepository(directory).readPdf('dalipu-demo', issued.generationId);
      assert.ok(originalPdf, 'the smoke must have rendered and cached a real PDF before backup');
      assert.equal(originalPdf.sha256, issued.pdfSha256);
      assert.equal(originalPdf.byteLength, issued.pdfByteLength);
      assert.equal(originalPdf.renderer.pageCount, issued.pageCount);
    }
    await stop(processHandle); processHandle = undefined;
    await assert.rejects(access(restoredDirectory), { code: 'ENOENT' }, 'restore starts with an absent destination');
    await cp(directory, restoredDirectory, { recursive: true, errorOnExist: true });
    environment.REPORTING_DATA_DIR = restoredDirectory;
    processHandle = await start();
    const reprinted = smoke({ BRICKBILL_SMOKE_GENERATION_ID: issued.generationId });
    assert.equal(reprinted.sha256, issued.sha256);
    assert.equal(reprinted.pageCount, issued.pageCount);
    assert.equal(reprinted.generationId, issued.generationId);
    if (pdfEnabled) {
      assert.equal(reprinted.pdfSha256, issued.pdfSha256);
      assert.equal(reprinted.pdfByteLength, issued.pdfByteLength);
      const restoredRepository = new LocalSnapshotRepository(restoredDirectory);
      const restoredPdf = await restoredRepository.readPdf('dalipu-demo', issued.generationId);
      assert.deepEqual(restoredPdf.bytes, originalPdf.bytes);
      const folder = restoredRepository.path('dalipu-demo', issued.generationId);
      const metadata = await readFile(resolve(folder, 'output.pdf.json'), 'utf8');
      const corrupted = Buffer.from(originalPdf.bytes); corrupted[corrupted.length - 1] ^= 1;
      for (const [bytes, meta] of [[corrupted, metadata], [originalPdf.bytes,
        JSON.stringify({ ...JSON.parse(metadata), byteLength: originalPdf.byteLength + 1 })]]) {
        await writeFile(resolve(folder, 'output.pdf'), bytes);
        await writeFile(resolve(folder, 'output.pdf.json'), meta);
        const response = await fetch(`http://127.0.0.1:${port}/api/projects/dalipu-demo/generations/${issued.generationId}/file.pdf`,
          { headers: { authorization: 'Bearer test-token' }, signal: AbortSignal.timeout(10_000) });
        assert.equal(response.status, 400, 'corrupted cached PDF must fail instead of being silently regenerated');
        assert.equal((await response.json()).error.code, 'CONTRACT_INVALID');
        assert.deepEqual(new Uint8Array(await readFile(resolve(folder, 'output.pdf'))), new Uint8Array(bytes));
        assert.equal(await readFile(resolve(folder, 'output.pdf.json'), 'utf8'), meta);
      }
    }
  } finally {
    if (webHandle && webHandle.exitCode === null) await stop(webHandle);
    if (processHandle && processHandle.exitCode === null) await stop(processHandle);
    await rm(directory, { recursive: true, force: true });
    await rm(restoredRoot, { recursive: true, force: true });
  }
});
