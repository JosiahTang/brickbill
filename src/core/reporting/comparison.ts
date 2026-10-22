import { encodeCompositeKey } from '../adapters/project-adapter.ts';
import { ReportingError } from '../contracts/errors.ts';
import type { ContractErrorCode, DataRecord, DatasetBundle, DataViewResult, Scalar } from '../contracts/types.ts';

export interface ExpectedComparisonRecord {
  key: Record<string, Scalar>;
  values: Record<string, Scalar>;
}

export interface ProjectComparisonAssertion {
  scope: 'dataset' | 'view';
  targetId: string;
  expectedCount?: number;
  keyFields?: string[];
  records?: ExpectedComparisonRecord[];
  exactRecordSet?: boolean;
  expectedOrder?: Array<Record<string, Scalar>>;
  numericTolerance?: number;
}

export interface GenerationTemplateExpectation { packageId: string; revision: number }
export interface GenerationAllocationExpectation {
  regionId: string;
  viewId: string;
  keyFields: string[];
  recordKeys: Array<Record<string, Scalar>>;
}
export interface GenerationPageExpectation {
  pageNumber: number;
  pageType: string;
  allocations: GenerationAllocationExpectation[];
  exactAllocations?: boolean;
}
export interface XlsxCellExpectation {
  sheet: string;
  address: string;
  value: Scalar;
  type?: 'blank' | 'number' | 'string' | 'date' | 'hyperlink' | 'formula' | 'sharedString' | 'richText' | 'boolean' | 'error' | 'merge';
  numFmt?: string;
}
export interface XlsxMergeExpectation { sheet: string; ranges: string[] }
export interface XlsxImageExpectation {
  sheet: string;
  count: number;
  anchors?: Array<{ tl: { col: number; row: number }; br?: { col: number; row: number } }>;
  /** Suite v2: encoded image bytes in worksheet placement order, not the XLSX archive hash. */
  contentSha256?: string[];
}
export interface XlsxPageSetupExpectation {
  sheet: string;
  orientation?: 'portrait' | 'landscape';
  paperSize?: number | string;
  printArea?: string;
}
export interface XlsxOutputExpectation {
  worksheets?: string[];
  cells?: XlsxCellExpectation[];
  merges?: XlsxMergeExpectation[];
  images?: XlsxImageExpectation[];
  pageSetup?: XlsxPageSetupExpectation[];
}
export interface GenerationOutputExpectation {
  generationId: string;
  templateRef?: GenerationTemplateExpectation;
  pageCount?: number;
  pageTypes?: string[];
  pages?: GenerationPageExpectation[];
  xlsx?: XlsxOutputExpectation;
  templateMatch?: {
    documentType?: string;
    rule?: { conditions?: Record<string, string>; priority?: number };
    facts?: Record<string, { value?: string; datasetId?: string; fieldId?: string; recordCount?: number }>;
  };
  signoff?: { actorId: string };
}

export interface ProjectComparisonCase {
  caseId: string;
  documentType: string;
  businessKey: Record<string, string>;
  sourceSnapshot?: string;
  assertions: ProjectComparisonAssertion[];
  generation?: GenerationOutputExpectation;
  expectedError?: {
    code: Extract<ContractErrorCode, 'DATA_NOT_FOUND' | 'DUPLICATE_KEY' | 'RELATION_CARDINALITY_ERROR'
      | 'FIELD_NOT_FOUND' | 'VALUE_TYPE_ERROR' | 'VIEW_INVALID'>;
    stage: 'collect' | 'view';
    context?: Partial<Record<'datasetId' | 'fieldId' | 'viewId', string>>;
  };
}

export interface ProjectComparisonSuite {
  suiteVersion: 1 | 2;
  suiteId: string;
  projectId: string;
  baseline?: { sourceKind: 'synthetic' | 'customer'; referenceId: string; approvedBy?: string; approvedAt?: string };
  cases: ProjectComparisonCase[];
}

export interface ProjectComparisonIssue {
  caseId: string;
  scope: 'dataset' | 'view' | 'generation' | 'page' | 'region' | 'xlsx';
  targetId: string;
  code: string;
  message: string;
  recordKey?: Record<string, Scalar>;
  fieldId?: string;
  expected?: Scalar | Scalar[][];
  actual?: Scalar | Scalar[][];
  generationId?: string;
  pageNumber?: number;
  regionId?: string;
  viewId?: string;
  sheet?: string;
  address?: string;
}

