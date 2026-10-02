import { copy, keyOf, type Field, type TemplateDocument } from '../../domain/model.ts';
import { ReportingError } from '../contracts/errors.ts';
import type { DataViewResult, PageDefinition, PagePlan, PagePlanEntry, PageRegionDefinition, Scalar, TemplatePackage, TemplateImagePlacement, ViewRecord } from '../contracts/types.ts';
import { validateTemplatePackage } from '../templates/package.ts';

export interface PageRenderOptions { parameters?: Record<string, Scalar>; maxCells?: number }
export interface ProjectedSheetPage {
  pageNumber: number; totalPages: number; pageType: string; pageDefinitionId: string;
  worksheetId: string; document: TemplateDocument; recordCount: number; groupCount: number;
  pageSetup: Pick<PageDefinition, 'paperSize' | 'orientation' | 'marginsMm' | 'printableRect' | 'repeatHeaderRows' | 'customPaperMm'>;
  imagePlacements: TemplateImagePlacement[];
}
export interface ProjectedDocumentPages {
  pagePlan: PagePlan; pages: ProjectedSheetPage[];
  resources: NonNullable<TemplatePackage['resources']>;
  sourceWorkbook?: TemplatePackage['sourceWorkbook'];
}

export function textOf(value: Scalar | undefined): string | undefined {
  if (value === undefined || value === null) return value === null ? '' : undefined;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}
