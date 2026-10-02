import type { TemplateDocument } from '../../domain/model.ts';
import { ReportingError } from '../contracts/errors.ts';
import type { DataViewResult, PageDefinition, PagePlan, PagePlanEntry, PageRegionDefinition, Scalar, TemplatePackage, ViewRecord } from '../contracts/types.ts';
import { validateContract } from '../contracts/validate.ts';
import { estimatedTextWidthPx, requiredTextHeightPx } from '../layout/measure.ts';
import { sourceValue, textOf } from '../render/page.ts';
import { validateTemplatePackage } from '../templates/package.ts';
import { compare, encoded, planFixedPages, scalar, sortedRecords } from './fixed.ts';

type FlowItem = NonNullable<PagePlanEntry['flowItems']>[number];
interface SourceItem { regionId: string; viewId: string; record: ViewRecord; groupKey: Scalar[]; heights: number[] }

function fail(code: 'CONTRACT_INVALID' | 'LAYOUT_OVERFLOW' | 'GROUP_TOO_LARGE', message: string, regionId?: string): never {
  throw new ReportingError({ code, stage: 'layout', message, context: regionId ? { regionId } : {} });
}
function sourceHeights(document: TemplateDocument, region: PageRegionDefinition, record: ViewRecord,
  parameters: Record<string, Scalar>): number[] {
  const heights = Array.from({ length: region.rect.rows }, (_, offset) => document.rowHeightPx[region.rect.r + offset] ?? 24);
  for (const [address, cell] of Object.entries(document.cells)) {
    const [r, c] = address.split(':').map(Number);
    if (r < region.rect.r || r >= region.rect.r + region.rect.rows || c < region.rect.c || c >= region.rect.c + region.rect.cols) continue;
    const merge = document.merges.find(item => item.r === r && item.c === c);
    if (merge && (merge.r + merge.rows > region.rect.r + region.rect.rows || merge.c + merge.cols > region.rect.c + region.rect.cols))
      fail('LAYOUT_OVERFLOW', `流式样板合并区域超出 ${region.regionId}`, region.regionId);
    const width = document.colWidthPx.slice(c, c + (merge?.cols ?? 1)).reduce((sum, value) => sum + value, 0);
    const field = cell.binding && document.fields?.find(item => item.fieldId === cell.binding?.fieldId || item.path === cell.binding?.path);
    const value = cell.binding ? sourceValue(field, cell.binding.path, record,
      { pageNumber: 1, pageType: 'main', pageDefinitionId: '', allocations: [], blankRows: {}, diagnostics: [] }, 1, 1, 1, parameters, {}) : undefined;
    const text = cell.binding ? textOf(value) ?? '' : cell.text ?? textOf(typeof cell.excelValue === 'string' || typeof cell.excelValue === 'number'
      || typeof cell.excelValue === 'boolean' ? cell.excelValue : undefined) ?? '';
    if (!text) continue;
    if (cell.style?.wrap === false && estimatedTextWidthPx(text, cell.style.fontSizePt) + 4 > width)
      fail('LAYOUT_OVERFLOW', `流式区域 ${region.regionId} 的不换行文字会被裁切`, region.regionId);
    const needed = requiredTextHeightPx(text, width, cell.style?.fontSizePt, cell.style?.wrap !== false);
    const span = merge?.rows ?? 1;
    const current = heights.slice(r - region.rect.r, r - region.rect.r + span).reduce((sum, height) => sum + height, 0);
    if (needed > current) heights[r - region.rect.r + span - 1] += needed - current;
  }
  return heights.map(value => Math.ceil(value));
}
function capacity(definition: PageDefinition, document: TemplateDocument, start: number, last: boolean, detail: PageRegionDefinition) {
  const printEnd = definition.printableRect ? definition.printableRect.r + definition.printableRect.rows : document.rows;
  const footer = definition.regions.filter(region => region.worksheetId === detail.worksheetId && region.kind === 'footer'
    && region.rect.r >= start && (last || region.repeatOn !== 'last')).reduce((end, region) => Math.min(end, region.rect.r), printEnd);
  const end = Math.min(footer, detail.capacityRows ? detail.rect.r + detail.capacityRows : footer);
  const heights = document.rowHeightPx.slice(start, end);
  if (!heights.length) fail('LAYOUT_OVERFLOW', '流式明细没有可用页面高度', detail.regionId);
  return { end, pixels: heights.reduce((sum, height) => sum + height, 0) - heights.length * 0.1 };
}