export interface ProjectComparisonResult {
  passed: boolean;
  assertionCount: number;
  issueCount: number;
  assertions: Array<{ scope: 'dataset' | 'view'; targetId: string; passed: boolean; actualCount?: number }>;
  issues: ProjectComparisonIssue[];
}

function contractError(message: string): never {
  throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'contract', message });
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateScalarMap(value: unknown, label: string): value is Record<string, Scalar> {
  if (!object(value)) contractError(`${label} 必须是对象`);
  for (const [field, item] of Object.entries(value)) {
    if (!field || !isScalar(item)) contractError(`${label}.${field} 必须是有限标量值`);
  }
  return true;
}

function validateKeyFields(assertion: ProjectComparisonAssertion, label: string): void {
  const needsKey = assertion.records !== undefined || assertion.expectedOrder !== undefined;
  if (!assertion.keyFields) {
    if (needsKey) contractError(`${label} 声明记录或顺序时必须提供 keyFields`);
    return;
  }
  if (!Array.isArray(assertion.keyFields) || !assertion.keyFields.length
    || assertion.keyFields.some(field => typeof field !== 'string' || !field)
    || new Set(assertion.keyFields).size !== assertion.keyFields.length)
    contractError(`${label}.keyFields 必须是非空且不重复的字段标识列表`);
}

function validateRecordKey(key: unknown, fields: string[], label: string): key is Record<string, Scalar> {
  if (!validateScalarMap(key, label)) return false;
  const actualFields = Object.keys(key).sort();
  const expectedFields = [...fields].sort();
  if (JSON.stringify(actualFields) !== JSON.stringify(expectedFields))
    contractError(`${label} 必须且只能包含 keyFields 中声明的字段`);
  if (fields.some(field => key[field] == null || key[field] === ''))
    contractError(`${label} 的键值不能为空`);
  return true;
}

const xlsxCellTypes = ['blank', 'number', 'string', 'date', 'hyperlink', 'formula', 'sharedString', 'richText', 'boolean', 'error', 'merge'];

