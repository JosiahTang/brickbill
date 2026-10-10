import type ExcelJS from 'exceljs';
import type { GenerationSnapshot, Scalar } from '../contracts/types.ts';
import type { GenerationOutputExpectation, ProjectComparisonIssue } from './comparison.ts';

export interface GenerationOutputComparison {
  passed: boolean;
  issueCount: number;
  issues: ProjectComparisonIssue[];
}

type WorkbookCellType = NonNullable<import('./comparison.ts').XlsxCellExpectation['type']>;
const cellTypes: Record<number, WorkbookCellType> = {
  0: 'blank', 1: 'merge', 2: 'number', 3: 'string', 4: 'date', 5: 'hyperlink',
  6: 'formula', 7: 'sharedString', 8: 'richText', 9: 'boolean', 10: 'error',
};

function stableJson(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function scalarValue(value: unknown): Scalar {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return value as Scalar;
  if (value instanceof Date) return value.toISOString();
  return stableJson(value);
}

function sortedKey(key: Record<string, Scalar>, keyFields: string[]): Record<string, Scalar> {
  return Object.fromEntries(keyFields.map(field => [field, key[field]]));
}

function imageAnchor(image: { range: { tl: { col: number; row: number }; br: { col: number; row: number } } }): {
  tl: { col: number; row: number }; br: { col: number; row: number };
} {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    tl: { col: round(image.range.tl.col), row: round(image.range.tl.row) },
    br: { col: round(image.range.br.col), row: round(image.range.br.row) },
  };
}