function ownValue(record: ViewRecord | undefined, fieldId: string | undefined): Scalar | undefined {
  return record && fieldId && Object.hasOwn(record.values, fieldId) ? record.values[fieldId] : undefined;
}
function aggregate(records: ViewRecord[], fieldId: string, operation: NonNullable<Field['aggregate']>['operation']): Scalar {
  const values = records.map(record => record.values[fieldId]).filter((value): value is Scalar => value !== undefined && value !== null);
  if (operation === 'count') return values.length;
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new ReportingError({ code: 'VALUE_TYPE_ERROR', stage: 'render', message: `汇总字段 ${fieldId} 含非数字值`, context: { fieldId } });
  const numbers = values as number[];
  if (!numbers.length) return null;
  if (operation === 'sum') return numbers.reduce((sum, value) => sum + value, 0);
  if (operation === 'average') return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  if (operation === 'min') return Math.min(...numbers);
  return Math.max(...numbers);
}
function same(a: Scalar | undefined, b: Scalar | undefined): boolean { return Object.is(a, b); }
function fieldFor(doc: TemplateDocument, path: string, fieldId?: string): Field | undefined {
  return doc.fields?.find(field => (fieldId && field.fieldId === fieldId) || field.path === path || field.fieldId === path);
}
export function sourceValue(field: Field | undefined, path: string, record: ViewRecord | undefined, page: PagePlanEntry,
  totalPages: number, recordNumber: number, groupNumber: number, parameters: Record<string, Scalar>,
  values: Record<string, Scalar>): Scalar | undefined {
  if (!field) {
    const value = ownValue(record, path);
    return value !== undefined ? value : Object.hasOwn(values, path) ? values[path] : undefined;
  }
  if (field.sourceKind === 'constant') return field.constantValue ?? null;
  if (field.sourceKind === 'parameter') return parameters[field.parameterId ?? field.path];
  if (field.sourceKind === 'page') {
    if (field.pageField === 'number') return page.pageNumber;
    if (field.pageField === 'total') return totalPages;
    if (field.pageField === 'recordNumber') return recordNumber;
    if (field.pageField === 'groupNumber') return groupNumber;
  }
  for (const fieldId of [field.fieldId, field.sourceFieldId, path]) {
    const value = ownValue(record, fieldId);
    if (value !== undefined) return value;
  }
  const target = field.fieldId ?? path;
  return Object.hasOwn(values, target) ? values[target] : undefined;
}
function removeRegionContents(document: TemplateDocument, region: PageRegionDefinition): void {
  const { r, c, rows, cols } = region.rect;
  for (const [key, cell] of Object.entries(document.cells)) {
    const [row, col] = key.split(':').map(Number);
    if (row >= r && row < r + rows && col >= c && col < c + cols) delete document.cells[key];
  }
  document.merges = document.merges.filter(merge => {
    const intersects = merge.r < r + rows && merge.r + merge.rows > r && merge.c < c + cols && merge.c + merge.cols > c;
    if (!intersects) return true;
    if (merge.r < r || merge.r + merge.rows > r + rows || merge.c < c || merge.c + merge.cols > c)
      throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'render', message: `合并区域跨越明细区边界：${region.regionId}`, context: { regionId: region.regionId } });
    return false;
  });
}
function blankRegion(document: TemplateDocument, region: PageRegionDefinition): void {
  for (let row = region.rect.r; row < region.rect.r + region.rect.rows; row++) for (let col = region.rect.c; col < region.rect.c + region.rect.cols; col++) {
    const cell = document.cells[keyOf(row, col)];
    if (!cell) continue;
    delete cell.binding; delete cell.excelValue; cell.text = '';
  }
}
function copyRowPattern(source: TemplateDocument, target: TemplateDocument, region: PageRegionDefinition, destinationRow: number): void {
  for (const [key, cell] of Object.entries(source.cells)) {
    const [row, col] = key.split(':').map(Number);
    if (row < region.rect.r || row >= region.rect.r + region.rect.rows || col < region.rect.c || col >= region.rect.c + region.rect.cols) continue;
    const targetRow = destinationRow + row - region.rect.r;
    target.cells[keyOf(targetRow, col)] = copy(cell);
  }
  for (const merge of source.merges) {
    if (merge.r < region.rect.r || merge.r >= region.rect.r + region.rect.rows || merge.c < region.rect.c || merge.c >= region.rect.c + region.rect.cols) continue;
    target.merges.push({ ...copy(merge), r: destinationRow + merge.r - region.rect.r });
  }
  for (let offset = 0; offset < region.rect.rows; offset++) {
    target.rowHeightPx[destinationRow + offset] = source.rowHeightPx[region.rect.r + offset] ?? 24;
  }
}
function regionRecords(page: PagePlanEntry, region: PageRegionDefinition, view: DataViewResult): { records: ViewRecord[]; keys: Scalar[][] } {
  const allocation = page.allocations.find(item => item.regionId === region.regionId);
  if (!allocation) return { records: [], keys: [] };
  if (allocation.viewId !== view.viewId || allocation.groupKeys.length !== allocation.recordIds.length)
    throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'render', message: `页面区域 ${region.regionId} 的分页分配与视图/组键不匹配`, context: { regionId: region.regionId, viewId: view.viewId } });
  const byId = new Map(view.records.map(record => [record.recordId, record]));
  if (byId.size !== view.records.length) throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'render', message: `视图 ${view.viewId} 含重复记录标识`, context: { viewId: view.viewId } });
  const records = allocation.recordIds.map(id => {
    const record = byId.get(id);
    if (!record) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'render', message: `分页计划引用不存在的记录 ${id}`, context: { regionId: region.regionId, viewId: view.viewId } });
    return record;
  });
  return { records, keys: allocation.groupKeys };
}
function applyRegion(source: TemplateDocument, target: TemplateDocument, page: PagePlanEntry, region: PageRegionDefinition,
  view: DataViewResult, totalPages: number, globalRecordOffset: number, groupNumbers: Map<string, number>,
  parameters: Record<string, Scalar>): { recordCount: number; groupCount: number } {
  const { records, keys } = regionRecords(page, region, view);
  const recordHeight = region.recordHeight ?? region.rect.rows;
  if (recordHeight < region.rect.rows) throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'render', message: `区域 ${region.regionId} 的记录高度小于样板高度`, context: { regionId: region.regionId } });
  const end = region.rect.r + records.length * recordHeight;
  if (end > target.rows) throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'render', message: `区域 ${region.regionId} 的投影超出工作表行数`, context: { regionId: region.regionId, pageNumber: page.pageNumber } });
  if (records.length || region.emptyPolicy === 'hide') removeRegionContents(target, region);
  else {
    for (let row = region.rect.r; row < region.rect.r + region.rect.rows; row++) for (let col = region.rect.c; col < region.rect.c + region.rect.cols; col++) {
      const cell = target.cells[keyOf(row, col)];
      if (cell?.binding) { delete cell.binding; cell.text = ''; cell.excelValue = null; }
    }
    return { recordCount: 0, groupCount: 0 };
  }
  const groupIds = [...new Set(keys.map(key => JSON.stringify(key)))];
  const groupNo = new Map(groupIds.map((id, index) => [id, groupNumbers.get(id) ?? index + 1]));
  const renderedFields: Array<Map<string, { addresses: string[]; value: Scalar | undefined }>> = [];
  for (let index = 0; index < records.length; index++) {
    const destinationRow = region.rect.r + index * recordHeight;
    copyRowPattern(source, target, region, destinationRow);
    const rowCellKeys = Object.keys(target.cells).filter(key => {
      const [row, col] = key.split(':').map(Number);
      return row >= destinationRow && row < destinationRow + region.rect.rows && col >= region.rect.c && col < region.rect.c + region.rect.cols;
    });
    const contextValues: Record<string, Scalar> = {};
    const fieldsForRecord = new Map<string, { addresses: string[]; value: Scalar | undefined }>();
    for (const path of rowCellKeys) {
      const cell = target.cells[path]; if (!cell.binding) continue;
      const field = fieldFor(target, cell.binding.path, cell.binding.fieldId);
      const recordNumber = globalRecordOffset + index + 1;
      const groupNumber = groupNo.get(JSON.stringify(keys[index] ?? [])) ?? page.pageNumber;
      const value = sourceValue(field, cell.binding.path, records[index], page, totalPages, recordNumber, groupNumber, parameters, contextValues);
      if (value === undefined && field?.required) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'render', message: `必填字段 ${field.label} 在视图 ${view.viewId} 中没有值`, context: { fieldId: field.fieldId ?? field.path, regionId: region.regionId, pageNumber: page.pageNumber } });
      cell.excelValue = value ?? null; cell.text = textOf(value) ?? ''; delete cell.binding;
      if (field) {
        const fieldId = field.fieldId ?? field.path;
        contextValues[fieldId] = value ?? null;
        const current = fieldsForRecord.get(fieldId) ?? { addresses: [], value };
        current.addresses.push(path); fieldsForRecord.set(fieldId, current);
      }
    }
    renderedFields.push(fieldsForRecord);
  }
  // Repeated-value suppression is page-local so every continuation page restates its own key.
  const mergeSpans: Array<{ fieldId: string; first: number; last: number; column: number }> = [];
  for (const fieldId of new Set([...(region.hideRepeatedFieldIds ?? []), ...(region.mergeFieldIds ?? [])])) {
    let first = 0;
    while (first < records.length) {
      const firstField = renderedFields[first].get(fieldId);
      if (!firstField) { first++; continue; }
      let last = first + 1;
      while (last < records.length && JSON.stringify(keys[last] ?? []) === JSON.stringify(keys[last - 1] ?? [])
        && same(firstField.value, renderedFields[last].get(fieldId)?.value)) last++;
      const firstAddress = firstField.addresses[0], [firstRow, column] = firstAddress.split(':').map(Number);
      if (last - first > 1) for (let index = first + 1; index < last; index++) {
        for (const address of renderedFields[index].get(fieldId)?.addresses ?? []) target.cells[address].text = '';
      }
      if (region.mergeFieldIds?.includes(fieldId) && last - first > 1)
        mergeSpans.push({ fieldId, first: region.rect.r + first * recordHeight, last: region.rect.r + last * recordHeight, column });
      first = last;
    }
  }
  for (const fieldId of region.mergeFieldIds ?? []) {
    for (const merge of mergeSpans.filter(item => item.fieldId === fieldId)) {
      target.merges.push({ r: merge.first, c: merge.column, rows: merge.last - merge.first, cols: 1 });
    }
  }
  return { recordCount: records.length, groupCount: groupIds.length };
}