function validateGenerationExpectation(value: unknown, label: string, suiteVersion: 1 | 2): asserts value is GenerationOutputExpectation {
  if (!object(value) || typeof value.generationId !== 'string' || !value.generationId)
    contractError(`${label}.generation 必须提供非空 generationId`);
  if (value.templateRef !== undefined
    && (!object(value.templateRef) || typeof value.templateRef.packageId !== 'string' || !value.templateRef.packageId
      || !Number.isInteger(value.templateRef.revision) || Number(value.templateRef.revision) < 1))
    contractError(`${label}.generation.templateRef 必须包含 packageId 和正整数 revision`);
  if (value.pageCount !== undefined && (!Number.isInteger(value.pageCount) || Number(value.pageCount) < 1))
    contractError(`${label}.generation.pageCount 必须是正整数`);
  if (value.pageTypes !== undefined && (!Array.isArray(value.pageTypes) || !value.pageTypes.length
    || value.pageTypes.some((type: unknown) => typeof type !== 'string' || !type)))
    contractError(`${label}.generation.pageTypes 必须是非空页面类型序列`);
  if (value.pageTypes !== undefined && value.pageCount !== undefined && value.pageTypes.length !== value.pageCount)
    contractError(`${label}.generation.pageTypes 数量必须与 pageCount 一致`);
  if (value.pages !== undefined && (!Array.isArray(value.pages) || !value.pages.length))
    contractError(`${label}.generation.pages 必须是非空数组`);
  if (Array.isArray(value.pages)) {
    for (const [pageIndex, page] of value.pages.entries()) {
      if (!object(page) || page.pageNumber !== pageIndex + 1 || typeof page.pageType !== 'string' || !page.pageType
        || !Array.isArray(page.allocations) || (page.exactAllocations !== undefined && typeof page.exactAllocations !== 'boolean'))
        contractError(`${label}.generation.pages[${pageIndex}] 必须按顺序声明页码、页面类型和区域分配`);
      const allocationIds = new Set<string>();
      for (const [allocationIndex, allocation] of page.allocations.entries()) {
        const allocationLabel = `${label}.generation.pages[${pageIndex}].allocations[${allocationIndex}]`;
        if (!object(allocation) || typeof allocation.regionId !== 'string' || !allocation.regionId
          || typeof allocation.viewId !== 'string' || !allocation.viewId || !Array.isArray(allocation.keyFields)
          || !allocation.keyFields.length || !Array.isArray(allocation.recordKeys))
          contractError(`${allocationLabel} 必须包含 regionId、viewId、keyFields 和 recordKeys`);
        const allocationId = `${allocation.regionId}\u0000${allocation.viewId}`;
        if (allocationIds.has(allocationId)) contractError(`${allocationLabel} 的区域和视图重复`);
        allocationIds.add(allocationId);
        if (allocation.keyFields.some((field: unknown) => typeof field !== 'string' || !field)
          || new Set(allocation.keyFields).size !== allocation.keyFields.length)
          contractError(`${allocationLabel}.keyFields 必须是非空且不重复的字段标识`);
        const recordKeys = new Set<string>();
        for (const [keyIndex, key] of allocation.recordKeys.entries()) {
          validateRecordKey(key, allocation.keyFields, `${allocationLabel}.recordKeys[${keyIndex}]`);
          const encoded = encodeCompositeKey(allocation.keyFields.map(field => key[field]));
          if (recordKeys.has(encoded)) contractError(`${allocationLabel}.recordKeys 存在重复业务键`);
          recordKeys.add(encoded);
        }
      }
      if (!page.allocations.length) contractError(`${label}.generation.pages[${pageIndex}] 至少需要一个区域分配断言`);
    }
    if (value.pageCount !== undefined && value.pages.length !== value.pageCount)
      contractError(`${label}.generation.pages 数量必须与 pageCount 一致`);
    if (value.pageTypes !== undefined) {
      const pageTypes = value.pageTypes as unknown[];
      if (value.pages.some((page: GenerationPageExpectation, index: number) => page.pageType !== pageTypes[index]))
        contractError(`${label}.generation.pageTypes 必须与 pages 页面类型一致`);
    }
  }
  if (value.templateMatch !== undefined) {
    const expected = value.templateMatch;
    if (!object(expected)) contractError(label + '.generation.templateMatch 必须是对象');
    if (expected.documentType !== undefined && (typeof expected.documentType !== 'string' || !expected.documentType))
      contractError(label + '.generation.templateMatch.documentType 必须是非空文本');
    if (expected.rule !== undefined) {
      if (!object(expected.rule)
        || (expected.rule.priority !== undefined && !Number.isFinite(expected.rule.priority))
        || (expected.rule.conditions !== undefined && (!object(expected.rule.conditions)
          || Object.entries(expected.rule.conditions).some(([key, item]) => !key || typeof item !== 'string'))))
        contractError(label + '.generation.templateMatch.rule 格式无效');
    }
    if (expected.facts !== undefined) {
      if (!object(expected.facts) || Object.entries(expected.facts).some(([fact, value]) => !fact || !object(value)
        || Object.entries(value).some(([key, item]) => !['value', 'datasetId', 'fieldId', 'recordCount'].includes(key)
          || (key === 'recordCount' ? typeof item !== 'number' || !Number.isInteger(item) || item < 0 : typeof item !== 'string'))))
        contractError(label + '.generation.templateMatch.facts 格式无效');
    }
  }
  if (value.signoff !== undefined && (!object(value.signoff)
    || typeof value.signoff.actorId !== 'string' || !value.signoff.actorId.trim()))
    contractError(label + '.generation.signoff 必须包含非空 actorId');
  if (value.xlsx !== undefined) {
    const xlsx = value.xlsx;
    if (!object(xlsx)) contractError(`${label}.generation.xlsx 必须是对象`);
    let hasAssertion = false;
    if (xlsx.worksheets !== undefined) {
      hasAssertion = true;
      if (!Array.isArray(xlsx.worksheets) || !xlsx.worksheets.length || xlsx.worksheets.some((name: unknown) => typeof name !== 'string' || !name)
        || new Set(xlsx.worksheets).size !== xlsx.worksheets.length)
        contractError(`${label}.generation.xlsx.worksheets 必须是非空且唯一的工作表名列表`);
    }
    if (xlsx.cells !== undefined) {
      hasAssertion = true;
      if (!Array.isArray(xlsx.cells) || !xlsx.cells.length) contractError(`${label}.generation.xlsx.cells 必须是非空数组`);
      const cellIds = new Set<string>();
      for (const [index, cell] of xlsx.cells.entries()) {
        if (!object(cell) || typeof cell.sheet !== 'string' || !cell.sheet
          || typeof cell.address !== 'string' || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(cell.address)
          || !isScalar(cell.value) || (cell.type !== undefined && !xlsxCellTypes.includes(String(cell.type)))
          || (cell.numFmt !== undefined && typeof cell.numFmt !== 'string'))
          contractError(`${label}.generation.xlsx.cells[${index}] 的 sheet、A1 地址、标量值或格式无效`);
        const cellId = `${cell.sheet}\u0000${cell.address}`;
        if (cellIds.has(cellId)) contractError(`${label}.generation.xlsx.cells[${index}] 重复声明了工作表单元格`);
        cellIds.add(cellId);
      }
    }
    if (xlsx.merges !== undefined) {
      hasAssertion = true;
      if (!Array.isArray(xlsx.merges) || !xlsx.merges.length) contractError(`${label}.generation.xlsx.merges 必须是非空数组`);
      const mergeSheets = new Set<string>();
      for (const [index, merge] of xlsx.merges.entries()) {
        if (!object(merge) || typeof merge.sheet !== 'string' || !merge.sheet || !Array.isArray(merge.ranges)
          || merge.ranges.some((range: unknown) => typeof range !== 'string' || !/^[A-Z]{1,3}[1-9]\d{0,6}:[A-Z]{1,3}[1-9]\d{0,6}$/.test(range)))
          contractError(`${label}.generation.xlsx.merges[${index}] 必须包含工作表和 A1 合并区列表`);
        if (mergeSheets.has(merge.sheet)) contractError(`${label}.generation.xlsx.merges[${index}] 重复声明了工作表`);
        mergeSheets.add(merge.sheet);
      }
    }
    if (xlsx.images !== undefined) {
      hasAssertion = true;
      if (!Array.isArray(xlsx.images) || !xlsx.images.length) contractError(`${label}.generation.xlsx.images 必须是非空数组`);
      const imageSheets = new Set<string>();
      for (const [index, image] of xlsx.images.entries()) {
        if (!object(image) || typeof image.sheet !== 'string' || !image.sheet || typeof image.count !== 'number'
          || !Number.isInteger(image.count) || image.count < 0
          || (image.anchors !== undefined && (!Array.isArray(image.anchors) || image.anchors.length !== image.count)))
          contractError(`${label}.generation.xlsx.images[${index}] 必须声明工作表、数量及可选锚点`);
        if (imageSheets.has(image.sheet)) contractError(`${label}.generation.xlsx.images[${index}] 重复声明了工作表`);
        imageSheets.add(image.sheet);
        if (image.contentSha256 !== undefined) {
          if (suiteVersion !== 2) contractError(`${label}.generation.xlsx.images[${index}].contentSha256 需要对照套件 v2 版本`);
          if (!Array.isArray(image.contentSha256) || image.contentSha256.length !== image.count
            || image.contentSha256.some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)))
            contractError(`${label}.generation.xlsx.images[${index}].contentSha256 必须逐图声明 64 位小写 SHA-256`);
        }
        for (const anchor of (image.anchors ?? []) as unknown[]) {
          if (!object(anchor) || !object(anchor.tl)) contractError(`${label}.generation.xlsx.images[${index}] 存在无效图片锚点`);
          const tl = anchor.tl as Record<string, unknown>;
          const col = tl.col, row = tl.row;
          if (!finiteNumber(col) || !finiteNumber(row) || col < 0 || row < 0)
            contractError(`${label}.generation.xlsx.images[${index}] 存在无效图片锚点`);
          if (anchor.br !== undefined && !object(anchor.br))
            contractError(`${label}.generation.xlsx.images[${index}] 存在无效图片锚点`);
          if (anchor.br !== undefined) {
            const br = anchor.br as Record<string, unknown>;
            const brCol = br.col, brRow = br.row;
            if (!finiteNumber(brCol) || !finiteNumber(brRow) || brCol < col || brRow < row)
              contractError(`${label}.generation.xlsx.images[${index}] 存在无效图片锚点`);
          }
        }
      }
    }
    if (xlsx.pageSetup !== undefined) {
      hasAssertion = true;
      if (!Array.isArray(xlsx.pageSetup) || !xlsx.pageSetup.length) contractError(`${label}.generation.xlsx.pageSetup 必须是非空数组`);
      const setupSheets = new Set<string>();
      for (const [index, setup] of xlsx.pageSetup.entries()) {
        if (!object(setup) || typeof setup.sheet !== 'string' || !setup.sheet
          || (setup.orientation !== undefined && !['portrait', 'landscape'].includes(String(setup.orientation)))
          || (setup.paperSize !== undefined && typeof setup.paperSize !== 'string' && typeof setup.paperSize !== 'number')
          || (setup.printArea !== undefined && typeof setup.printArea !== 'string')
          || (setup.orientation === undefined && setup.paperSize === undefined && setup.printArea === undefined))
          contractError(`${label}.generation.xlsx.pageSetup[${index}] 格式无效`);
        if (setupSheets.has(setup.sheet)) contractError(`${label}.generation.xlsx.pageSetup[${index}] 重复声明了工作表`);
        setupSheets.add(setup.sheet);
      }
    }
    if (!hasAssertion) contractError(`${label}.generation.xlsx 至少需要一种工作表、单元格、合并区、图片或打印设置断言`);
  }
  if (value.templateRef === undefined && value.pageCount === undefined && value.pageTypes === undefined
    && value.pages === undefined && value.xlsx === undefined && value.templateMatch === undefined && value.signoff === undefined)
    contractError(`${label}.generation 至少需要模板、页面或 XLSX 预期`);
}

