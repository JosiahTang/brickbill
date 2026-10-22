import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import {
  assertSmokeHelperContainerOwner, composeSmokeArguments, composeSmokeEnvironment, createComposeRestoreResult, createComposeSmokeResult,
  assertDockerCommandResult, finalizeComposeSmokeOutcome, persistComposeSmokeOutcome,
  dockerTarBackupArguments, dockerTarRestoreArguments, dockerVolumeRemoveArguments,
  dockerVolumeLookupArguments, parseComposePublishedUrl, parseDockerVolumeList, resolveComposeSmokeMode,
} from './compose-smoke-result.mjs';
import { runChildProcess, waitForChildClose } from './compose-smoke-process.mjs';
import { createExclusiveArchiveSink, removePartialArchive } from './compose-smoke-archive.mjs';

const root = resolve('.');
const token = process.env.BRICKBILL_SMOKE_TOKEN;
if (!token) throw new Error('BRICKBILL_SMOKE_TOKEN 未设置');
const runId = randomUUID();
const sourceProjectName = `brickbill-smoke-${runId}`;
const restoreProjectName = `brickbill-restore-${runId}`;
const backupHelperName = `brickbill-smoke-${runId}-backup`;
const restoreHelperName = `brickbill-smoke-${runId}-restore`;
const outputDirectory = resolve('output/t38', runId);
const smokeProjectId = process.env.BRICKBILL_SMOKE_PROJECT ?? 'dalipu-demo';
const requestedGenerationId = process.env.BRICKBILL_SMOKE_GENERATION_ID;
const createDemo = !requestedGenerationId && smokeProjectId === 'dalipu-demo'
  && process.env.BRICKBILL_SMOKE_CREATE_DEMO === '1';
resolveComposeSmokeMode({ projectId: smokeProjectId, generationId: requestedGenerationId, createDemo });

const sourceEnvironment = { ...process.env, ...composeSmokeEnvironment(sourceProjectName) };
const restoreEnvironment = { ...sourceEnvironment, ...composeSmokeEnvironment(restoreProjectName),
  BRICKBILL_API_IMAGE: sourceEnvironment.BRICKBILL_API_IMAGE,
  BRICKBILL_WEB_IMAGE: sourceEnvironment.BRICKBILL_WEB_IMAGE };
const compose = (projectName, ...args) => composeSmokeArguments(projectName, ...args);

function run(command, args, env = process.env, timeoutMs = 300_000) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  return runChildProcess(child, { timeoutMs, label: `${command} ${args[0] ?? ''}`, command, args });
}

function capture(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 300_000, windowsHide: true });
  if (result.error || result.status !== 0)
    throw new Error(result.stderr?.trim() || result.error?.message || `${command} ${args.join(' ')} exited ${result.status ?? 'unknown'}`);
  return result.stdout.trim();
}

function serviceUrl(projectName, environment) {
  return parseComposePublishedUrl(capture('docker', compose(projectName, 'port', 'report-designer', '80'), environment));
}

function readSmoke(baseUrl, extra) {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/smoke-deployment.mjs'], {
    cwd: root, env: { ...process.env, BRICKBILL_SMOKE_URL: baseUrl, BRICKBILL_SMOKE_TOKEN: token,
      BRICKBILL_SMOKE_REQUIRE_GENERATION: '1', ...extra },
    encoding: 'utf8', timeout: 120_000, windowsHide: true,
  });
  if (child.error)
    throw new Error(`部署烟测进程执行失败 ${child.error.code ?? ''}: ${child.error.message}`, { cause: child.error });
  const stdout = String(child.stdout ?? '').trim();
  const stderr = String(child.stderr ?? '').trim();
  if (child.status !== 0)
    throw new Error(`部署烟测进程退出 ${child.status ?? child.signal ?? 'unknown'}: ${stderr || stdout || '无输出'}`);
  if (!stdout) throw new Error('部署烟测未返回 JSON 结果');
  try { return JSON.parse(stdout.split(/\r?\n/).at(-1)); }
  catch (error) { throw new Error(`部署烟测返回无效 JSON 结果: ${error.message}`, { cause: error }); }
}

function digestArchive(image, sourceVolume, archivePath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', dockerTarBackupArguments(image, sourceVolume, backupHelperName, runId), { cwd: root, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    const digest = createHash('sha256');
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    const meter = new Transform({ transform(chunk, encoding, callback) {
      digest.update(chunk); callback(null, chunk);
    } });
    const archiveSink = createExclusiveArchiveSink(archivePath);
    const streamResult = pipeline(child.stdout, meter, archiveSink.stream);
    const exitResult = waitForChildClose(child, { timeoutMs: 300_000, label: '数据卷备份' });
    Promise.all([streamResult, exitResult]).then(async ([, code]) => {
      if (code !== 0) throw new Error(stderr.trim() || `数据卷备份退出 ${code ?? 'unknown'}`);
      resolvePromise(digest.digest('hex'));
    }).catch(async error => {
      try { child.kill('SIGTERM'); } catch { /* Preserve the backup failure. */ }
      try {
        await removePartialArchive(archivePath, archiveSink.ownsFile());
        reject(error);
      } catch (cleanupError) {
        reject(new Error(`${error.message}; 清理本次部分归档失败：${cleanupError.message}`, { cause: error }));
      }
    });
  });
}

