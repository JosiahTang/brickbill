import { createHash } from 'node:crypto';

const sha256Pattern = /^[0-9a-f]{64}$/i;

function requireHash(value, label) {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) throw new Error(`固定依赖 ${label} 缺少有效摘要`);
  return value.toLowerCase();
}

function sortedRefs(refs, label) {
  if (!Array.isArray(refs)) throw new Error(`生成快照缺少固定 ${label} 引用`);
  return refs.map(ref => {
    if (!ref || typeof ref !== 'object' || !ref[`${label}Id`] || typeof ref.version !== 'string' || !ref.version)
      throw new Error(`生成快照包含无效的固定 ${label} 引用`);
    return { [`${label}Id`]: ref[`${label}Id`], version: ref.version };
  }).sort((a, b) => a[`${label}Id`].localeCompare(b[`${label}Id`]) || a.version.localeCompare(b.version));
}

function equalRefs(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function verifyGenerationDependencies(projectId, snapshot, request) {
  if (!projectId || !snapshot || typeof request !== 'function') throw new Error('固定依赖核对输入无效');
  const templateRef = snapshot.templateRef;
  if (!templateRef?.packageId || !Number.isInteger(templateRef.revision) || templateRef.revision < 1)
    throw new Error('生成快照缺少模板固定版本引用');
  const templatePath = `/api/projects/${encodeURIComponent(projectId)}/templates/${encodeURIComponent(templateRef.packageId)}/versions/${templateRef.revision}`;
  let published;
  try { published = await request(templatePath); }
  catch { throw new Error(`恢复后的固定模板版本无法读取：${templateRef.packageId}@${templateRef.revision}`); }
  const template = published?.value;
  if (published?.version !== templateRef.revision || template?.projectId !== projectId
    || template?.packageId !== templateRef.packageId || template?.revision !== templateRef.revision)
    throw new Error('恢复后的固定模板版本与生成快照不一致');

  const viewRefs = sortedRefs(snapshot.viewRefs, 'view');
  const templateViewRefs = sortedRefs(template.viewRefs, 'view');
  if (!equalRefs(viewRefs, templateViewRefs)) throw new Error('模板及生成快照的固定视图引用不一致');
  const views = [];
  for (const ref of viewRefs) {
    const path = `/api/projects/${encodeURIComponent(projectId)}/views/${encodeURIComponent(ref.viewId)}/versions/${encodeURIComponent(ref.version)}`;
    let record;
    try { record = await request(path); }
    catch { throw new Error(`恢复后的固定视图版本无法读取：${ref.viewId}@${ref.version}`); }
    if (record?.version !== ref.version || record?.value?.viewId !== ref.viewId || record?.value?.version !== ref.version)
      throw new Error(`恢复后的固定视图版本不一致：${ref.viewId}@${ref.version}`);
    views.push({ ...ref, sha256: createHash('sha256').update(JSON.stringify(record.value)).digest('hex') });
  }

  const functionRefs = sortedRefs(snapshot.functionRefs, 'function');
  const templateFunctionRefs = sortedRefs(template.functionRefs, 'function');
  if (!equalRefs(functionRefs, templateFunctionRefs)) throw new Error('模板及生成快照的固定函数引用不一致');
  if (functionRefs.length) {
    const metadata = await request(`/api/projects/${encodeURIComponent(projectId)}/designer-metadata`);
    const registered = new Map((metadata?.functions ?? []).map(item => [`${item.functionId}@${item.version}`, item]));
    for (const ref of functionRefs) if (!registered.has(`${ref.functionId}@${ref.version}`))
      throw new Error(`恢复环境缺少固定函数版本：${ref.functionId}@${ref.version}`);
    functionRefs.splice(0, functionRefs.length, ...functionRefs.map(ref => ({ ...ref,
      sha256: createHash('sha256').update(JSON.stringify(registered.get(`${ref.functionId}@${ref.version}`))).digest('hex') })));
  }

  const resourceIds = new Set((template.resources ?? []).map(resource => resource.resourceId));
  for (const page of template.pageDefinitions ?? []) for (const placement of page.imagePlacements ?? []) {
    if (!placement.resourceId) throw new Error('模板图片引用缺少资源标识');
    resourceIds.add(placement.resourceId);
  }
  const resources = [];
  for (const resourceId of [...resourceIds].sort()) {
    const path = `/api/projects/${encodeURIComponent(projectId)}/templates/${encodeURIComponent(templateRef.packageId)}/resources/${encodeURIComponent(resourceId)}`;
    let resource;
    try { resource = await request(path); }
    catch { throw new Error(`恢复后的模板资源无法读取：${resourceId}`); }
    if (typeof resource?.base64 !== 'string' || !resource.base64 || typeof resource.mediaType !== 'string')
      throw new Error(`恢复后的模板资源无效：${resourceId}`);
    const bytes = Buffer.from(resource.base64, 'base64');
    if (!bytes.length || bytes.toString('base64') !== resource.base64)
      throw new Error(`恢复后的模板资源编码无效：${resourceId}`);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (requireHash(resource.sha256, resourceId) !== actualHash)
      throw new Error(`恢复后的模板资源摘要不一致：${resourceId}`);
    const embedded = (template.resources ?? []).find(item => item.resourceId === resourceId);
    if (embedded) {
      const embeddedBytes = Buffer.from(embedded.base64 ?? '', 'base64');
      if (embedded.mediaType !== resource.mediaType || !embeddedBytes.length
        || createHash('sha256').update(embeddedBytes).digest('hex') !== actualHash)
        throw new Error(`模板版本与资源仓库内容不一致：${resourceId}`);
    }
    resources.push({ resourceId, mediaType: resource.mediaType, sha256: actualHash });
  }

  const dependencySummary = {
    projectId, templateRef: { packageId: templateRef.packageId, revision: templateRef.revision,
      sha256: createHash('sha256').update(JSON.stringify(template)).digest('hex') },
    viewRefs: views, functionRefs, resources,
  };
  const sha256 = createHash('sha256').update(JSON.stringify(dependencySummary)).digest('hex');
  return { sha256, resourceCount: resources.length, viewCount: viewRefs.length, functionCount: functionRefs.length };
}
