import { ReportingError } from '../contracts/errors.ts';
import type { DataViewResult, PageDefinition, PagePlan, PagePlanEntry, PageRecordAllocation, PageRegionDefinition, Scalar, TemplatePackage, ViewRecord } from '../contracts/types.ts';
import { validateContract } from '../contracts/validate.ts';
import { validateTemplatePackage } from '../templates/package.ts';

export interface FixedPaginationOptions {
  maxIterations?: number;
  /** Optional page-dependent row capacity. Use this for first/last-page reserved content. */
  capacityRows?: (region: PageRegionDefinition, pageNumber: number, totalPagesGuess: number) => number;
}
interface RegionRows { region: PageRegionDefinition; view: DataViewResult; rowsByGroup: Map<string, ViewRecord[]>; keys: Map<string, Scalar[]> }
interface GroupChunk { groupKey: string; key: Scalar[]; records: Map<string, ViewRecord[]> }
interface SequencePage { groupKeys: string[]; records: Map<string, ViewRecord[]>; keys: Map<string, Scalar[][]> }

export function scalar(value: unknown, fieldId: string, viewId: string): Scalar {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  throw new ReportingError({ code: 'AMBIGUOUS_SCOPE', stage: 'layout', message: `分页字段 ${fieldId} 在视图 ${viewId} 中缺失或不是标量`, context: { fieldId, viewId } });
}
export function encoded(values: Scalar[]): string { return JSON.stringify(values); }
export function compare(a: Scalar, b: Scalar): number {
  if (a === b) return 0;
  if (a === null) return -1; if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), 'zh-CN', { numeric: true });
}
export function sortedRecords(records: ViewRecord[], region: PageRegionDefinition): ViewRecord[] {
  return [...records].sort((a, b) => {
    for (const order of region.orderBy ?? []) {
      const result = compare(scalar(a.values[order.fieldId], order.fieldId, region.viewId!), scalar(b.values[order.fieldId], order.fieldId, region.viewId!));
      if (result) return order.direction === 'asc' ? result : -result;
    }
    return a.recordId.localeCompare(b.recordId);
  });
}
function regionsFor(page: PageDefinition): PageRegionDefinition[] { return page.regions.filter(region => region.kind === 'detail'); }
function remainingCapacity(region: PageRegionDefinition, page: PageDefinition, pageNumber: number, guess: number,
  options: FixedPaginationOptions, template: TemplatePackage): number {
  const sheet = template.worksheets.find(item => item.worksheetId === region.worksheetId);
  const printEnd = page.printableRect ? page.printableRect.r + page.printableRect.rows : sheet?.document.rows ?? region.rect.r + region.rect.rows;
  const footerStart = page.regions.filter(item => item.worksheetId === region.worksheetId && item.kind === 'footer' && item.rect.r > region.rect.r)
    .reduce((end, item) => Math.min(end, item.rect.r), printEnd);
  const defaultRows = region.capacityRows ?? Math.max(1, footerStart - region.rect.r);
  const configured = options.capacityRows?.(region, pageNumber, guess) ?? defaultRows;
  const recordHeight = region.recordHeight ?? region.rect.rows;
  const capacity = Math.floor(configured / recordHeight);
  if (!Number.isInteger(configured) || configured < 1 || capacity < 1)
    throw new ReportingError({ code: 'LAYOUT_OVERFLOW', stage: 'layout', message: `区域 ${region.label} 的可用容量不足一条记录`, context: { regionId: region.regionId, pageNumber } });
  return capacity;
}
function groupRegions(page: PageDefinition, views: Map<string, DataViewResult>): RegionRows[] {
  const regions = regionsFor(page);
  for (const region of regions) if (!region.viewId || !region.paginationGroupId || !region.groupBy?.length)
    throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: `明细区域 ${region.regionId} 缺少视图、分页组或组键`, context: { regionId: region.regionId } });
  const byPaginationGroup = new Map<string, PageRegionDefinition[]>();
  for (const region of regions) { const items = byPaginationGroup.get(region.paginationGroupId!) ?? []; items.push(region); byPaginationGroup.set(region.paginationGroupId!, items); }
  for (const linked of byPaginationGroup.values()) {
    const groupFields = JSON.stringify(linked[0].groupBy);
    for (const region of linked.slice(1)) if (JSON.stringify(region.groupBy) !== groupFields)
      throw new ReportingError({ code: 'AMBIGUOUS_SCOPE', stage: 'layout', message: `联动区域 ${region.regionId} 与 ${linked[0].regionId} 的业务组键不一致`, context: { regionId: region.regionId } });
  }
  return regions.map(region => {
    const view = views.get(region.viewId!);
    if (!view) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'layout', message: `找不到分页视图 ${region.viewId}`, context: { regionId: region.regionId, viewId: region.viewId } });
    const rowsByGroup = new Map<string, ViewRecord[]>(), keys = new Map<string, Scalar[]>();
    for (const record of sortedRecords(view.records, region)) {
      const key = region.groupBy!.map(field => scalar(record.values[field], field, view.viewId));
      const id = encoded(key); keys.set(id, key);
      const rows = rowsByGroup.get(id) ?? []; rows.push(record); rowsByGroup.set(id, rows);
    }
    if (region.emptyPolicy === 'hide' && view.records.length === 0) rowsByGroup.clear();
    return { region, view, rowsByGroup, keys };
  });
}
function buildSequence(page: PageDefinition, views: Map<string, DataViewResult>, totalGuess: number,
  options: FixedPaginationOptions, template: TemplatePackage, continuation?: PageDefinition): { pages: SequencePage[]; groupCount: number; regions: RegionRows[] } {
  const regions = groupRegions(page, views);
  if (!regions.length) return { pages: [{ groupKeys: [], records: new Map(), keys: new Map() }], groupCount: 0, regions };
  const sets = new Map<string, RegionRows[]>();
  for (const item of regions) { const set = sets.get(item.region.paginationGroupId!) ?? []; set.push(item); sets.set(item.region.paginationGroupId!, set); }
  const output: SequencePage[] = [];
  const pageCountBefore = () => Math.max(1, output.length + 1);
  for (const [paginationGroupId, linked] of sets) {
    const orderedGroupIds = [...new Set(linked.flatMap(item => [...item.rowsByGroup.keys()]))].sort((left, right) => {
      const leftKey = linked.find(item => item.keys.has(left))!.keys.get(left)!;
      const rightKey = linked.find(item => item.keys.has(right))!.keys.get(right)!;
      for (let index = 0; index < leftKey.length; index++) {
        const order = compare(leftKey[index], rightKey[index]);
        if (order) return order;
      }
      return 0;
    });
    let current: SequencePage | undefined;
    let occupied = new Map<string, number>();
    const newPage = () => {
      current = { groupKeys: [], records: new Map(linked.map(item => [item.region.regionId, []])), keys: new Map(linked.map(item => [item.region.regionId, []])) };
      output.push(current); occupied = new Map(linked.map(item => [item.region.regionId, 0]));
    };
    const currentCapacity = (item: RegionRows) => {
      const pageNumber = pageCountBefore();
      const activeDefinition = pageNumber > 1 ? continuation ?? page : page;
      const activeRegion = activeDefinition.regions.find(region => region.regionId === item.region.regionId) ?? item.region;
      return remainingCapacity(activeRegion, activeDefinition, pageNumber, totalGuess, options, template);
    };
    const take = (keyId: string): Map<string, ViewRecord[]> => {
      const result = new Map<string, ViewRecord[]>();
      for (const item of linked) {
        const rows = item.rowsByGroup.get(keyId) ?? [];
        result.set(item.region.regionId, rows.slice(0, currentCapacity(item)));
      }
      return result;
    };
    const canFit = (records: Map<string, ViewRecord[]>) => linked.every(item =>
      (occupied.get(item.region.regionId) ?? 0) + (records.get(item.region.regionId)?.length ?? 0) <= currentCapacity(item));
    const add = (keyId: string, chunk: Map<string, ViewRecord[]>) => {
      if (!current) newPage();
      current!.groupKeys.push(`${paginationGroupId}:${keyId}`);
      for (const item of linked) {
        const id = item.region.regionId, rows = chunk.get(id) ?? [];
        current!.records.get(id)!.push(...rows); current!.keys.get(id)!.push(...rows.map(() => item.keys.get(keyId)!));
        occupied.set(id, (occupied.get(id) ?? 0) + rows.length);
      }
    };
    for (const keyId of orderedGroupIds) {
      const counts = linked.map(item => ({ item, count: item.rowsByGroup.get(keyId)?.length ?? 0 }));
      if (counts.every(item => item.count === 0)) continue;
      const oversizedRegions = counts.filter(({ item, count }) => count > currentCapacity(item));
      const maySplit = oversizedRegions.length > 0 && oversizedRegions.every(({ item }) =>
        item.region.oversizedGroupPolicy === 'split-records' || item.region.keepGroupsTogether === false);
      if (oversizedRegions.length && !maySplit)
        throw new ReportingError({ code: 'GROUP_TOO_LARGE', stage: 'layout', message: `业务组 ${keyId} 超出单页容量，未配置允许按记录续页`, context: { pageDefinitionId: page.pageDefinitionId, pageGroupId: paginationGroupId } });
      if (oversizedRegions.length && current?.groupKeys.length) newPage();
      if (oversizedRegions.length) {
        const maxChunks = Math.max(...counts.map(({ count }) => count));
        const offsets = new Map(linked.map(item => [item.region.regionId, 0]));
        for (let chunkIndex = 0; chunkIndex < maxChunks; chunkIndex++) {
          if (counts.every(({ item, count }) => (offsets.get(item.region.regionId) ?? 0) >= count)) break;
          if (chunkIndex > 0) newPage();
          const chunk = new Map<string, ViewRecord[]>();
          for (const item of linked) {
            const rows = item.rowsByGroup.get(keyId) ?? [], start = offsets.get(item.region.regionId) ?? 0;
            const slice = rows.slice(start, start + currentCapacity(item));
            chunk.set(item.region.regionId, slice); offsets.set(item.region.regionId, start + slice.length);
          }
          if (!canFit(chunk)) throw new ReportingError({ code: 'GROUP_TOO_LARGE', stage: 'layout', message: `业务组 ${keyId} 的续页片段仍超过区域容量`, context: { pageDefinitionId: page.pageDefinitionId, pageGroupId: paginationGroupId } });
          add(keyId, chunk);
        }
        continue;
      }
      let candidate = take(keyId);
      if (!current) newPage();
      if (canFit(candidate)) { add(keyId, candidate); continue; }
      if (current && current.groupKeys.length) { newPage(); candidate = take(keyId); }
      if (canFit(candidate)) { add(keyId, candidate); continue; }
      throw new ReportingError({ code: 'GROUP_TOO_LARGE', stage: 'layout', message: `业务组 ${keyId} 无法放入可用分页区域`, context: { pageDefinitionId: page.pageDefinitionId, pageGroupId: paginationGroupId } });
    }
    // An empty dataset still reserves its configured page/region when policy is keep.
    if (!orderedGroupIds.length && linked.some(item => item.region.emptyPolicy !== 'hide') && !output.length) newPage();
  }
  return { pages: output.length ? output : [{ groupKeys: [], records: new Map(), keys: new Map() }], groupCount: new Set(output.flatMap(item => item.groupKeys)).size, regions };
}

