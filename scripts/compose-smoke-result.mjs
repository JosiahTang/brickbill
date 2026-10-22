import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sha256Pattern = /^[0-9a-f]{64}$/i;
const namePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

function requireProjectName(projectName) {
  if (typeof projectName !== 'string' || !namePattern.test(projectName))
    throw new Error('Compose 烟测项目名不符合命名约束');
}

function requireVolumeName(volumeName) {
  if (typeof volumeName !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(volumeName))
    throw new Error('Docker 数据卷名不符合命名约束');
}

export function composeSmokeEnvironment(projectName) {
  const result = { BRICKBILL_BIND: '127.0.0.1', BRICKBILL_PORT: '' };
  if (projectName) {
    requireProjectName(projectName);
    result.BRICKBILL_API_IMAGE = `brickbill-smoke-${projectName}-api:local`;
    result.BRICKBILL_WEB_IMAGE = `brickbill-smoke-${projectName}-web:local`;
  }
  return result;
}

export function composeSmokeArguments(composeProjectName, ...args) {
  requireProjectName(composeProjectName);
  return ['compose', '--project-name', composeProjectName, ...args];
}

export function parseComposePublishedUrl(output) {
  const lines = typeof output === 'string' ? output.trim().split(/\r?\n/).filter(Boolean) : [];
  if (lines.length !== 1) throw new Error('Compose 烟测必须解析到唯一的本地服务地址');
  const match = /^([^:]+):([^:]+)$/.exec(lines[0].trim());
  if (!match) throw new Error('Compose 烟测地址格式无效');
  if (match[1] !== '127.0.0.1') throw new Error('Compose 烟测仅允许本机地址');
  if (!/^\d+$/.test(match[2])) throw new Error('Compose 烟测地址端口无效');
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Compose 烟测地址端口无效');
  return `http://${match[1]}:${port}`;
}

export function dockerVolumeLookupArguments(projectName) {
  requireProjectName(projectName);
  return ['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${projectName}`,
    '--filter', 'label=com.docker.compose.volume=reporting-data'];
}

export function parseDockerVolumeList(output) {
  const volumes = typeof output === 'string' ? output.trim().split(/\r?\n/).filter(Boolean) : [];
  if (volumes.length !== 1 || !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(volumes[0] ?? ''))
    throw new Error('必须找到本次烟测唯一拥有的数据卷');
  return volumes[0];
}

export function requireSmokeGenerationId(generationId, required) {
  if (required && (typeof generationId !== 'string' || !generationId.trim()))
    throw new Error('部署烟测必须指定或创建 generationId，不能仅以健康检查标记通过');
}

export function resolveComposeSmokeMode({ projectId, generationId, createDemo = false }) {
  if (generationId) throw new Error('Compose 隔离烟测使用独立数据卷，不能读取已有 generationId；请对已部署服务运行 smoke:deployment');
  if (projectId !== 'dalipu-demo') throw new Error('Compose 自动生成合成记录仅支持 dalipu-demo');
  if (createDemo !== true) throw new Error('Compose 烟测必须显式启用合成数据');
  return { mode: 'synthetic-demo' };
}

export function dockerVolumeRemoveArguments(projectName, volumeName) {
  requireProjectName(projectName);
  requireVolumeName(volumeName);
  if (!volumeName.startsWith(`${projectName}_`)) throw new Error('只能清理本次烟测项目拥有的数据卷');
  return ['volume', 'rm', volumeName];
}

function requireHelperContainer(name, runId) {
  requireVolumeName(name);
  if (typeof runId !== 'string' || !/^[a-z0-9-]{8,64}$/i.test(runId)
    || !name.startsWith(`brickbill-smoke-${runId}-`))
    throw new Error('Docker 辅助容器必须绑定本次唯一烟测运行标识');
}

export function assertSmokeHelperContainerOwner(container, runId) {
  if (!container || typeof container !== 'object'
    || container.Config?.Labels?.['com.brickbill.smoke.run'] !== runId)
    throw new Error('辅助容器的运行所有权标签不匹配');
}

export function isMissingDockerContainerError(message) {
  return isMissingDockerResourceError(message, 'container');
}

export function isMissingDockerResourceError(message, resource) {
  if (typeof message !== 'string') return false;
  const diagnostic = message.trim().replace(/^Error(?: response from daemon)?:\s*/i, '');
  if (resource === 'container') return /^no such (?:object|container):\s*\S+$/i.test(diagnostic);
  if (resource === 'image') return /^no such image:\s*\S+$/i.test(diagnostic);
  if (resource === 'volume') return /^(?:no such volume:\s*\S+|get\s+\S+:\s*no such volume)$/i.test(diagnostic);
  return false;
}

