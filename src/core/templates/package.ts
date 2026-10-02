import { copy, type TemplateDocument } from '../../domain/model.ts';
import { validateDocument } from '../../domain/operations.ts';
import { ReportingError } from '../contracts/errors.ts';
import type { PageDefinition, TemplatePackage, TemplateWorksheet } from '../contracts/types.ts';
import { validateContract } from '../contracts/validate.ts';

function id(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  return `${prefix}.${random}`;
}
function safeName(name: string): string {
  const value = name.trim().replace(/[\\/?*:\[\]]/g, '_').slice(0, 31);
  if (!value || value.toLowerCase() === '_brickbill_template')
    throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'contract', message: '工作表名称无效或使用了系统保留名称' });
  return value;
}
function worksheet(document: TemplateDocument, worksheetId = id('sheet')): TemplateWorksheet {
  validateDocument(document);
  const saved = copy(document);
  if (saved.excelSource) saved.excelSource.base64 = '';
  const fields = saved.fields ?? [];
  const stable = fields.length > 0 && fields.every(field => !!field.fieldId)
    && Object.values(saved.cells).every(cell => !cell.binding || !!cell.binding.fieldId);
  return { worksheetId, name: safeName(document.sheetName), visible: true,
    bindingMode: stable ? 'stable-field-id' : 'legacy-path', document: saved };
}

export function createTemplatePackage(options: {
  projectId?: string; name?: string; worksheets: Array<{ worksheetId?: string; document: TemplateDocument }>;
  sourceWorkbook?: { fileName: string; base64: string };
}): TemplatePackage {
  if (!options.worksheets.length) throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'contract', message: '模板至少包含一个工作表' });
  const documents = options.worksheets.map(item => worksheet(item.document, item.worksheetId));
  const sourceWorkbook = options.sourceWorkbook ?? (() => {
    const source = options.worksheets.map(item => item.document.excelSource).find(item => item?.base64);
    return source ? { fileName: source.fileName, base64: source.base64 } : undefined;
  })();
  const result: TemplatePackage = {
    contractVersion: 2, packageId: id('template'), projectId: options.projectId ?? 'unassigned',
    name: options.name?.trim() || documents[0].document.name || '未命名模板', revision: 0,
    status: 'draft', catalogVersion: 'legacy-v0.2', viewRefs: [], functionRefs: [], worksheets: documents,
    ...(sourceWorkbook ? { sourceWorkbook: copy(sourceWorkbook) } : {}),
  };
  validateTemplatePackage(result);
  return result;
}