/** Validates the portable JSON suite used by both offline and online comparisons. */
export function validateProjectComparisonSuite(input: unknown): ProjectComparisonSuite {
  if (!object(input) || ![1, 2].includes(Number(input.suiteVersion)) || typeof input.suiteVersion !== 'number' || typeof input.suiteId !== 'string' || !input.suiteId
    || typeof input.projectId !== 'string' || !input.projectId || !Array.isArray(input.cases) || !input.cases.length)
    contractError('对照套件必须包含 suiteVersion=1 或 2、suiteId、projectId 和非空 cases');
  if (input.baseline !== undefined) {
    const baseline = input.baseline;
    if (!object(baseline) || !['synthetic', 'customer'].includes(String(baseline.sourceKind))
      || typeof baseline.referenceId !== 'string' || !baseline.referenceId.trim())
      contractError('对照套件 baseline 必须声明 sourceKind 和 referenceId');
    if (baseline.sourceKind === 'customer' && (typeof baseline.approvedBy !== 'string' || !baseline.approvedBy.trim()
      || typeof baseline.approvedAt !== 'string' || Number.isNaN(Date.parse(baseline.approvedAt))))
      contractError('客户对照基准必须记录 approvedBy 和有效 approvedAt');
  }
  const caseIds = new Set<string>();
  for (const candidate of input.cases) {
    if (!object(candidate) || typeof candidate.caseId !== 'string' || !candidate.caseId
      || typeof candidate.documentType !== 'string' || !candidate.documentType
      || !object(candidate.businessKey) || !Array.isArray(candidate.assertions)
      || (!candidate.assertions.length && candidate.generation === undefined && candidate.expectedError === undefined))
      contractError('每个对照用例必须包含 caseId、documentType、businessKey，以及数据断言、生成输出断言或预期业务错误');
    if (candidate.expectedError !== undefined) {
      const expectedError = candidate.expectedError as Record<string, unknown>;
      const allowedCodes = ['DATA_NOT_FOUND', 'DUPLICATE_KEY', 'RELATION_CARDINALITY_ERROR',
        'FIELD_NOT_FOUND', 'VALUE_TYPE_ERROR', 'VIEW_INVALID'];
      if (!object(expectedError) || !allowedCodes.includes(String(expectedError.code))
        || !['collect', 'view'].includes(String(expectedError.stage))
        || (candidate.assertions.length > 0 || candidate.generation !== undefined))
        contractError('用例 ' + candidate.caseId + ' 的 expectedError 必须只声明预期业务错误，不能同时声明正常输出断言');
      if (expectedError.context !== undefined) {
        const context = expectedError.context;
        if (!object(context) || Object.entries(context).some(([key, value]) =>
          !['datasetId', 'fieldId', 'viewId'].includes(key) || typeof value !== 'string' || !value))
          contractError('用例 ' + candidate.caseId + ' 的 expectedError.context 只支持非空 datasetId、fieldId、viewId');
      }
    }
    if (caseIds.has(candidate.caseId)) contractError(`对照用例标识重复：${candidate.caseId}`);
    caseIds.add(candidate.caseId);
    for (const [key, value] of Object.entries(candidate.businessKey))
      if (!key || typeof value !== 'string') contractError(`用例 ${candidate.caseId} 的业务键必须由字符串组成`);
    if (candidate.sourceSnapshot !== undefined
      && (typeof candidate.sourceSnapshot !== 'string' || !candidate.sourceSnapshot))
      contractError(`用例 ${candidate.caseId} 的 sourceSnapshot 必须是非空路径`);
    if (candidate.generation !== undefined) validateGenerationExpectation(candidate.generation, `用例 ${candidate.caseId}`, input.suiteVersion as 1 | 2);
    const assertionIds = new Set<string>();
    for (const rawAssertion of candidate.assertions) {
      if (!object(rawAssertion) || !['dataset', 'view'].includes(String(rawAssertion.scope))
        || typeof rawAssertion.targetId !== 'string' || !rawAssertion.targetId)
        contractError(`用例 ${candidate.caseId} 包含无效的对照目标`);
      const assertion = rawAssertion as unknown as ProjectComparisonAssertion;
      const label = `${candidate.caseId}/${assertion.scope}:${assertion.targetId}`;
      const assertionId = `${assertion.scope}:${assertion.targetId}`;
      if (assertionIds.has(assertionId)) contractError(`${label} 被重复声明`);
      assertionIds.add(assertionId);
      if (assertion.expectedCount !== undefined
        && (!Number.isInteger(assertion.expectedCount) || assertion.expectedCount < 0))
        contractError(`${label}.expectedCount 必须是非负整数`);
      if (assertion.numericTolerance !== undefined
        && (!Number.isFinite(assertion.numericTolerance) || assertion.numericTolerance < 0))
        contractError(`${label}.numericTolerance 必须是非负有限数字`);
      if (assertion.exactRecordSet !== undefined && typeof assertion.exactRecordSet !== 'boolean')
        contractError(`${label}.exactRecordSet 必须是布尔值`);
      if (assertion.exactRecordSet === true && assertion.records === undefined)
        contractError(`${label}.exactRecordSet 为 true 时必须提供 records`);
      if (assertion.records !== undefined && !Array.isArray(assertion.records))
        contractError(`${label}.records 必须是数组`);
      if (assertion.expectedOrder !== undefined && !Array.isArray(assertion.expectedOrder))
        contractError(`${label}.expectedOrder 必须是数组`);
      validateKeyFields(assertion, label);
      const fields = assertion.keyFields ?? [];
      const expectedKeys = new Set<string>();
      for (const [index, rawRecord] of (assertion.records ?? []).entries()) {
        if (!object(rawRecord)) contractError(`${label}.records[${index}] 必须是对象`);
        validateRecordKey(rawRecord.key, fields, `${label}.records[${index}].key`);
        validateScalarMap(rawRecord.values, `${label}.records[${index}].values`);
        const key = encodeCompositeKey(fields.map(field => rawRecord.key[field]));
        if (expectedKeys.has(key)) contractError(`${label} 存在重复的预期记录键`);
        expectedKeys.add(key);
      }
      if (assertion.expectedOrder) {
        for (const [index, key] of assertion.expectedOrder.entries())
          validateRecordKey(key, fields, `${label}.expectedOrder[${index}]`);
        if (assertion.records && assertion.expectedOrder.length !== assertion.records.length)
          contractError(`${label}.expectedOrder 的条数必须与 records 一致`);
      }
      if (assertion.expectedCount !== undefined && assertion.records
        && assertion.exactRecordSet !== false && assertion.expectedCount !== assertion.records.length)
        contractError(`${label}.expectedCount 必须与精确预期记录数一致`);
    }
  }
  return input as unknown as ProjectComparisonSuite;
}