export function assertDockerCommandResult(result, operation, missingResource) {
  if (result?.error) throw new Error(`${operation}: ${result.error.message}`, { cause: result.error });
  if (result?.status === 0) return true;
  const stderr = String(result?.stderr ?? '').trim();
  const stdout = String(result?.stdout ?? '').trim();
  const output = `${stderr}\n${stdout}`.trim();
  if (result?.status === 1 && missingResource && (!stdout || stdout === '[]')
    && isMissingDockerResourceError(stderr, missingResource)) return false;
  throw new Error(`${operation}: ${output || `Docker 命令退出 ${result?.status ?? 'unknown'}`}`);
}

export function dockerTarBackupArguments(image, sourceVolume, helperName, runId) {
  if (typeof image !== 'string' || !image.trim()) throw new Error('备份镜像标识不能为空');
  requireVolumeName(sourceVolume);
  requireHelperContainer(helperName, runId);
  return ['run', '--rm', '--name', helperName, '--label', `com.brickbill.smoke.run=${runId}`,
    '--volume', `${sourceVolume}:/source:ro`, '--entrypoint', 'sh', image,
    '-c', 'tar -C /source -czf - .'];
}

export function dockerTarRestoreArguments(image, targetVolume, helperName, runId) {
  if (typeof image !== 'string' || !image.trim()) throw new Error('恢复镜像标识不能为空');
  requireVolumeName(targetVolume);
  requireHelperContainer(helperName, runId);
  return ['run', '--rm', '--interactive', '--name', helperName, '--label', `com.brickbill.smoke.run=${runId}`,
    '--user', '0:0', '--volume', `${targetVolume}:/target`, '--entrypoint', 'sh', image,
    '-c', 'set -eu; target_entry=$(find /target -mindepth 1 -print -quit) || exit 71; test -z "$target_entry" || exit 72; echo EMPTY_TARGET_VERIFIED >&2; archive=$(mktemp); trap \'rm -f "$archive"\' EXIT; cat > "$archive"; tar -tzf "$archive" >/dev/null; tar -C /target -xzf "$archive"; chown -R 10001:10001 /target'];
}

export function createComposeSmokeResult(first, after, composeProjectName) {
  if (typeof composeProjectName !== 'string' || !composeProjectName.trim())
    throw new Error('Compose 项目名必须是非空字符串');
  if (!first || typeof first !== 'object' || !after || typeof after !== 'object')
    throw new Error('烟测生成记录必须是对象');
  if (!sha256Pattern.test(first.sha256 ?? '') || !sha256Pattern.test(after.sha256 ?? ''))
    throw new Error('烟测结果必须包含有效的 SHA-256');
  const firstPdfAvailable = first.pdfAvailable === true;
  const afterPdfAvailable = after.pdfAvailable === true;
  if (firstPdfAvailable !== afterPdfAvailable || (firstPdfAvailable
    && (!sha256Pattern.test(first.pdfSha256 ?? '') || !sha256Pattern.test(after.pdfSha256 ?? '')
      || first.pdfSha256.toLowerCase() !== after.pdfSha256.toLowerCase()
      || !Number.isInteger(first.pdfByteLength) || first.pdfByteLength < 1
      || first.pdfByteLength !== after.pdfByteLength)))
    throw new Error('烟测 PDF 在服务重启后不可用或文件摘要/字节数不一致');
  if (first.projectId !== after.projectId || first.generationId !== after.generationId
    || first.pageCount !== after.pageCount || first.sha256 !== after.sha256
    || !sha256Pattern.test(first.dependencySha256 ?? '') || first.dependencySha256 !== after.dependencySha256
    || !Number.isInteger(first.dependencyCount) || first.dependencyCount !== after.dependencyCount)
    throw new Error('烟测项目、生成记录、页数或文件哈希在服务重启后不一致');
  return {
    status: 'passed', projectId: first.projectId, generationId: first.generationId,
    pageCount: first.pageCount, sha256: first.sha256, dependencySha256: first.dependencySha256,
    dependencyCount: first.dependencyCount, restartSnapshotReused: true,
    deploymentStage: 'restart', composeProjectName,
    ...(firstPdfAvailable ? { pdfAvailable: true, pdfSha256: first.pdfSha256.toLowerCase(), pdfByteLength: first.pdfByteLength } : {}),
  };
}