/** Deterministic fixed-layout paginator. It never mutates input data or writes back business keys. */
export function planFixedPages(template: TemplatePackage, mainPageDefinitionId: string,
  viewResults: DataViewResult[], options: FixedPaginationOptions = {}): PagePlan {
  validateTemplatePackage(template);
  const main = template.pageDefinitions?.find(page => page.pageDefinitionId === mainPageDefinitionId);
  if (!main) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'layout', message: `页面定义不存在：${mainPageDefinitionId}` });
  if (main.pageType !== 'main') throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: '分页入口必须是主页面定义', context: { pageDefinitionId: mainPageDefinitionId } });
  if (main.paginationMode === 'flow') throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'layout', message: '流式模板必须使用流式分页入口' });
  const continuation = template.pageDefinitions?.find(page => page.pageType === 'continuation' && page.continuationOf === main.pageDefinitionId);
  const views = new Map(viewResults.map(view => [view.viewId, view]));
  if (views.size !== viewResults.length) throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'layout', message: '分页视图 ID 重复' });
  const maxIterations = options.maxIterations ?? 8;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new Error('maxIterations 必须是正整数');
  let guess = 1, mainSequence: ReturnType<typeof buildSequence> | undefined;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    mainSequence = buildSequence(main, views, guess, options, template, continuation);
    const next = mainSequence.pages.length;
    if (next === guess) break;
    if (iteration === maxIterations - 1) throw new ReportingError({ code: 'PAGE_PLAN_NOT_CONVERGED', stage: 'layout', message: `分页计划在 ${maxIterations} 次计算后未收敛` });
    guess = next;
  }
  if (!mainSequence) throw new Error('无法建立分页计划');
  const pageEntries: PagePlanEntry[] = [];
  const addSequence = (definition: PageDefinition, sequence: ReturnType<typeof buildSequence>, pageType = definition.pageType) => {
    for (let index = 0; index < sequence.pages.length; index++) {
      const sequencePage = sequence.pages[index];
      const pageNumber = pageEntries.length + 1;
      const actualDefinition = definition.pageType === 'main' && index > 0 && continuation ? continuation : definition;
      const allocations: PageRecordAllocation[] = sequence.regions.map(({ region }) => {
        const recordIds = sequencePage.records.get(region.regionId) ?? [];
        const groupKeys = sequencePage.keys.get(region.regionId) ?? [];
        const pageRegion = actualDefinition.regions.find(item => item.regionId === region.regionId) ?? region;
        const recordHeight = pageRegion.recordHeight ?? pageRegion.rect.rows;
        return { regionId: region.regionId, viewId: region.viewId!, recordIds: recordIds.map(record => record.recordId), groupKeys,
          startRow: pageRegion.rect.r, recordHeight };
      });
      const blankRows: Record<string, number> = {};
      for (const region of sequence.regions) {
        const pageRegion = actualDefinition.regions.find(item => item.regionId === region.region.regionId) ?? region.region;
        const capacityRows = remainingCapacity(pageRegion, actualDefinition, pageNumber, pageEntries.length + sequence.pages.length, options, template);
        const used = (sequencePage.records.get(region.region.regionId)?.length ?? 0) * (pageRegion.recordHeight ?? pageRegion.rect.rows);
        blankRows[region.region.regionId] = Math.max(0, capacityRows - used);
      }
      pageEntries.push({ pageNumber, pageType: actualDefinition.pageType ?? pageType, pageDefinitionId: actualDefinition.pageDefinitionId,
        pageGroupId: sequencePage.groupKeys.join('|') || undefined, worksheetIds: actualDefinition.worksheetIds,
        allocations, blankRows, diagnostics: [] });
    }
  };
  addSequence(main, mainSequence);
  let groupCount = mainSequence.groupCount;
  const appendices = (template.pageDefinitions ?? []).filter(page => page.pageType === 'appendix' && (!page.continuationOf || page.continuationOf === main.pageDefinitionId));
  for (const appendix of appendices) {
    const conditionView = appendix.regions.find(region => region.appendixIfViewHasRecords)?.appendixIfViewHasRecords;
    if (appendix.regions.some(region => region.appendixIfViewHasRecords)) {
      const condition = conditionView ? views.get(conditionView) : undefined;
      if (!condition) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'layout', message: `附页条件视图不存在：${conditionView ?? '(未指定)'}`, context: { pageDefinitionId: appendix.pageDefinitionId, viewId: conditionView } });
      if (!condition.records.length) continue;
    }
    const seq = buildSequence(appendix, views, 1, options, template);
    groupCount += seq.groupCount;
    addSequence(appendix, seq, 'appendix');
  }
  const result: PagePlan = { contractVersion: 2, templateId: template.packageId, templateVersion: template.revision,
    pages: pageEntries.map((page, index) => ({ ...page, pageNumber: index + 1 })), totalPages: pageEntries.length,
    groupCount };
  validateContract<PagePlan>('pagePlan', result);
  return result;
}