/** Compares a persisted generation and its reopened XLSX with an independent business baseline. */
export function compareGenerationOutput(
  caseId: string,
  expected: GenerationOutputExpectation,
  projectId: string,
  businessKey: Record<string, Scalar>,
  snapshot: GenerationSnapshot,
  bytes: Uint8Array,
  workbook: ExcelJS.Workbook,
  outputSha256: string,
): GenerationOutputComparison {
  const issues: ProjectComparisonIssue[] = [];
  const add = (scope: ProjectComparisonIssue['scope'], targetId: string, code: string, message: string,
    details: Partial<Pick<ProjectComparisonIssue, 'expected' | 'actual' | 'pageNumber' | 'regionId' | 'viewId' | 'sheet' | 'address'>> = {}) => {
    issues.push({ caseId, scope, targetId, code, message, generationId: expected.generationId, ...details });
  };

  if (snapshot.generationId !== expected.generationId)
    add('generation', 'generationId', 'GENERATION_ID_MISMATCH', '快照 generationId 与套件引用不一致', { expected: expected.generationId, actual: snapshot.generationId });
  if (snapshot.projectId !== projectId)
    add('generation', 'projectId', 'PROJECT_MISMATCH', '生成记录所属项目与对照套件不一致', { expected: projectId, actual: snapshot.projectId });
  if (stableJson(snapshot.businessKey) !== stableJson(businessKey))
    add('generation', 'businessKey', 'BUSINESS_KEY_MISMATCH', '生成记录业务键与对照用例不一致', { expected: stableJson(businessKey), actual: stableJson(snapshot.businessKey) });
  if (expected.templateRef && (snapshot.templateRef.packageId !== expected.templateRef.packageId
    || snapshot.templateRef.revision !== expected.templateRef.revision))
    add('generation', 'templateRef', 'TEMPLATE_VERSION_MISMATCH', '生成记录模板标识或版本与业务基准不一致', {
      expected: `${expected.templateRef.packageId}@${expected.templateRef.revision}`,
      actual: `${snapshot.templateRef.packageId}@${snapshot.templateRef.revision}`,
    });
  if (!snapshot.output) add('generation', 'output', 'OUTPUT_METADATA_MISSING', '生成快照没有 XLSX 完整性元数据');
  else {
    if (snapshot.output.byteLength !== bytes.byteLength)
      add('generation', 'output.byteLength', 'OUTPUT_LENGTH_MISMATCH', 'XLSX 字节数与生成快照不一致', { expected: snapshot.output.byteLength, actual: bytes.byteLength });
    if (snapshot.output.sha256 !== outputSha256)
      add('generation', 'output.sha256', 'OUTPUT_HASH_MISMATCH', 'XLSX SHA-256 与生成快照不一致', { expected: snapshot.output.sha256, actual: outputSha256 });
  }

  const plan = snapshot.pagePlan;
  if (!plan) add('page', 'pagePlan', 'PAGE_PLAN_MISSING', '生成快照没有分页计划');
  else {
    if (plan.totalPages !== plan.pages.length)
      add('page', 'pageCount', 'INVALID_PAGE_PLAN', '分页计划总页数与页面列表数量不一致', { expected: plan.totalPages, actual: plan.pages.length });
    if (expected.pageCount !== undefined && expected.pageCount !== plan.totalPages)
      add('page', 'pageCount', 'PAGE_COUNT_MISMATCH', '总页数与业务基准不一致', { expected: expected.pageCount, actual: plan.totalPages });
    if (expected.pageTypes && stableJson(expected.pageTypes) !== stableJson(plan.pages.map(page => page.pageType)))
      add('page', 'pageTypes', 'PAGE_TYPES_MISMATCH', '页面类型或顺序与业务基准不一致', {
        expected: stableJson(expected.pageTypes), actual: stableJson(plan.pages.map(page => page.pageType)),
      });
    if (expected.pages) {
      if (expected.pages.length !== plan.pages.length)
        add('page', 'pages', 'PAGE_LIST_MISMATCH', '实际页面列表数量与业务基准不一致', { expected: expected.pages.length, actual: plan.pages.length });
      const viewById = new Map(snapshot.viewResults.map(view => [view.viewId, view]));
      const recordKeysByRegion = new Map<string, number>();
      for (const [index, expectedPage] of expected.pages.entries()) {
        const actualPage = plan.pages[index];
        if (!actualPage) continue;
        if (actualPage.pageNumber !== expectedPage.pageNumber)
          add('page', `page:${expectedPage.pageNumber}`, 'PAGE_NUMBER_MISMATCH', '页面顺序或连续页码与业务基准不一致', {
            pageNumber: expectedPage.pageNumber, expected: expectedPage.pageNumber, actual: actualPage.pageNumber,
          });
        if (actualPage.pageNumber !== index + 1)
          add('page', `page:${actualPage.pageNumber}`, 'PAGE_NUMBER_NOT_CONTIGUOUS', '实际分页计划页码不连续', {
            pageNumber: actualPage.pageNumber, expected: index + 1, actual: actualPage.pageNumber,
          });
        if (actualPage.pageType !== expectedPage.pageType)
          add('page', `page:${expectedPage.pageNumber}`, 'PAGE_TYPE_MISMATCH', '页面类型或顺序与业务基准不一致', {
            pageNumber: expectedPage.pageNumber, expected: expectedPage.pageType, actual: actualPage.pageType,
          });
        const expectedAllocations = expectedPage.allocations;
        const actualAllocations = actualPage.allocations;
        if (expectedPage.exactAllocations && actualAllocations.length !== expectedAllocations.length)
          add('page', `page:${expectedPage.pageNumber}`, 'REGION_ALLOCATION_COUNT_MISMATCH', '页面明细区域数量与业务基准不一致', {
            pageNumber: expectedPage.pageNumber, expected: expectedAllocations.length, actual: actualAllocations.length,
          });
        for (const expectedAllocation of expectedAllocations) {
          const targetId = `${expectedAllocation.regionId}/${expectedAllocation.viewId}`;
          const matching = actualAllocations.filter(item => item.regionId === expectedAllocation.regionId && item.viewId === expectedAllocation.viewId);
          if (matching.length !== 1) {
            add('region', targetId, matching.length ? 'DUPLICATE_REGION_ALLOCATION' : 'REGION_ALLOCATION_MISSING',
              matching.length ? '页面包含重复的区域分配' : '页面缺少预期明细区域分配', {
                pageNumber: expectedPage.pageNumber, regionId: expectedAllocation.regionId, viewId: expectedAllocation.viewId,
                expected: 1, actual: matching.length,
              });
            continue;
          }
          const view = viewById.get(expectedAllocation.viewId);
          if (!view) {
            add('region', targetId, 'VIEW_RESULT_MISSING', '分页区域引用的视图结果不存在', {
              pageNumber: expectedPage.pageNumber, regionId: expectedAllocation.regionId, viewId: expectedAllocation.viewId,
            });
            continue;
          }
          const recordsById = new Map(view.records.map(record => [record.recordId, record]));
          const actualKeys: Array<Record<string, Scalar>> = [];
          const seenKeys = new Set<string>();
          for (const recordId of matching[0].recordIds) {
            const record = recordsById.get(recordId);
            if (!record) {
              add('region', targetId, 'ALLOCATED_RECORD_MISSING', `分页分配引用了不存在的视图记录 ${recordId}`, {
                pageNumber: expectedPage.pageNumber, regionId: expectedAllocation.regionId, viewId: expectedAllocation.viewId,
              });
              continue;
            }
            const key: Record<string, Scalar> = {};
            let valid = true;
            for (const field of expectedAllocation.keyFields) {
              const value = record.values[field];
              if (value === undefined || value === null || value === '') { valid = false; break; }
              key[field] = value;
            }
            if (!valid) {
              add('region', targetId, 'INVALID_ALLOCATED_RECORD_KEY', '已分配记录缺少基准所声明的业务键', {
                pageNumber: expectedPage.pageNumber, regionId: expectedAllocation.regionId, viewId: expectedAllocation.viewId,
              });
              continue;
            }
            const orderedKey = sortedKey(key, expectedAllocation.keyFields);
            const encodedKey = stableJson(orderedKey);
            if (seenKeys.has(encodedKey))
              add('region', targetId, 'DUPLICATE_PAGE_RECORD_KEY', '同一明细区域内出现重复业务记录键', {
                pageNumber: expectedPage.pageNumber, regionId: expectedAllocation.regionId, viewId: expectedAllocation.viewId,
                actual: encodedKey,
              });
            seenKeys.add(encodedKey);
            const regionKey = `${targetId}\u0000${encodedKey}`;
            const priorPage = recordKeysByRegion.get(regionKey);
            if (priorPage !== undefined)
              add('region', targetId, 'DUPLICATE_RECORD_ACROSS_PAGES', `同一明细记录重复分配到第 ${priorPage} 页和第 ${expectedPage.pageNumber} 页`, {
                pageNumber: expectedPage.pageNumber, regionId: expectedAllocation.regionId, viewId: expectedAllocation.viewId,
                actual: encodedKey,
              });
            else recordKeysByRegion.set(regionKey, expectedPage.pageNumber);
            actualKeys.push(orderedKey);
          }
          const expectedKeys = expectedAllocation.recordKeys.map(key => sortedKey(key, expectedAllocation.keyFields));
          if (stableJson(actualKeys) !== stableJson(expectedKeys))
            add('region', targetId, 'REGION_RECORD_KEYS_MISMATCH', '区域分配的业务记录键或顺序与基准不一致', {
              pageNumber: expectedPage.pageNumber, regionId: expectedAllocation.regionId, viewId: expectedAllocation.viewId,
              expected: stableJson(expectedKeys), actual: stableJson(actualKeys),
            });
        }
        if (expectedPage.exactAllocations) for (const actualAllocation of actualAllocations) {
          if (!expectedAllocations.some(item => item.regionId === actualAllocation.regionId && item.viewId === actualAllocation.viewId))
            add('region', `${actualAllocation.regionId}/${actualAllocation.viewId}`, 'UNEXPECTED_REGION_ALLOCATION', '页面出现未列入基准的明细区域分配', {
              pageNumber: expectedPage.pageNumber, regionId: actualAllocation.regionId, viewId: actualAllocation.viewId,
            });
        }
      }
    }
  }

  const xlsx = expected.xlsx;
  if (xlsx) {
    const sheets = workbook.worksheets;
    const sheetNames = sheets.map(sheet => sheet.name);
    if (xlsx.worksheets && stableJson(xlsx.worksheets) !== stableJson(sheetNames))
      add('xlsx', 'worksheets', 'WORKSHEET_ORDER_MISMATCH', '工作表名称或顺序与业务基准不一致', {
        expected: stableJson(xlsx.worksheets), actual: stableJson(sheetNames),
      });
    const getSheet = (sheetName: string, targetId: string): ExcelJS.Worksheet | undefined => {
      const sheet = workbook.getWorksheet(sheetName);
      if (!sheet) add('xlsx', targetId, 'WORKSHEET_NOT_FOUND', `未找到工作表 ${sheetName}`, { sheet: sheetName });
      return sheet;
    };
    for (const cellExpected of xlsx.cells ?? []) {
      const targetId = `${cellExpected.sheet}!${cellExpected.address}`;
      const sheet = getSheet(cellExpected.sheet, targetId);
      if (!sheet) continue;
      const cell = sheet.getCell(cellExpected.address);
      const actualValue = scalarValue(cell.value);
      if (actualValue !== cellExpected.value)
        add('xlsx', targetId, 'CELL_VALUE_MISMATCH', 'Excel 单元格值与业务基准不一致', {
          sheet: cellExpected.sheet, address: cellExpected.address, expected: cellExpected.value, actual: actualValue,
        });
      if (cellExpected.type !== undefined && cellTypes[cell.type] !== cellExpected.type)
        add('xlsx', targetId, 'CELL_TYPE_MISMATCH', 'Excel 单元格类型与业务基准不一致', {
          sheet: cellExpected.sheet, address: cellExpected.address, expected: cellExpected.type, actual: cellTypes[cell.type] ?? 'unknown',
        });
      if (cellExpected.numFmt !== undefined && cell.numFmt !== cellExpected.numFmt)
        add('xlsx', targetId, 'CELL_NUMBER_FORMAT_MISMATCH', 'Excel 单元格数字格式与业务基准不一致', {
          sheet: cellExpected.sheet, address: cellExpected.address, expected: cellExpected.numFmt, actual: cell.numFmt,
        });
    }
    for (const mergeExpected of xlsx.merges ?? []) {
      const sheet = getSheet(mergeExpected.sheet, `merges:${mergeExpected.sheet}`);
      if (!sheet) continue;
      const actualRanges = [...(sheet.model.merges ?? [])].sort();
      const expectedRanges = [...mergeExpected.ranges].sort();
      if (stableJson(actualRanges) !== stableJson(expectedRanges))
        add('xlsx', `merges:${mergeExpected.sheet}`, 'MERGE_RANGES_MISMATCH', '工作表合并区域与业务基准不一致', {
          sheet: mergeExpected.sheet, expected: stableJson(expectedRanges), actual: stableJson(actualRanges),
        });
    }
    for (const imageExpected of xlsx.images ?? []) {
      const sheet = getSheet(imageExpected.sheet, `images:${imageExpected.sheet}`);
      if (!sheet) continue;
      const images = sheet.getImages();
      if (images.length !== imageExpected.count)
        add('xlsx', `images:${imageExpected.sheet}`, 'IMAGE_COUNT_MISMATCH', '工作表图片数量与业务基准不一致', {
          sheet: imageExpected.sheet, expected: imageExpected.count, actual: images.length,
        });
      if (imageExpected.anchors) {
        const actualAnchors = images.map(imageAnchor);
        const expectedAnchors = imageExpected.anchors.map(anchor => ({
          tl: { col: Math.round(anchor.tl.col * 1000) / 1000, row: Math.round(anchor.tl.row * 1000) / 1000 },
          ...(anchor.br ? { br: { col: Math.round(anchor.br.col * 1000) / 1000, row: Math.round(anchor.br.row * 1000) / 1000 } } : {}),
        }));
        const projectedActual = actualAnchors.map((anchor, index) => imageExpected.anchors?.[index]?.br ? anchor : { tl: anchor.tl });
        if (stableJson(projectedActual) !== stableJson(expectedAnchors))
          add('xlsx', `images:${imageExpected.sheet}`, 'IMAGE_ANCHOR_MISMATCH', '工作表图片锚点与业务基准不一致', {
            sheet: imageExpected.sheet, expected: stableJson(expectedAnchors), actual: stableJson(projectedActual),
          });
      }
    }
    for (const setupExpected of xlsx.pageSetup ?? []) {
      const sheet = getSheet(setupExpected.sheet, `pageSetup:${setupExpected.sheet}`);
      if (!sheet) continue;
      const actual = {
        ...(setupExpected.orientation !== undefined ? { orientation: sheet.pageSetup.orientation } : {}),
        ...(setupExpected.paperSize !== undefined ? { paperSize: sheet.pageSetup.paperSize } : {}),
        ...(setupExpected.printArea !== undefined ? { printArea: sheet.pageSetup.printArea } : {}),
      };
      const expectedSetup = {
        ...(setupExpected.orientation !== undefined ? { orientation: setupExpected.orientation } : {}),
        ...(setupExpected.paperSize !== undefined ? { paperSize: setupExpected.paperSize } : {}),
        ...(setupExpected.printArea !== undefined ? { printArea: setupExpected.printArea } : {}),
      };
      if (stableJson(actual) !== stableJson(expectedSetup))
        add('xlsx', `pageSetup:${setupExpected.sheet}`, 'PAGE_SETUP_MISMATCH', '工作表方向、纸张或打印区域与业务基准不一致', {
          sheet: setupExpected.sheet, expected: stableJson(expectedSetup), actual: stableJson(actual),
        });
    }
  }

  return { passed: issues.length === 0, issueCount: issues.length, issues };
}