function applyFlow(source: TemplateDocument, target: TemplateDocument, page: PagePlanEntry, definition: PageDefinition,
  views: Map<string, DataViewResult>, totalPages: number, globalRecordOffset: number,
  groupNumbers: Map<string, number>, parameters: Record<string, Scalar>): number {
  const items = page.flowItems ?? [];
  const detail = definition.regions.find(region => region.kind === 'detail');
  if (!detail) throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'render', message: '流式页面缺少明细区域' });
  const start = Math.min(...definition.regions.filter(region => ['detail', 'groupHeader', 'groupFooter'].includes(region.kind)).map(region => region.rect.r));
  const printableEnd = definition.printableRect ? definition.printableRect.r + definition.printableRect.rows : target.rows;
  const end = definition.regions.filter(region => region.kind === 'footer' && region.rect.r >= start
    && (page.pageNumber === totalPages || region.repeatOn !== 'last')).reduce((value, region) => Math.min(value, region.rect.r), printableEnd);
  const bodyEnd = Math.min(end, detail.capacityRows ? detail.rect.r + detail.capacityRows : end);
  removeRegionContents(target, { regionId: detail.regionId, worksheetId: detail.worksheetId, label: detail.label,
    kind: 'detail', rect: { r: start, c: 0, rows: bodyEnd - start, cols: target.cols } });
  const rowHeights = page.rowHeightsPx?.[detail.worksheetId];
  if (!rowHeights || rowHeights.length !== target.rows) throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'render', message: '流式页面行高计划缺失或长度不正确' });
  target.rowHeightPx = copy(rowHeights);
  const recordMaps = new Map([...views].map(([id, view]) => [id, new Map(view.records.map(record => [record.recordId, record]))]));
  let recordNumber = globalRecordOffset, previousGroup = '', previousValues = new Map<string, Scalar | undefined>();
  for (const item of items) {
    const region = definition.regions.find(region => region.regionId === item.regionId && region.worksheetId === detail.worksheetId);
    const record = recordMaps.get(item.viewId)?.get(item.recordId);
    if (!region || !record || region.viewId !== item.viewId || item.rowHeightsPx.length !== region.rect.rows
      || item.startRow < start || item.startRow + item.rowHeightsPx.length > bodyEnd)
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'render', message: `流式分页条目 ${item.regionId} 无效`, context: { regionId: item.regionId, pageNumber: page.pageNumber } });
    copyRowPattern(source, target, region, item.startRow);
    item.rowHeightsPx.forEach((height, offset) => { target.rowHeightPx[item.startRow + offset] = height; });
    const groupId = JSON.stringify(item.groupKey);
    if (region.kind === 'detail') recordNumber++;
    const currentValues: Record<string, Scalar> = {};
    for (const [address, cell] of Object.entries(target.cells)) {
      const [r, c] = address.split(':').map(Number);
      if (r < item.startRow || r >= item.startRow + region.rect.rows || c < region.rect.c || c >= region.rect.c + region.rect.cols) continue;
      if (cell.style?.wrap !== false) cell.style = { ...cell.style, wrap: true };
      if (!cell.binding) continue;
      const field = fieldFor(target, cell.binding.path, cell.binding.fieldId);
      const value = field?.aggregate?.scope === 'group'
        ? (() => {
          const aggregateView = views.get(field.aggregate!.viewId);
          if (!aggregateView) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'render', message: `组汇总视图不存在：${field.aggregate!.viewId}` });
          const records = aggregateView.records.filter(candidate => JSON.stringify(region.groupBy?.map(id => candidate.values[id])) === groupId);
          return aggregate(records, field.aggregate!.fieldId, field.aggregate!.operation);
        })()
        : sourceValue(field, cell.binding.path, record, page, totalPages, recordNumber,
          groupNumbers.get(groupId) ?? 1, parameters, currentValues);
      if (value === undefined && field?.required) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'render', message: `必填字段 ${field.label} 在流式视图中没有值`, context: { regionId: region.regionId, pageNumber: page.pageNumber, fieldId: field.fieldId } });
      const fieldId = field?.fieldId ?? field?.path;
      const suppress = region.kind === 'detail' && fieldId && region.hideRepeatedFieldIds?.includes(fieldId)
        && previousGroup === groupId && Object.is(previousValues.get(fieldId), value);
      cell.excelValue = suppress ? null : value ?? null; cell.text = suppress ? '' : textOf(value) ?? ''; delete cell.binding;
      if (fieldId) currentValues[fieldId] = value ?? null;
    }
    if (region.kind === 'detail') { previousGroup = groupId; previousValues = new Map(Object.entries(currentValues)); }
  }
  return recordNumber - globalRecordOffset;
}

