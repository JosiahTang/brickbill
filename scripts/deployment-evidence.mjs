import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const sha256Pattern = /^[0-9a-f]{64}$/i;

export function inspectDeploymentEvidence(value, { projectId, acceptanceVersion }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.status !== 'passed' || value.projectId !== projectId
    || !sha256Pattern.test(value.sha256 ?? '') || value.restartSnapshotReused !== true)
    return { status: 'failed', code: 'DEPLOYMENT_RESTART_FAILED',
      message: '服务重启后快照、页数、项目或文件哈希不一致' };
  if (value.deploymentEvidenceVersion !== undefined && ![2, 3, 4].includes(value.deploymentEvidenceVersion))
    return { status: 'failed', code: 'DEPLOYMENT_EVIDENCE_VERSION_UNSUPPORTED',
      message: '不支持该部署证据版本' };
  // Keep the historical v1 shape readable, but never let it bypass a declared evidence contract.
  if (acceptanceVersion === 1 && value.deploymentEvidenceVersion === undefined) return { status: 'passed' };
  if ([2, 3, 4].includes(value.deploymentEvidenceVersion)
    && (!sha256Pattern.test(value.backupSha256 ?? '')
      || typeof value.backupArchivePath !== 'string' || !value.backupArchivePath.trim()))
    return { status: 'failed', code: 'DEPLOYMENT_BACKUP_INVALID',
      message: '版本 2 部署证据必须引用备份归档及其 SHA-256' };
  if (typeof value.generationId !== 'string' || !value.generationId.trim()
    || !Number.isInteger(value.pageCount) || value.pageCount < 1)
    return { status: 'failed', code: 'DEPLOYMENT_RESTART_FAILED', message: '版本 2 烟测必须固定生成记录和页数' };

  const requiredRestoreFields = ['restoreSnapshotReused', 'restoreMethod', 'restoreTargetEmptyBeforeCopy',
    'restoreGenerationId', 'restorePageCount', 'restoreSha256'];
  if (requiredRestoreFields.some(field => value[field] === undefined || value[field] === null))
    return { status: 'pending', message: '只有服务重启烟测；等待独立空目录或空卷的恢复记录' };
  if ([3, 4].includes(value.deploymentEvidenceVersion)
    && (!Number.isInteger(value.dependencyCount) || value.dependencyCount < 0
      || !Number.isInteger(value.restoreDependencyCount) || value.restoreDependencyCount < 0
      || value.restoreDependencyCount !== value.dependencyCount))
    return { status: 'failed', code: 'DEPLOYMENT_DEPENDENCY_INVALID', message: '版本 3 部署证据缺少有效依赖数量' };
  if ([3, 4].includes(value.deploymentEvidenceVersion)
    && (!sha256Pattern.test(value.dependencySha256 ?? '')
      || !sha256Pattern.test(value.restoreDependencySha256 ?? '')
      || value.dependencySha256.toLowerCase() !== value.restoreDependencySha256.toLowerCase()))
    return { status: 'failed', code: 'DEPLOYMENT_DEPENDENCY_MISMATCH',
      message: '版本 3/4 部署证据必须证明模板、视图、函数和资源在独立恢复后保持一致' };
  if (value.deploymentEvidenceVersion === 4
    && (value.pdfAvailable !== true || value.restorePdfAvailable !== true
      || !sha256Pattern.test(value.pdfSha256 ?? '') || !sha256Pattern.test(value.restorePdfSha256 ?? '')
      || !Number.isInteger(value.pdfByteLength) || value.pdfByteLength < 1
      || !Number.isInteger(value.restorePdfByteLength) || value.restorePdfByteLength < 1))
    return { status: 'failed', code: 'DEPLOYMENT_PDF_INVALID',
      message: '版本 4 部署证据必须包含重启与恢复后的 PDF 摘要及字节数' };
  if (value.deploymentEvidenceVersion === 4
    && (value.pdfSha256.toLowerCase() !== value.restorePdfSha256.toLowerCase()
      || value.pdfByteLength !== value.restorePdfByteLength))
    return { status: 'failed', code: 'DEPLOYMENT_PDF_MISMATCH',
      message: '重启与空卷恢复后的 PDF 文件摘要和字节数必须一致' };
  if (value.restoreSnapshotReused !== true
    || !['empty-directory', 'empty-volume'].includes(value.restoreMethod)
    || value.restoreTargetEmptyBeforeCopy !== true
    || value.restoreGenerationId !== value.generationId
    || value.restorePageCount !== value.pageCount
    || !sha256Pattern.test(value.restoreSha256 ?? '')
    || value.restoreSha256.toLowerCase() !== value.sha256.toLowerCase())
    return { status: 'failed', code: 'DEPLOYMENT_RESTORE_MISMATCH',
      message: '独立恢复必须从空目标恢复相同生成记录，且页数和 SHA-256 必须一致' };
  return { status: 'passed' };
}

export async function verifyDeploymentBackupEvidence(value, evidenceDirectory) {
  if (!value || ![2, 3, 4].includes(value.deploymentEvidenceVersion)) return { status: 'passed' };
  if (typeof evidenceDirectory !== 'string' || !evidenceDirectory.trim()
    || typeof value.backupArchivePath !== 'string' || !value.backupArchivePath.trim()
    || isAbsolute(value.backupArchivePath))
    return { status: 'failed', code: 'DEPLOYMENT_BACKUP_PATH_INVALID', message: '备份归档必须使用相对路径' };
  try {
    const root = await realpath(evidenceDirectory);
    const candidate = resolve(root, value.backupArchivePath);
    const candidateRelative = relative(root, candidate);
    if (candidateRelative === '..' || candidateRelative.startsWith(`..${sep}`) || isAbsolute(candidateRelative))
      return { status: 'failed', code: 'DEPLOYMENT_BACKUP_PATH_INVALID', message: '备份归档路径不能离开证据目录' };
    const archive = await realpath(candidate);
    const archiveRelative = relative(root, archive);
    if (archiveRelative === '..' || archiveRelative.startsWith(`..${sep}`) || isAbsolute(archiveRelative))
      return { status: 'failed', code: 'DEPLOYMENT_BACKUP_PATH_INVALID', message: '备份归档符号链接不能离开证据目录' };
    if (!(await stat(archive)).isFile())
      return { status: 'failed', code: 'DEPLOYMENT_BACKUP_INVALID', message: '备份归档不是普通文件' };
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const digest = hash.digest('hex');
    if (digest !== value.backupSha256.toLowerCase())
      return { status: 'failed', code: 'DEPLOYMENT_BACKUP_HASH_MISMATCH', message: '备份归档内容与部署证据 SHA-256 不一致' };
    return { status: 'passed' };
  } catch {
    return { status: 'failed', code: 'DEPLOYMENT_BACKUP_MISSING', message: '备份归档不可读或不存在' };
  }
}