async function restoreArchive(image, targetVolume, archivePath) {
  const child = spawn('docker', dockerTarRestoreArguments(image, targetVolume, restoreHelperName, runId), { cwd: root, windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  const transfer = pipeline(createReadStream(archivePath), child.stdin);
  transfer.catch(() => child.kill('SIGTERM'));
  const exit = waitForChildClose(child, { timeoutMs: 300_000, label: '空卷恢复' });
  const [code] = await Promise.all([exit, transfer]);
  if (code !== 0) throw new Error(stderr.trim() || `空卷恢复退出 ${code ?? 'unknown'}`);
  if (!stderr.includes('EMPTY_TARGET_VERIFIED')) throw new Error('恢复命令未确认目标卷在复制前为空');
  return true;
}

function oneLine(value, description) {
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`${description} 必须唯一`);
  return lines[0];
}

async function captureLogs(projectName, environment, filename) {
  const result = spawnSync('docker', compose(projectName, 'logs', '--no-color'), { cwd: root, env: environment,
    encoding: 'utf8', timeout: 60_000, windowsHide: true });
  await writeFile(resolve(outputDirectory, filename), `${result.stdout ?? ''}\n${result.stderr ?? result.error?.message ?? ''}`, 'utf8');
  if (result.error || result.status !== 0)
    throw new Error(`收集 Compose 项目 ${projectName} 日志失败：${result.error?.message ?? result.stderr ?? result.status}`);
}

function cleanupHelperContainer(name) {
  const inspected = spawnSync('docker', ['container', 'inspect', name], {
    cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  if (!assertDockerCommandResult(inspected, `检查辅助容器 ${name}`, 'container')) return;
  const container = JSON.parse(inspected.stdout)[0];
  assertSmokeHelperContainerOwner(container, runId);
  const removed = spawnSync('docker', ['container', 'rm', '--force', name], {
    cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  assertDockerCommandResult(removed, `清理辅助容器 ${name}`, 'container');
}

await mkdir(outputDirectory, { recursive: true });
const archivePath = resolve(outputDirectory, 'reporting-data.tgz');
let primaryError;
let restartRecord;
let restoreRecord;
let restoreVolumeName;
const cleanupErrors = [];
try {
  await run('docker', compose(sourceProjectName, 'up', '--build', '--detach', '--wait', '--wait-timeout', '300'), sourceEnvironment, 900_000);
  const sourceUrl = serviceUrl(sourceProjectName, sourceEnvironment);
  const first = readSmoke(sourceUrl, {
    BRICKBILL_SMOKE_PROJECT: smokeProjectId,
    BRICKBILL_SMOKE_CREATE_DEMO: createDemo ? '1' : '0',
    ...(requestedGenerationId ? { BRICKBILL_SMOKE_GENERATION_ID: requestedGenerationId } : {}),
  });
  if (!first.generationId || !/^[0-9a-f]{64}$/i.test(first.sha256)) throw new Error('部署烟测没有返回完整生成快照');
  await writeFile(resolve(outputDirectory, 'compose-before-restart.json'), `${JSON.stringify(first, null, 2)}\n`);

  await run('docker', compose(sourceProjectName, 'restart', 'reporting-api'), sourceEnvironment, 120_000);
  await run('docker', compose(sourceProjectName, 'up', '--detach', '--wait', '--wait-timeout', '120'), sourceEnvironment, 150_000);
  const after = readSmoke(serviceUrl(sourceProjectName, sourceEnvironment), {
    BRICKBILL_SMOKE_GENERATION_ID: first.generationId, BRICKBILL_SMOKE_PROJECT: first.projectId,
    BRICKBILL_SMOKE_CREATE_DEMO: '0',
  });
  restartRecord = createComposeSmokeResult(first, after, sourceProjectName);
  await writeFile(resolve(outputDirectory, 'compose-after-restart.json'), `${JSON.stringify(after, null, 2)}\n`);

  await run('docker', compose(sourceProjectName, 'stop', 'report-designer', 'reporting-api'), sourceEnvironment, 120_000);
  const sourceVolume = parseDockerVolumeList(capture('docker', dockerVolumeLookupArguments(sourceProjectName)));
  const apiImage = oneLine(capture('docker', compose(sourceProjectName, 'images', '--quiet', 'reporting-api'), sourceEnvironment), '后台镜像');
  const backupSha256 = await digestArchive(apiImage, sourceVolume, archivePath);
  await writeFile(resolve(outputDirectory, 'backup-evidence.json'), `${JSON.stringify({
    backupEvidenceVersion: 1, status: 'passed', sourceProjectName, sourceVolume,
    archive: 'reporting-data.tgz', sha256: backupSha256,
  }, null, 2)}\n`);

  await run('docker', compose(restoreProjectName, 'create', '--no-build'), restoreEnvironment, 60_000);
  restoreVolumeName = parseDockerVolumeList(capture('docker', dockerVolumeLookupArguments(restoreProjectName)));
  if (restoreVolumeName !== `${restoreProjectName}_reporting-data`)
    throw new Error('Compose 没有为恢复实例创建预期的数据卷');
  const volumeInfo = JSON.parse(capture('docker', ['volume', 'inspect', restoreVolumeName]));
  const labels = volumeInfo[0]?.Labels ?? {};
  if (labels['com.docker.compose.project'] !== restoreProjectName
    || labels['com.docker.compose.volume'] !== 'reporting-data')
    throw new Error('恢复卷所有权标签与本次 Compose 项目不匹配');
  await restoreArchive(apiImage, restoreVolumeName, archivePath);

  await run('docker', compose(restoreProjectName, 'up', '--no-build', '--detach', '--wait', '--wait-timeout', '300'), restoreEnvironment, 360_000);
  const restoreUrl = serviceUrl(restoreProjectName, restoreEnvironment);
  const restored = readSmoke(restoreUrl, {
    BRICKBILL_SMOKE_GENERATION_ID: first.generationId, BRICKBILL_SMOKE_PROJECT: first.projectId,
    BRICKBILL_SMOKE_CREATE_DEMO: '0',
  });
  restoreRecord = createComposeRestoreResult(restartRecord, restored, {
    sourceProjectName, restoreProjectName, backupSha256, restoreTargetEmptyBeforeCopy: true,
  });
  await writeFile(resolve(outputDirectory, 'compose-after-restore.json'), `${JSON.stringify(restored, null, 2)}\n`);
} catch (error) {
  primaryError = error;
} finally {
  for (const helperName of [restoreHelperName, backupHelperName]) {
    try { cleanupHelperContainer(helperName); }
    catch (error) { cleanupErrors.push(`helper container cleanup ${helperName}: ${error.message}`); }
  }
  await captureLogs(restoreProjectName, restoreEnvironment, 'restore-compose.log').catch(error => {
    cleanupErrors.push(`restore logs: ${error.message}`);
  });
  await captureLogs(sourceProjectName, sourceEnvironment, 'compose.log').catch(error => {
    cleanupErrors.push(`source logs: ${error.message}`);
  });
  for (const [projectName, environment] of [[restoreProjectName, restoreEnvironment], [sourceProjectName, sourceEnvironment]]) {
    const down = spawnSync('docker', compose(projectName, 'down', '--volumes', '--remove-orphans'), {
      cwd: root, env: environment, stdio: 'inherit', timeout: 120_000, windowsHide: true,
    });
    if (down.error || down.status !== 0)
      cleanupErrors.push(`compose down ${projectName}: ${down.error?.message ?? down.status}`);
  }
  if (restoreVolumeName) {
    try {
      const inspected = spawnSync('docker', ['volume', 'inspect', restoreVolumeName], {
        cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      });
      if (assertDockerCommandResult(inspected, `检查恢复卷 ${restoreVolumeName}`, 'volume')) {
        const info = JSON.parse(inspected.stdout)[0];
        if (info?.Labels?.['com.docker.compose.project'] !== restoreProjectName
          || info?.Labels?.['com.docker.compose.volume'] !== 'reporting-data')
          throw new Error('恢复卷所有权标签与本次 Compose 项目不匹配');
        const removed = spawnSync('docker', dockerVolumeRemoveArguments(restoreProjectName, restoreVolumeName), {
          cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true,
        });
        assertDockerCommandResult(removed, `清理恢复卷 ${restoreVolumeName}`, 'volume');
      }
    } catch (error) { cleanupErrors.push(`restore volume cleanup: ${error.message}`); }
  }
  for (const image of [sourceEnvironment.BRICKBILL_API_IMAGE, sourceEnvironment.BRICKBILL_WEB_IMAGE]) {
    try {
      const inspected = spawnSync('docker', ['image', 'inspect', image], {
        cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      });
      if (!assertDockerCommandResult(inspected, `检查镜像 ${image}`, 'image')) continue;
      const removed = spawnSync('docker', ['image', 'rm', image], {
        cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      });
      assertDockerCommandResult(removed, `清理镜像 ${image}`, 'image');
    } catch (error) { cleanupErrors.push(`image cleanup ${image}: ${error.message}`); }
  }
}
const outcome = finalizeComposeSmokeOutcome({ restoreRecord, primaryError, cleanupErrors });
await persistComposeSmokeOutcome({ outcome, outputDirectory, sourceProjectName, restoreProjectName });
if (outcome.status === 'passed') {
  process.stdout.write(`Docker Compose backup and empty-volume restore passed: ${outcome.result.pageCount} page(s), SHA-256 ${outcome.result.sha256}\n`);
} else {
  throw new Error(outcome.failure.message);
}