export function createComposeRestoreResult(restarted, restored, {
  sourceProjectName, restoreProjectName, backupSha256, backupArchivePath = 'reporting-data.tgz',
  restoreTargetEmptyBeforeCopy,
}) {
  requireProjectName(sourceProjectName);
  requireProjectName(restoreProjectName);
  if (sourceProjectName === restoreProjectName) throw new Error('恢复实例必须使用独立 Compose 项目名');
  if (!sha256Pattern.test(backupSha256 ?? '')) throw new Error('备份归档必须记录有效 SHA-256');
  if (typeof backupArchivePath !== 'string' || !backupArchivePath.trim() || backupArchivePath.includes('..')
    || backupArchivePath.startsWith('/') || backupArchivePath.includes('\\'))
    throw new Error('备份归档必须是证据目录内的相对路径');
  if (restoreTargetEmptyBeforeCopy !== true) throw new Error('恢复目标必须在复制前确认为空卷');
  if (!restarted || !restored || typeof restarted !== 'object' || typeof restored !== 'object')
    throw new Error('重启及恢复烟测结果必须是对象');
  const pdfAvailable = restarted.pdfAvailable === true || restored.pdfAvailable === true;
  if (pdfAvailable && (restarted.pdfAvailable !== true || restored.pdfAvailable !== true
    || !sha256Pattern.test(restarted.pdfSha256 ?? '') || !sha256Pattern.test(restored.pdfSha256 ?? '')
    || restarted.pdfSha256.toLowerCase() !== restored.pdfSha256.toLowerCase()
    || !Number.isInteger(restarted.pdfByteLength) || restarted.pdfByteLength < 1
    || restarted.pdfByteLength !== restored.pdfByteLength))
    throw new Error('空卷恢复后的 PDF 不可用或文件摘要/字节数不一致');
  if (restarted.projectId !== restored.projectId || restarted.generationId !== restored.generationId
    || restarted.pageCount !== restored.pageCount || restarted.sha256 !== restored.sha256
    || !sha256Pattern.test(restarted.dependencySha256 ?? '')
    || restarted.dependencySha256 !== restored.dependencySha256
    || !Number.isInteger(restarted.dependencyCount) || restarted.dependencyCount !== restored.dependencyCount
    || !sha256Pattern.test(restarted.sha256 ?? '') || !restarted.generationId
    || !Number.isInteger(restarted.pageCount) || restarted.pageCount < 1)
    throw new Error('空卷恢复后项目、生成记录、页数或文件 SHA-256 与重启快照不一致');
  return {
    deploymentEvidenceVersion: pdfAvailable ? 4 : 3, status: 'passed', projectId: restarted.projectId,
    generationId: restarted.generationId, pageCount: restarted.pageCount, sha256: restarted.sha256,
    restartSnapshotReused: true, deploymentStage: 'restore', composeProjectName: sourceProjectName,
    restoreSnapshotReused: true, restoreMethod: 'empty-volume', restoreTargetEmptyBeforeCopy: true,
    restoreGenerationId: restored.generationId, restorePageCount: restored.pageCount,
    restoreSha256: restored.sha256, dependencySha256: restarted.dependencySha256,
    restoreDependencySha256: restored.dependencySha256, dependencyCount: restarted.dependencyCount,
    restoreDependencyCount: restored.dependencyCount, backupSha256: backupSha256.toLowerCase(),
    backupArchivePath,
    restoreComposeProjectName: restoreProjectName,
    ...(pdfAvailable ? { pdfAvailable: true, pdfSha256: restarted.pdfSha256.toLowerCase(),
      pdfByteLength: restarted.pdfByteLength, restorePdfAvailable: true,
      restorePdfSha256: restored.pdfSha256.toLowerCase(), restorePdfByteLength: restored.pdfByteLength } : {}),
  };
}

export function finalizeComposeSmokeOutcome({ restoreRecord, primaryError, cleanupErrors = [] }) {
  const cleanup = Array.isArray(cleanupErrors) ? cleanupErrors.map(String) : ['清理错误列表无效'];
  if (restoreRecord && !primaryError && cleanup.length === 0)
    return { status: 'passed', result: restoreRecord };
  const primaryFailure = primaryError instanceof Error ? primaryError.message
    : primaryError === undefined || primaryError === null ? undefined : String(primaryError);
  const message = [primaryFailure, ...cleanup].filter(Boolean).join('; ') || 'Compose 烟测未生成完整恢复记录';
  const code = cleanup.length ? 'COMPOSE_SMOKE_CLEANUP_FAILED' : 'COMPOSE_SMOKE_FAILED';
  return {
    status: 'failed',
    ...(restoreRecord ? { result: { ...restoreRecord, status: 'failed', code, message } } : {}),
    failure: { deploymentEvidenceVersion: 3, status: 'failed', code,
      ...(primaryFailure ? { primaryFailure } : {}), message, cleanupErrors: cleanup },
  };
}

export async function persistComposeSmokeOutcome({ outcome, outputDirectory, sourceProjectName, restoreProjectName }) {
  if (!outcome || !['passed', 'failed'].includes(outcome.status))
    throw new Error('Compose 烟测结果状态无效');
  if (outcome.status === 'passed') {
    await writeFile(resolve(outputDirectory, 'compose-smoke-result.json'), `${JSON.stringify(outcome.result, null, 2)}\n`);
    return;
  }
  if (outcome.result)
    await writeFile(resolve(outputDirectory, 'compose-smoke-result.json'), `${JSON.stringify(outcome.result, null, 2)}\n`);
  await writeFile(resolve(outputDirectory, 'compose-failure.json'), `${JSON.stringify({
    ...outcome.failure, sourceProjectName, restoreProjectName,
  }, null, 2)}\n`);
}