/** One flowing detail lane per worksheet; group bands share its view and business key. */
export function planFlowPages(template: TemplatePackage, mainPageDefinitionId: string, viewResults: DataViewResult[],
  parameters: Record<string, Scalar> = {}): PagePlan {
  validateTemplatePackage(template);
  const main = template.pageDefinitions?.find(page => page.pageDefinitionId === mainPageDefinitionId);
  if (!main || main.pageType !== 'main' || main.paginationMode !== 'flow') fail('CONTRACT_INVALID', '分页入口必须是明确选择流式的主页面');
  const continuation = template.pageDefinitions?.find(page => page.pageType === 'continuation' && page.continuationOf === main.pageDefinitionId);
  const definitions = [main, ...(continuation ? [continuation] : [])];
  const views = new Map(viewResults.map(view => [view.viewId, view]));
  if (views.size !== viewResults.length) fail('CONTRACT_INVALID', '分页视图标识重复');
  const appendices = (template.pageDefinitions ?? []).filter(page => page.pageType === 'appendix' && (!page.continuationOf || page.continuationOf === main.pageDefinitionId))
    .filter(page => {
      const condition = page.regions.find(region => region.appendixIfViewHasRecords)?.appendixIfViewHasRecords;
      if (!condition) return true;
      const view = views.get(condition);
      if (!view) fail('CONTRACT_INVALID', `附页条件视图不存在：${condition}`);
      return view.records.length > 0;
    });
  const mainDetail = main.regions.find(region => region.kind === 'detail')!;
  const view = views.get(mainDetail.viewId!);
  if (!view) fail('CONTRACT_INVALID', `流式明细视图不存在：${mainDetail.viewId}`, mainDetail.regionId);
  const groups = new Map<string, { key: Scalar[]; records: ViewRecord[] }>();
  for (const record of sortedRecords(view.records, mainDetail)) {
    const key = mainDetail.groupBy!.map(fieldId => scalar(record.values[fieldId], fieldId, view.viewId));
    const id = encoded(key), entry = groups.get(id) ?? { key, records: [] };
    entry.records.push(record); groups.set(id, entry);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) { const result = compare(a.key[i], b.key[i]); if (result) return result; }
    return 0;
  });
  const pages: PagePlanEntry[] = [];
  let current: PagePlanEntry | undefined, used = 0, cursor = 0, bodyStart = 0, bodyEnd = 0;
  const definitionFor = (index: number) => index && continuation ? continuation : main;
  const startPage = () => {
    const definition = definitionFor(pages.length), detail = definition.regions.find(region => region.regionId === mainDetail.regionId)!;
    const document = template.worksheets.find(sheet => sheet.worksheetId === detail.worksheetId)!.document;
    bodyStart = Math.min(...definition.regions.filter(region => ['detail', 'groupHeader', 'groupFooter'].includes(region.kind)).map(region => region.rect.r));
    bodyEnd = capacity(definition, document, bodyStart, false, detail).end;
    cursor = bodyStart; used = 0;
    current = { pageNumber: pages.length + 1, pageType: definition.pageType, pageDefinitionId: definition.pageDefinitionId,
      worksheetIds: definition.worksheetIds, allocations: [{ regionId: detail.regionId, viewId: detail.viewId!, recordIds: [], groupKeys: [], startRow: bodyStart,
        recordHeight: detail.rect.rows }], flowItems: [], blankRows: {}, diagnostics: [] };
    pages.push(current);
  };
  const regionsFor = (definition: PageDefinition) => {
    const detail = definition.regions.find(region => region.regionId === mainDetail.regionId)!;
    return { detail, header: definition.regions.find(region => region.kind === 'groupHeader'), footer: definition.regions.find(region => region.kind === 'groupFooter') };
  };
  const asItem = (region: PageRegionDefinition, record: ViewRecord, key: Scalar[]): SourceItem => {
    const doc = template.worksheets.find(sheet => sheet.worksheetId === region.worksheetId)!.document;
    return { regionId: region.regionId, viewId: region.viewId!, record, groupKey: key, heights: sourceHeights(doc, region, record, parameters) };
  };
  const itemPixels = (item: SourceItem) => item.heights.reduce((sum, height) => sum + height, 0);
  const fits = (items: SourceItem[], final: boolean) => {
    const definition = definitionFor(pages.length - 1), detail = regionsFor(definition).detail;
    const doc = template.worksheets.find(sheet => sheet.worksheetId === detail.worksheetId)!.document;
    const available = capacity(definition, doc, bodyStart, final, detail);
    return cursor + items.reduce((sum, item) => sum + item.heights.length, 0) <= available.end
      && used + items.reduce((sum, item) => sum + itemPixels(item), 0) <= available.pixels;
  };
  const append = (item: SourceItem) => {
    const placed: FlowItem = { regionId: item.regionId, viewId: item.viewId, recordId: item.record.recordId, groupKey: item.groupKey,
      startRow: cursor, rowHeightsPx: item.heights };
    current!.flowItems!.push(placed); cursor += item.heights.length; used += itemPixels(item);
    if (item.regionId === mainDetail.regionId) {
      current!.allocations[0].recordIds.push(item.record.recordId); current!.allocations[0].groupKeys.push(item.groupKey);
    }
  };
  startPage();
  for (let groupIndex = 0; groupIndex < ordered.length; groupIndex++) {
    const group = ordered[groupIndex], finalGroup = groupIndex === ordered.length - 1;
    const build = (definition: PageDefinition, records: ViewRecord[], withHeader: boolean, withFooter: boolean) => {
      const regions = regionsFor(definition), result: SourceItem[] = [];
      if (withHeader && regions.header) result.push(asItem(regions.header, records[0], group.key));
      for (const record of records) result.push(asItem(regions.detail, record, group.key));
      if (withFooter && regions.footer) result.push(asItem(regions.footer, records[records.length - 1], group.key));
      return result;
    };
    const whole = build(definitionFor(pages.length - 1), group.records, true, true);
    if (!fits(whole, finalGroup && !appendices.length) && current!.flowItems!.length) startPage();
    const fresh = build(definitionFor(pages.length - 1), group.records, true, true);
    if (fits(fresh, finalGroup && !appendices.length)) { fresh.forEach(append); continue; }
    if (mainDetail.oversizedGroupPolicy !== 'split-records' && mainDetail.keepGroupsTogether !== false)
      fail('GROUP_TOO_LARGE', `业务组 ${encoded(group.key)} 超过单页流式高度`, mainDetail.regionId);
    let index = 0;
    while (index < group.records.length) {
      const definition = definitionFor(pages.length - 1), regions = regionsFor(definition);
      const firstOnPage = !current!.flowItems!.length || encoded(current!.flowItems!.at(-1)!.groupKey) !== encoded(group.key);
      const header = firstOnPage && regions.header ? asItem(regions.header, group.records[index], group.key) : undefined;
      const row = asItem(regions.detail, group.records[index], group.key);
      const lastRecord = index === group.records.length - 1;
      const footer = lastRecord && regions.footer ? asItem(regions.footer, row.record, group.key) : undefined;
      const attempt = [header, row, footer].filter((item): item is SourceItem => !!item);
      if (!fits(attempt, finalGroup && lastRecord && !appendices.length)) {
        if (!current!.flowItems!.length) fail('GROUP_TOO_LARGE', `流式页无法容纳组头、明细和组尾：${encoded(group.key)}`, mainDetail.regionId);
        startPage(); continue;
      }
      attempt.forEach(append); index++;
    }
  }
  for (const page of pages) {
    const definition = template.pageDefinitions!.find(item => item.pageDefinitionId === page.pageDefinitionId)!;
    const detail = regionsFor(definition).detail, doc = template.worksheets.find(sheet => sheet.worksheetId === detail.worksheetId)!.document;
    const start = Math.min(...definition.regions.filter(region => ['detail', 'groupHeader', 'groupFooter'].includes(region.kind)).map(region => region.rect.r));
    const end = capacity(definition, doc, start, page.pageNumber === pages.length && !appendices.length, detail).end;
    const heights = [...doc.rowHeightPx];
    for (let row = start; row < end; row++) heights[row] = 0.1;
    for (const item of page.flowItems!) item.rowHeightsPx.forEach((height, offset) => { heights[item.startRow + offset] = height; });
    page.rowHeightsPx = { [detail.worksheetId]: heights };
    page.blankRows[detail.regionId] = end - (page.flowItems!.at(-1)?.startRow ?? start) - (page.flowItems!.at(-1)?.rowHeightsPx.length ?? 0);
    page.pageGroupId = [...new Set(page.allocations[0].groupKeys.map(encoded))].join('|') || undefined;
  }
  // Appendices retain the existing deterministic fixed paginator and output path.
  let groupCount = ordered.length;
  for (const appendix of appendices) {
    const isolated: TemplatePackage = { ...template, pageDefinitions: [{ ...appendix, pageType: 'main', continuationOf: undefined,
      regions: appendix.regions.map(region => ({ ...region, appendixIfViewHasRecords: undefined })) }] };
    const appended = appendix.paginationMode === 'flow' ? planFlowPages(isolated, appendix.pageDefinitionId, viewResults, parameters)
      : planFixedPages(isolated, appendix.pageDefinitionId, viewResults);
    groupCount += appended.groupCount;
    for (const entry of appended.pages) pages.push({ ...entry, pageNumber: pages.length + 1, pageType: 'appendix' });
  }
  const result: PagePlan = { contractVersion: 2, templateId: template.packageId, templateVersion: template.revision,
    pages, totalPages: pages.length, groupCount };
  validateContract<PagePlan>('pagePlan', result);
  return result;
}