export function validateTemplatePackage(value: unknown): asserts value is TemplatePackage {
  validateContract<TemplatePackage>('templatePackage', value);
  const template = value as TemplatePackage;
  const resourceIds = new Set<string>();
  for (const resource of template.resources ?? []) {
    if (resourceIds.has(resource.resourceId)) throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'contract', message: `重复模板资源 ${resource.resourceId}` });
    resourceIds.add(resource.resourceId);
  }
  const worksheetIds = new Set<string>(), names = new Set<string>();
  for (const sheet of template.worksheets) {
    validateDocument(sheet.document);
    const canonicalName = safeName(sheet.name).toLocaleLowerCase();
    if (worksheetIds.has(sheet.worksheetId) || names.has(canonicalName))
      throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'contract', message: '工作表标识和名称必须唯一',
        context: { worksheetId: sheet.worksheetId } });
    worksheetIds.add(sheet.worksheetId); names.add(canonicalName);
    if (sheet.document.excelSource?.base64)
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'contract', message: '工作表不能重复保存整本 Excel，原工作簿只能保存在模板包级别', context: { worksheetId: sheet.worksheetId } });
    if (sheet.document.sheetName !== sheet.name)
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'contract', message: '工作表名称与文档中的工作表名称不一致', context: { worksheetId: sheet.worksheetId } });
    if (sheet.bindingMode === 'stable-field-id') {
      const ids = new Set((sheet.document.fields ?? []).map(field => field.fieldId).filter((fieldId): fieldId is string => !!fieldId));
      for (const cell of Object.values(sheet.document.cells)) if (cell.binding && (!cell.binding.fieldId || !ids.has(cell.binding.fieldId)))
        throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'contract', message: `工作表 ${sheet.name} 含有未使用稳定字段标识的绑定`, context: { worksheetId: sheet.worksheetId } });
    }
  }
  const definitions = template.pageDefinitions ?? [];
  const pageIds = new Set<string>();
  for (const page of definitions) {
    if (pageIds.has(page.pageDefinitionId)) throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'contract', message: `重复页面定义 ${page.pageDefinitionId}` });
    pageIds.add(page.pageDefinitionId);
    if (page.pageType === 'continuation' && !page.continuationOf)
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `续页 ${page.pageDefinitionId} 必须引用主页面` });
    if (page.paginationMode === 'flow') {
      const details = page.regions.filter(region => region.kind === 'detail');
      if (details.length !== 1) throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `流式页面 ${page.pageDefinitionId} 必须恰好有一个明细区域` });
      const detail = details[0];
      if (detail.recordHeight !== undefined && detail.recordHeight !== detail.rect.rows)
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: '流式记录使用样板行数作为结构高度，额外高度由文字测量决定', context: { regionId: detail.regionId } });
      if (page.printableRect) for (const region of page.regions.filter(item => ['detail', 'groupHeader', 'groupFooter'].includes(item.kind))) {
        const print = page.printableRect, rect = region.rect;
        if (rect.r < print.r || rect.c < print.c || rect.r + rect.rows > print.r + print.rows || rect.c + rect.cols > print.c + print.cols)
          throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'layout', message: `流式区域 ${region.regionId} 超出打印范围`, context: { regionId: region.regionId } });
      }
      for (const bandKind of ['groupHeader', 'groupFooter'] as const) {
        const bands = page.regions.filter(region => region.kind === bandKind);
        if (bands.length > 1 || bands.some(region => region.worksheetId !== detail.worksheetId || region.viewId !== detail.viewId
          || region.paginationGroupId !== detail.paginationGroupId || JSON.stringify(region.groupBy) !== JSON.stringify(detail.groupBy)))
          throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `流式页面 ${page.pageDefinitionId} 的${bandKind}必须与明细使用同一视图、工作表及组键` });
      }
      if (page.regions.some(region => region.kind === 'detail' && region.mergeFieldIds?.length))
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: '流式明细暂不支持跨变高行合并，请使用组头或隐藏重复字段' });
    } else if (page.regions.some(region => region.kind === 'groupHeader' || region.kind === 'groupFooter'))
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: '分组头尾区域只能用于流式页面' });
    if (page.paperSize === 'custom' && (!page.customPaperMm || page.customPaperMm.width <= 0 || page.customPaperMm.height <= 0))
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `自定义页面 ${page.pageDefinitionId} 缺少有效纸张尺寸` });
    if (page.printableRect) for (const worksheetId of page.worksheetIds) {
      const sheet = template.worksheets.find(item => item.worksheetId === worksheetId)!;
      const rect = page.printableRect;
      if (![rect.r, rect.c, rect.rows, rect.cols].every(Number.isInteger) || rect.r < 0 || rect.c < 0 || rect.rows < 1 || rect.cols < 1
        || rect.r + rect.rows > sheet.document.rows || rect.c + rect.cols > sheet.document.cols)
        throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'layout', message: `页面 ${page.pageDefinitionId} 的打印区域超出工作表 ${sheet.name}`, context: { worksheetId } });
    }
    if (page.repeatHeaderRows?.some(row => !Number.isInteger(row) || row < 0 || page.worksheetIds.some(worksheetId => {
      const sheet = template.worksheets.find(item => item.worksheetId === worksheetId)!; return row >= sheet.document.rows;
    })))
      throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'layout', message: `页面 ${page.pageDefinitionId} 的重复表头行超出工作表范围` });
    if (page.continuationOf && !definitions.some(parent => parent.pageDefinitionId === page.continuationOf))
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `续页引用不存在：${page.continuationOf}` });
    for (const worksheetId of page.worksheetIds) if (!worksheetIds.has(worksheetId))
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `页面引用不存在的工作表 ${worksheetId}`, context: { worksheetId } });
    const regionIds = new Set<string>();
    for (const region of page.regions) {
      if (regionIds.has(region.regionId)) throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'layout', message: `页面 ${page.pageDefinitionId} 重复定义区域 ${region.regionId}` });
      regionIds.add(region.regionId);
      const sheet = template.worksheets.find(item => item.worksheetId === region.worksheetId);
      if (!sheet || !page.worksheetIds.includes(region.worksheetId))
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `区域 ${region.regionId} 不属于页面引用的工作表`, context: { regionId: region.regionId, worksheetId: region.worksheetId } });
      const { r, c, rows, cols } = region.rect;
      if (![r, c, rows, cols].every(Number.isInteger) || r < 0 || c < 0 || rows < 1 || cols < 1
        || r + rows > sheet.document.rows || c + cols > sheet.document.cols)
        throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'layout', message: `区域 ${region.regionId} 超出工作表范围`, context: { regionId: region.regionId, worksheetId: sheet.worksheetId } });
      if (region.kind === 'detail' && (!region.viewId || !region.paginationGroupId || !region.groupBy?.length))
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `明细区域 ${region.regionId} 必须指定视图、联动分页组和分组键`, context: { regionId: region.regionId } });
      if ((region.kind === 'groupHeader' || region.kind === 'groupFooter') && (!region.viewId || !region.groupBy?.length))
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `分组区域 ${region.regionId} 必须指定视图和组键`, context: { regionId: region.regionId } });
      if (region.kind === 'detail' && region.recordHeight !== undefined && region.recordHeight < region.rect.rows)
        throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'layout', message: `明细区域 ${region.regionId} 的记录高度小于样板高度`, context: { regionId: region.regionId } });
      if (region.kind === 'detail' && region.capacityRows !== undefined && region.capacityRows < 1)
        throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'layout', message: `明细区域 ${region.regionId} 的容量必须至少为一行`, context: { regionId: region.regionId } });
      if (region.kind === 'detail' && region.capacityRows !== undefined) {
        const pageEnd = page.printableRect ? page.printableRect.r + page.printableRect.rows : sheet.document.rows;
        const footerStart = page.regions.filter(item => item.worksheetId === region.worksheetId && item.kind === 'footer' && item.rect.r > region.rect.r)
          .reduce((end, item) => Math.min(end, item.rect.r), pageEnd);
        if (region.rect.r + region.capacityRows > footerStart)
          throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'layout', message: `明细区域 ${region.regionId} 的容量会越过页尾或打印区域`, context: { worksheetId: region.worksheetId, regionId: region.regionId } });
      }
      if (region.appendixIfViewHasRecords && page.pageType !== 'appendix')
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `只有附页区域可以配置附页出现条件`, context: { regionId: region.regionId } });
      for (const fieldId of [...(region.mergeFieldIds ?? []), ...(region.hideRepeatedFieldIds ?? []), ...(region.repeatGroupFieldIds ?? [])]) {
        if (!sheet.document.fields?.some(field => field.fieldId === fieldId))
          throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'layout', message: `区域 ${region.regionId} 引用了不存在的字段 ${fieldId}`, context: { regionId: region.regionId, fieldId } });
      }
      if (region.kind === 'detail' && region.repeatOn && region.repeatOn !== 'all')
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `明细区域 ${region.regionId} 不能配置仅首页或末页显示`, context: { regionId: region.regionId } });
    }
    const imageIds = new Set<string>();
    for (const image of page.imagePlacements ?? []) {
      if (imageIds.has(image.imageId)) throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'layout', message: `页面 ${page.pageDefinitionId} 重复定义图片 ${image.imageId}` });
      imageIds.add(image.imageId);
      const sheet = template.worksheets.find(item => item.worksheetId === image.worksheetId);
      if (!sheet || !page.worksheetIds.includes(image.worksheetId)) throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `图片 ${image.imageId} 引用了不属于页面的工作表` });
      const { r, c, rows, cols } = image.rect;
      if (![r, c, rows, cols].every(Number.isInteger) || r < 0 || c < 0 || rows < 1 || cols < 1
        || r + rows > sheet.document.rows || c + cols > sheet.document.cols)
        throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'layout', message: `图片 ${image.imageId} 超出工作表范围`, context: { worksheetId: image.worksheetId, regionId: image.imageId } });
      if ((template.resources?.length ?? 0) > 0 && !resourceIds.has(image.resourceId))
        throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'layout', message: `图片 ${image.imageId} 引用的资源不存在：${image.resourceId}`, context: { regionId: image.imageId } });
    }
    const detailGroups = new Map<string, string[]>();
    for (const region of page.regions.filter(region => region.kind === 'detail')) {
      const key = region.paginationGroupId!;
      const previous = detailGroups.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(region.groupBy))
        throw new ReportingError({ code: 'AMBIGUOUS_SCOPE', stage: 'layout', message: `分页组 ${key} 的明细区域没有使用相同的组键`, context: { regionId: region.regionId } });
      detailGroups.set(key, region.groupBy!);
    }
    for (let left = 0; left < page.regions.length; left++) for (let right = left + 1; right < page.regions.length; right++) {
      const a = page.regions[left], b = page.regions[right];
      if (a.worksheetId !== b.worksheetId) continue;
      const intersects = a.rect.r < b.rect.r + b.rect.rows && a.rect.r + a.rect.rows > b.rect.r
        && a.rect.c < b.rect.c + b.rect.cols && a.rect.c + a.rect.cols > b.rect.c;
      if (intersects) throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'layout', message: `页面区域 ${a.regionId} 与 ${b.regionId} 重叠`, context: { regionId: b.regionId, worksheetId: a.worksheetId } });
    }
  }
  const pageById = new Map(definitions.map(page => [page.pageDefinitionId, page]));
  for (const page of definitions) {
    if (page.continuationOf) {
      if (page.continuationOf === page.pageDefinitionId) throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `页面定义不能续接自身：${page.pageDefinitionId}` });
      const parent = pageById.get(page.continuationOf);
      if (page.pageType === 'continuation' && parent?.pageType !== 'main')
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `续页 ${page.pageDefinitionId} 必须指向主页面定义` });
      if (page.pageType === 'continuation' && parent) {
        if ((page.paginationMode ?? 'fixed') !== (parent.paginationMode ?? 'fixed'))
          throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `续页 ${page.pageDefinitionId} 的分页模式与主页面不一致` });
        const continuationRegions = new Map(page.regions.map(region => [region.regionId, region]));
        if (parent.paginationMode === 'flow') for (const band of parent.regions.filter(region => region.kind === 'groupHeader' || region.kind === 'groupFooter')) {
          const resumed = continuationRegions.get(band.regionId);
          if (!resumed || resumed.kind !== band.kind || resumed.viewId !== band.viewId || JSON.stringify(resumed.groupBy) !== JSON.stringify(band.groupBy))
            throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `流式续页 ${page.pageDefinitionId} 缺少兼容的分组区域 ${band.regionId}`, context: { regionId: band.regionId } });
        }
        for (const original of parent.regions.filter(region => region.kind === 'detail' && region.repeatOn !== 'first')) {
          const resumed = continuationRegions.get(original.regionId);
          if (!resumed || resumed.kind !== 'detail' || resumed.viewId !== original.viewId
            || resumed.paginationGroupId !== original.paginationGroupId || JSON.stringify(resumed.groupBy) !== JSON.stringify(original.groupBy))
            throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `续页 ${page.pageDefinitionId} 缺少与主页面兼容的明细区域 ${original.regionId}`, context: { regionId: original.regionId } });
        }
      }
    }
  }
  for (const start of definitions) {
    const seen = new Set<string>(); let current: PageDefinition | undefined = start;
    while (current?.continuationOf) {
      if (seen.has(current.pageDefinitionId)) throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `页面续接关系存在循环：${current.pageDefinitionId}` });
      seen.add(current.pageDefinitionId); current = pageById.get(current.continuationOf);
    }
  }
}