/** Builds immutable, one-page worksheet projections from either page-plan mode. */
export function projectPagePlan(template: TemplatePackage, pagePlan: PagePlan, viewResults: DataViewResult[],
  options: PageRenderOptions = {}): ProjectedDocumentPages {
  validateTemplatePackage(template);
  if (pagePlan.templateId !== template.packageId || pagePlan.templateVersion !== template.revision)
    throw new ReportingError({ code: 'REVISION_CONFLICT', stage: 'render', message: '分页计划与模板包版本不匹配' });
  if (pagePlan.pages.length !== pagePlan.totalPages)
    throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'render', message: '分页计划总页数与页面清单不一致' });
  const views = new Map(viewResults.map(view => [view.viewId, view]));
  const globalRecordStart = new Map<string, number>(), pages: ProjectedSheetPage[] = [];
  const groupNumbers = new Map<string, number>();
  for (const plannedPage of pagePlan.pages) for (const allocation of plannedPage.allocations) for (const key of allocation.groupKeys) {
    const groupKey = JSON.stringify(key);
    if (!groupNumbers.has(groupKey)) groupNumbers.set(groupKey, groupNumbers.size + 1);
  }
  for (const page of pagePlan.pages) {
    const pageDefinition = template.pageDefinitions?.find(definition => definition.pageDefinitionId === page.pageDefinitionId);
    if (!pageDefinition) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'render', message: `分页计划引用不存在的页面定义 ${page.pageDefinitionId}` });
    let pageRecords = 0;
    for (const worksheetId of page.worksheetIds ?? pageDefinition.worksheetIds) {
      const worksheet = template.worksheets.find(item => item.worksheetId === worksheetId);
      if (!worksheet) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'render', message: `工作表不存在：${worksheetId}`, context: { worksheetId } });
      const source = worksheet.document, document = copy(source);
      const regions = pageDefinition.regions.filter(region => region.worksheetId === worksheetId);
      const appliedRegions: Array<{ region: PageRegionDefinition; recordCount: number; groupCount: number }> = [];
      const isFlowSheet = !!page.flowItems && regions.some(region => region.kind === 'detail');
      if (isFlowSheet) {
        for (const region of regions) if ((region.repeatOn === 'first' && page.pageNumber !== 1)
          || (region.repeatOn === 'last' && page.pageNumber !== pagePlan.totalPages)) blankRegion(document, region);
        const detail = regions.find(region => region.kind === 'detail')!;
        const count = applyFlow(source, document, page, pageDefinition, views, pagePlan.totalPages,
          globalRecordStart.get(detail.regionId) ?? 0, groupNumbers, options.parameters ?? {});
        pageRecords = Math.max(pageRecords, count);
        globalRecordStart.set(detail.regionId, (globalRecordStart.get(detail.regionId) ?? 0) + count);
      }
      for (const region of regions) {
        if ((region.repeatOn === 'first' && page.pageNumber !== 1) || (region.repeatOn === 'last' && page.pageNumber !== pagePlan.totalPages)) {
          if (!isFlowSheet) blankRegion(document, region);
          continue;
        }
        if (region.kind !== 'detail' || isFlowSheet) continue;
        const view = views.get(region.viewId!);
        if (!view) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'render', message: `页面区域引用不存在的视图 ${region.viewId}`, context: { regionId: region.regionId, viewId: region.viewId } });
        const result = applyRegion(source, document, page, region, view, pagePlan.totalPages,
          globalRecordStart.get(region.regionId) ?? 0, groupNumbers, options.parameters ?? {});
        appliedRegions.push({ region, ...result }); pageRecords = Math.max(pageRecords, result.recordCount);
        globalRecordStart.set(region.regionId, (globalRecordStart.get(region.regionId) ?? 0) + result.recordCount);
      }
      // Resolve stable fields, constants, parameters and page system values outside repeat regions.
      for (const [address, cell] of Object.entries(document.cells)) {
        if (!cell.binding) continue;
        const [r, c] = address.split(':').map(Number);
        if (regions.some(region => region.kind === 'detail' && r >= region.rect.r && r < region.rect.r + region.rect.rows && c >= region.rect.c && c < region.rect.c + region.rect.cols)) continue;
        const field = fieldFor(document, cell.binding.path, cell.binding.fieldId);
        let value: Scalar | undefined;
        if (field?.aggregate) {
          if (field.aggregate.scope === 'group') throw new ReportingError({ code: 'AMBIGUOUS_SCOPE', stage: 'render', message: `组汇总字段 ${field.label} 必须放在流式分组头尾中`, context: { fieldId: field.fieldId, worksheetId, pageNumber: page.pageNumber } });
          const view = views.get(field.aggregate.viewId);
          if (!view) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'render', message: `汇总字段引用不存在的视图 ${field.aggregate.viewId}` });
          const sourceRecords = field.aggregate.scope === 'page'
            ? view.records.filter(record => page.allocations.some(allocation => allocation.viewId === view.viewId && allocation.recordIds.includes(record.recordId)))
            : view.records;
          value = aggregate(sourceRecords, field.aggregate.fieldId, field.aggregate.operation);
        } else if (field?.sourceKind === 'view' && field.viewId) {
          const view = views.get(field.viewId);
          if (!view) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'render', message: `字段引用不存在的视图 ${field.viewId}`, context: { viewId: field.viewId, fieldId: field.fieldId, pageNumber: page.pageNumber, worksheetId } });
          if (view.records.length > 1) throw new ReportingError({ code: 'AMBIGUOUS_SCOPE', stage: 'render', message: `固定字段 ${field.label} 在视图 ${field.viewId} 有多条记录，请指定汇总或放入明细区`, context: { viewId: field.viewId, fieldId: field.fieldId, pageNumber: page.pageNumber, worksheetId, cell: address } });
          value = sourceValue(field, cell.binding.path, view.records[0], page, pagePlan.totalPages, 0, page.pageNumber, options.parameters ?? {}, {});
        } else if (field?.sourceKind === 'dataset') {
          const fieldId = field.sourceFieldId ?? field.fieldId;
          if (!fieldId) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'render', message: `数据字段 ${field.label} 缺少稳定源字段标识`, context: { pageNumber: page.pageNumber, worksheetId, cell: address } });
          const candidates = viewResults.filter(view => view.outputFields.includes(fieldId));
          if (candidates.length > 1) throw new ReportingError({ code: 'AMBIGUOUS_SCOPE', stage: 'render', message: `数据字段 ${field.label} 出现在多个视图，请明确指定数据视图`, context: { fieldId, pageNumber: page.pageNumber, worksheetId, cell: address } });
          const view = candidates[0];
          if (view?.records.length > 1) throw new ReportingError({ code: 'AMBIGUOUS_SCOPE', stage: 'render', message: `固定数据字段 ${field.label} 有多条记录，请指定汇总或放入明细区`, context: { viewId: view.viewId, fieldId, pageNumber: page.pageNumber, worksheetId, cell: address } });
          value = sourceValue(field, cell.binding.path, view?.records[0], page, pagePlan.totalPages, 0, page.pageNumber, options.parameters ?? {}, {});
        } else value = sourceValue(field, cell.binding.path, undefined, page, pagePlan.totalPages, 0,
          page.pageNumber, options.parameters ?? {}, {});
        if (value === undefined && field?.required) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'render', message: `必填字段 ${field.label} 未找到值`, context: { fieldId: field.fieldId, pageNumber: page.pageNumber, worksheetId, cell: address, sourcePath: field.path } });
        cell.text = textOf(value) ?? ''; cell.excelValue = value ?? null; delete cell.binding;
      }
      const cellCount = Object.keys(document.cells).length;
      if (cellCount > (options.maxCells ?? 500_000)) throw new ReportingError({ code: 'RESOURCE_LIMIT_EXCEEDED', stage: 'render', message: `页面投影单元格数量超过限制 ${cellCount}` });
      const pageGroups = new Set<string>();
      for (const allocation of page.allocations) {
        const region = pageDefinition.regions.find(item => item.regionId === allocation.regionId);
        const groupId = region?.paginationGroupId ?? allocation.regionId;
        for (const key of allocation.groupKeys) pageGroups.add(`${groupId}:${JSON.stringify(key)}`);
      }
      pages.push({ pageNumber: page.pageNumber, totalPages: pagePlan.totalPages, pageType: page.pageType,
        pageDefinitionId: page.pageDefinitionId, worksheetId, document, recordCount: pageRecords,
        groupCount: pageGroups.size,
        pageSetup: { paperSize: pageDefinition.paperSize, orientation: pageDefinition.orientation, marginsMm: copy(pageDefinition.marginsMm),
          ...(pageDefinition.customPaperMm ? { customPaperMm: copy(pageDefinition.customPaperMm) } : {}),
          ...(pageDefinition.printableRect ? { printableRect: copy(pageDefinition.printableRect) } : {}),
          ...(pageDefinition.repeatHeaderRows ? { repeatHeaderRows: copy(pageDefinition.repeatHeaderRows) } : {}) },
        imagePlacements: copy((pageDefinition.imagePlacements ?? []).filter(image => image.worksheetId === worksheetId
          && (image.repeatOn !== 'first' || page.pageNumber === 1) && (image.repeatOn !== 'last' || page.pageNumber === pagePlan.totalPages))) });
    }
  }
  return { pagePlan: copy(pagePlan), pages, resources: copy(template.resources ?? []),
    ...(template.sourceWorkbook ? { sourceWorkbook: copy(template.sourceWorkbook) } : {}) };
}