function recordKey(record: DataRecord, fields: string[]): { encoded: string; values: Record<string, Scalar> } | undefined {
  const values: Record<string, Scalar> = {};
  for (const field of fields) {
    if (!Object.hasOwn(record.values, field)) return undefined;
    const value = record.values[field];
    if (value == null || value === '') return undefined;
    values[field] = value;
  }
  return { encoded: encodeCompositeKey(fields.map(field => values[field])), values };
}

function scalarEqual(expected: Scalar, actual: Scalar, tolerance: number): boolean {
  if (typeof expected === 'number' && typeof actual === 'number') return Math.abs(expected - actual) <= tolerance;
  return expected === actual;
}

/** Compares selected dataset/view values without changing or normalizing the source result. */
export function compareProjectResults(
  caseId: string,
  assertions: ProjectComparisonAssertion[],
  bundle: DatasetBundle,
  views: DataViewResult[],
): ProjectComparisonResult {
  const assertionResults: ProjectComparisonResult['assertions'] = [];
  const issues: ProjectComparisonIssue[] = [];
  const addIssue = (assertion: ProjectComparisonAssertion, issue: Omit<ProjectComparisonIssue, 'caseId' | 'scope' | 'targetId'>) =>
    issues.push({ caseId, scope: assertion.scope, targetId: assertion.targetId, ...issue });

  for (const assertion of assertions) {
    const before = issues.length;
    const rows = assertion.scope === 'dataset'
      ? bundle.datasets.find(dataset => dataset.datasetId === assertion.targetId)?.records
      : views.find(view => view.viewId === assertion.targetId)?.records;
    if (!rows) {
      addIssue(assertion, { code: 'TARGET_NOT_FOUND', message: `未找到对照目标 ${assertion.scope}:${assertion.targetId}` });
      assertionResults.push({ scope: assertion.scope, targetId: assertion.targetId, passed: false });
      continue;
    }
    if (assertion.expectedCount !== undefined && rows.length !== assertion.expectedCount)
      addIssue(assertion, { code: 'RECORD_COUNT_MISMATCH', message: '记录数不一致', expected: assertion.expectedCount, actual: rows.length });

    const fields = assertion.keyFields ?? [];
    const actualByKey = new Map<string, DataRecord>();
    const actualKeys: Array<{ encoded: string; values: Record<string, Scalar> }> = [];
    if (fields.length) {
      for (const row of rows) {
        const key = recordKey(row, fields);
        if (!key) {
          addIssue(assertion, { code: 'INVALID_ACTUAL_RECORD_KEY', message: '实际记录缺少非空匹配键字段' });
          actualKeys.push({ encoded: '', values: {} });
          continue;
        }
        if (actualByKey.has(key.encoded))
          addIssue(assertion, { code: 'DUPLICATE_ACTUAL_RECORD_KEY', message: '实际结果包含重复匹配键', recordKey: key.values });
        else actualByKey.set(key.encoded, row);
        actualKeys.push(key);
      }
    }

    const expectedKeys = new Set<string>();
    for (const expectedRecord of assertion.records ?? []) {
      const encoded = encodeCompositeKey(fields.map(field => expectedRecord.key[field]));
      expectedKeys.add(encoded);
      const actualRecord = actualByKey.get(encoded);
      if (!actualRecord) {
        addIssue(assertion, { code: 'MISSING_RECORD', message: '缺少预期记录', recordKey: expectedRecord.key });
        continue;
      }
      for (const [fieldId, expected] of Object.entries(expectedRecord.values)) {
        if (!Object.hasOwn(actualRecord.values, fieldId)) {
          addIssue(assertion, { code: 'FIELD_MISSING', message: `实际记录缺少字段 ${fieldId}`, recordKey: expectedRecord.key, fieldId, expected });
          continue;
        }
        const actual = actualRecord.values[fieldId];
        if (!scalarEqual(expected, actual, assertion.numericTolerance ?? 0))
          addIssue(assertion, { code: 'VALUE_MISMATCH', message: `字段 ${fieldId} 的值不一致`, recordKey: expectedRecord.key, fieldId, expected, actual });
      }
    }
    if (assertion.records && assertion.exactRecordSet !== false) {
      for (const key of actualKeys) if (key.encoded && !expectedKeys.has(key.encoded))
        addIssue(assertion, { code: 'UNEXPECTED_RECORD', message: '出现未列入预期基准的记录', recordKey: key.values });
    }
    if (assertion.expectedOrder) {
      const expectedOrder = assertion.expectedOrder.map(key => fields.map(field => key[field]));
      const actualOrder = actualKeys.map(key => fields.map(field => key.values[field] ?? null));
      if (JSON.stringify(expectedOrder) !== JSON.stringify(actualOrder))
        addIssue(assertion, { code: 'ORDER_MISMATCH', message: '记录顺序不一致', expected: expectedOrder, actual: actualOrder });
    }
    assertionResults.push({ scope: assertion.scope, targetId: assertion.targetId,
      passed: issues.length === before, actualCount: rows.length });
  }
  return { passed: issues.length === 0, assertionCount: assertionResults.length, issueCount: issues.length,
    assertions: assertionResults, issues };
}