export function renameWorksheet(template: TemplatePackage, worksheetId: string, newName: string): TemplatePackage {
  const result = copy(template);
  const sheet = result.worksheets.find(item => item.worksheetId === worksheetId);
  if (!sheet) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'contract', message: `工作表不存在：${worksheetId}` });
  sheet.name = safeName(newName); sheet.document.sheetName = sheet.name; sheet.document.revision++;
  validateTemplatePackage(result);
  return result;
}

export function reorderWorksheets(template: TemplatePackage, worksheetIds: string[]): TemplatePackage {
  if (worksheetIds.length !== template.worksheets.length || new Set(worksheetIds).size !== worksheetIds.length
    || worksheetIds.some(id => !template.worksheets.some(sheet => sheet.worksheetId === id)))
    throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'contract', message: '工作表排序必须包含每个工作表标识且不能重复' });
  const result = copy(template); const byId = new Map(result.worksheets.map(sheet => [sheet.worksheetId, sheet]));
  result.worksheets = worksheetIds.map(id => byId.get(id)!); result.revision++;
  return result;
}

export function updateWorksheet(template: TemplatePackage, worksheetId: string, document: TemplateDocument): TemplatePackage {
  const result = copy(template); const index = result.worksheets.findIndex(sheet => sheet.worksheetId === worksheetId);
  if (index < 0) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'contract', message: `工作表不存在：${worksheetId}` });
  result.worksheets[index] = { ...result.worksheets[index], ...worksheet(document, worksheetId), visible: result.worksheets[index].visible };
  result.revision++; validateTemplatePackage(result); return result;
}

export function upsertPageDefinition(template: TemplatePackage, definition: PageDefinition): TemplatePackage {
  const result = copy(template); result.pageDefinitions ??= [];
  const index = result.pageDefinitions.findIndex(item => item.pageDefinitionId === definition.pageDefinitionId);
  if (index < 0) result.pageDefinitions.push(copy(definition)); else result.pageDefinitions[index] = copy(definition);
  result.revision++; validateTemplatePackage(result); return result;
}
