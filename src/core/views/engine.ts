import { ReportingError } from '../contracts/errors.ts';
import { validateContract } from '../contracts/validate.ts';
import type {
  CatalogFieldDefinition, DataRecord, DataViewDefinition, DataViewResult, DatasetBundle,
  DatasetRelationship, ProjectDefinition, Scalar, ViewRecord,
} from '../contracts/types.ts';
import { FunctionRegistry } from '../functions/registry.ts';
import { validateProjectSemantics } from '../contracts/validate.ts';
import { validateDatasetBundleAgainstProject } from '../catalog/catalog.ts';
import { validateCatalogAgainstProject } from '../catalog/catalog.ts';

function error(code: ConstructorParameters<typeof ReportingError>[0]['code'], message: string,
  context: ConstructorParameters<typeof ReportingError>[0]['context'] = {}): never {
  throw new ReportingError({ code, stage: 'view', message, context });
}

function tupleKey(values: Scalar[]): string { return JSON.stringify(values); }
function lineage(record: DataRecord): string[] { return [...new Set(record.sourceRecordIds ?? [record.recordId])].sort(); }
function compare(left: Scalar | undefined, right: Scalar | undefined): number {
  if (left == null || right == null) return left == null ? right == null ? 0 : -1 : 1;
  if (typeof left !== typeof right) error('VIEW_INVALID', '不能排序类型不同的字段');
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  const leftText = String(left), rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}
function numeric(record: DataRecord, fieldId: string, operation: string): number {
  const value = record.values[fieldId];
  if (typeof value !== 'number' || !Number.isFinite(value))
    error('VALUE_TYPE_ERROR', `${operation} 需要有效数字字段 ${fieldId}`, { fieldId, recordId: record.recordId });
  return value;
}
function fieldSet(fields: Array<{ fieldId: string }>): Set<string> { return new Set(fields.map(field => field.fieldId)); }
function ensureKnown(known: Set<string>, fieldId: string): void {
  if (!known.has(fieldId)) error('FIELD_NOT_FOUND', `数据视图引用了未知字段 ${fieldId}`, { fieldId });
}

export interface DataViewEngineOptions {
  project: ProjectDefinition;
  catalog: CatalogFieldDefinition[];
  views: DataViewDefinition[];
  functions: FunctionRegistry;
}

export class DataViewEngine {
  private readonly options: DataViewEngineOptions;
  private readonly viewById = new Map<string, DataViewDefinition>();
  private readonly catalogFieldById: Map<string, CatalogFieldDefinition>;
  private readonly datasetById = new Map<string, ProjectDefinition['datasets'][number]>();

  constructor(options: DataViewEngineOptions) {
    this.options = options;
    const { project, catalog, views, functions } = options;
    validateProjectSemantics(project);
    const catalogIdSet = new Set<string>();
    for (const field of catalog) {
      if (catalogIdSet.has(field.fieldId)) error('CONTRACT_INVALID', `字段目录出现重复标识 ${field.fieldId}`, { fieldId: field.fieldId });
      catalogIdSet.add(field.fieldId);
    }
    this.catalogFieldById = new Map(catalog.map(field => [field.fieldId, field]));
    validateCatalogAgainstProject({ contractVersion: 2, projectId: project.projectId,
      catalogVersion: project.projectVersion, fields: catalog }, project, views);
    for (const dataset of project.datasets) this.datasetById.set(dataset.datasetId, dataset);
    for (const view of views) {
      validateContract<DataViewDefinition>('dataView', view);
      if (this.viewById.has(view.viewId)) error('DUPLICATE_KEY', `重复视图 ${view.viewId}`, { viewId: view.viewId });
      if (!this.datasetById.has(view.sourceDatasetId)) error('VIEW_INVALID', `视图数据集不存在：${view.sourceDatasetId}`, { viewId: view.viewId, datasetId: view.sourceDatasetId });
      this.viewById.set(view.viewId, structuredClone(view));
    }
    // Resolve the full data-set path up front so child relationships may target a function's output.
    for (const view of views) this.outputDatasetId(view);
  }

  execute(viewId: string, bundle: DatasetBundle): DataViewResult {
    validateDatasetBundleAgainstProject(bundle, this.options.project);
    const datasets = new Map(bundle.datasets.map(dataset => [dataset.datasetId, dataset.records]));
    const results = new Map<string, DataViewResult>();
    const roots = this.executeView(viewId, datasets, results, []);
    const root = roots.result;
    return root;
  }

  executeAll(bundle: DatasetBundle, rootViewIds: string[]): DataViewResult[] {
    validateDatasetBundleAgainstProject(bundle, this.options.project);
    const datasetRows = new Map(bundle.datasets.map(dataset => [dataset.datasetId, dataset.records]));
    const results = new Map<string, DataViewResult>();
    for (const viewId of rootViewIds) this.executeView(viewId, datasetRows, results, []);
    return [...results.values()];
  }

  private executeView(
    viewId: string,
    datasets: Map<string, DataRecord[]>,
    results: Map<string, DataViewResult>,
    stack: string[],
  ): { result: DataViewResult; datasetId: string } {
    if (stack.includes(viewId)) error('VIEW_INVALID', `视图父子关系形成循环：${[...stack, viewId].join(' → ')}`, { viewId });
    const cached = results.get(viewId);
    if (cached) return { result: cached, datasetId: cached.datasetId };
    const view = this.viewById.get(viewId);
    if (!view) error('RULE_VERSION_NOT_FOUND', `数据视图未注册：${viewId}`, { viewId });
    const input = datasets.get(view.sourceDatasetId);
    if (!input) error('DATA_NOT_FOUND', `视图所需数据集未采集：${view.sourceDatasetId}`, { viewId, datasetId: view.sourceDatasetId });
    const originalCount = input.length;
    let rows: DataRecord[] = structuredClone(input);
    let currentDatasetId = view.sourceDatasetId;
    let known = fieldSet(this.datasetById.get(currentDatasetId)!.fields);

    for (const step of view.steps) {
      if (step.op === 'filter') {
        ensureKnown(known, step.fieldId);
        rows = rows.filter(record => {
          const value = record.values[step.fieldId];
          switch (step.operator) {
            case 'isNull': return value == null || value === '';
            case 'eq': return value === step.value;
            case 'neq': return value !== step.value;
            case 'in': return Array.isArray(step.value) && step.value.some(item => item === value);
            case 'contains': return typeof value === 'string' && typeof step.value === 'string' && value.includes(step.value);
            case 'gt': case 'gte': case 'lt': case 'lte': {
              if (typeof value !== 'number' || typeof step.value !== 'number')
                error('VALUE_TYPE_ERROR', `比较 ${step.operator} 仅支持数字字段 ${step.fieldId}`, { viewId, fieldId: step.fieldId });
              return step.operator === 'gt' ? value > step.value
                : step.operator === 'gte' ? value >= step.value
                : step.operator === 'lt' ? value < step.value : value <= step.value;
            }
          }
        });
      } else if (step.op === 'sort') {
        for (const item of step.by) ensureKnown(known, item.fieldId);
        rows = rows.map((record, index) => ({ record, index })).sort((a, b) => {
          for (const item of step.by) {
            const value = compare(a.record.values[item.fieldId], b.record.values[item.fieldId]);
            if (value) return item.direction === 'asc' ? value : -value;
          }
          return a.index - b.index;
        }).map(item => item.record);
      } else if (step.op === 'project') {
        const outputFields = new Set<string>();
        for (const item of step.fields) {
          ensureKnown(known, item.sourceFieldId);
          if (outputFields.has(item.outputFieldId)) error('DUPLICATE_KEY', `投影字段标识重复 ${item.outputFieldId}`, { viewId, fieldId: item.outputFieldId });
          outputFields.add(item.outputFieldId);
        }
        rows = rows.map(record => ({ recordId: record.recordId,
          values: Object.fromEntries(step.fields.map(item => [item.outputFieldId, record.values[item.sourceFieldId] ?? null])),
          sourceRecordIds: lineage(record) }));
        known = outputFields;
      } else if (step.op === 'group') {
        for (const fieldId of step.by) ensureKnown(known, fieldId);
        const outputFields = new Set(step.by);
        for (const aggregate of step.aggregations) {
          if (aggregate.fieldId) ensureKnown(known, aggregate.fieldId);
          if (aggregate.operation !== 'count' && !aggregate.fieldId)
            error('VIEW_INVALID', `${aggregate.operation} 必须指定输入字段`, { viewId, fieldId: aggregate.outputFieldId });
          if (outputFields.has(aggregate.outputFieldId)) error('DUPLICATE_KEY', `分组输出字段重复 ${aggregate.outputFieldId}`, { viewId, fieldId: aggregate.outputFieldId });
          outputFields.add(aggregate.outputFieldId);
        }
        const groups = new Map<string, DataRecord[]>();
        for (const record of rows) {
          const key = tupleKey(step.by.map(fieldId => record.values[fieldId] ?? null));
          const members = groups.get(key) ?? []; members.push(record); groups.set(key, members);
        }
        rows = [...groups.entries()].map(([key, members]) => {
          const values: Record<string, Scalar> = Object.fromEntries(step.by.map(fieldId => [fieldId, members[0].values[fieldId] ?? null]));
          for (const aggregate of step.aggregations) {
            if (aggregate.operation === 'count') values[aggregate.outputFieldId] = aggregate.fieldId
              ? members.filter(record => record.values[aggregate.fieldId!] != null).length : members.length;
            else {
              const samples = members.map(record => record.values[aggregate.fieldId!]).filter((value): value is number => value != null)
                .map(value => {
                  if (typeof value !== 'number' || !Number.isFinite(value)) error('VALUE_TYPE_ERROR',
                    `聚合 ${aggregate.operation} 字段必须是有效数字`, { viewId, fieldId: aggregate.fieldId, recordId: members[0].recordId });
                  return value;
                });
              if (!samples.length) values[aggregate.outputFieldId] = null;
              else values[aggregate.outputFieldId] = aggregate.operation === 'sum' ? samples.reduce((sum, value) => sum + value, 0)
                : aggregate.operation === 'average' ? samples.reduce((sum, value) => sum + value, 0) / samples.length
                : aggregate.operation === 'min' ? Math.min(...samples) : Math.max(...samples);
            }
          }
          return { recordId: `group:${key}`, values,
            sourceRecordIds: [...new Set(members.flatMap(lineage))].sort() };
        });
        known = outputFields;
      } else if (step.op === 'pivot') {
        for (const fieldId of [...step.by, step.columnFieldId, step.valueFieldId]) ensureKnown(known, fieldId);
        const outputColumns = Object.values(step.columns);
        if (new Set(outputColumns.map(column => column.outputFieldId)).size !== outputColumns.length)
          error('DUPLICATE_KEY', '透视配置的输出字段标识重复', { viewId });
        const configured = new Map(outputColumns.map(column => [tupleKey([column.value]), column.outputFieldId]));
        const groups = new Map<string, { members: DataRecord[]; values: Record<string, Scalar[]> }>();
        for (const record of rows) {
          const groupKey = tupleKey(step.by.map(fieldId => record.values[fieldId] ?? null));
          let group = groups.get(groupKey);
          if (!group) { group = { members: [], values: {} }; groups.set(groupKey, group); }
          group.members.push(record);
          const columnKey = tupleKey([record.values[step.columnFieldId] ?? null]);
          const targetField = configured.get(columnKey);
          if (!targetField) error('VIEW_INVALID', `透视列值未配置：${String(record.values[step.columnFieldId])}`,
            { viewId, fieldId: step.columnFieldId, recordId: record.recordId });
          const bucket = group.values[targetField] ?? []; bucket.push(record.values[step.valueFieldId] ?? null); group.values[targetField] = bucket;
        }
        rows = [...groups.entries()].map(([key, group]) => {
          const values: Record<string, Scalar> = Object.fromEntries(step.by.map(fieldId => [fieldId, group.members[0].values[fieldId] ?? null]));
          for (const target of outputColumns) {
            const bucket = group.values[target.outputFieldId] ?? [];
            if (bucket.length <= 1) values[target.outputFieldId] = bucket[0] ?? null;
            else if (step.duplicatePolicy === 'reject') error('AMBIGUOUS_SCOPE',
              `透视键出现多个值，请先选择正式结果或设置明确汇总策略：${target.outputFieldId}`, { viewId, fieldId: target.outputFieldId });
            else {
              const numbers = bucket.filter((value): value is number => value != null).map(value => {
                if (typeof value !== 'number' || !Number.isFinite(value)) error('VALUE_TYPE_ERROR',
                  `透视汇总字段 ${target.outputFieldId} 不是有效数字`, { viewId, fieldId: target.outputFieldId });
                return value;
              });
              if (!numbers.length) values[target.outputFieldId] = null;
              else values[target.outputFieldId] = step.duplicatePolicy === 'sum' ? numbers.reduce((sum, value) => sum + value, 0)
                : step.duplicatePolicy === 'average' ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length
                : step.duplicatePolicy === 'min' ? Math.min(...numbers) : Math.max(...numbers);
            }
          }
          return { recordId: `pivot:${key}`, values,
            sourceRecordIds: [...new Set(group.members.flatMap(lineage))].sort() };
        });
        known = new Set([...step.by, ...outputColumns.map(column => column.outputFieldId)]);
      } else if (step.op === 'lookup') {
        const relationship = this.relationship(step.relationshipId, view.viewId);
        if (relationship.cardinality !== 'one-to-one' || relationship.parentDatasetId !== currentDatasetId)
          error('RELATION_CARDINALITY_ERROR', '单值查找只允许从当前父数据集沿已声明的一对一关系读取', { viewId });
        const childDefinition = this.datasetById.get(relationship.childDatasetId)!;
        const childRows = datasets.get(relationship.childDatasetId) ?? [];
        const childIndex = new Map<string, DataRecord>();
        for (const child of childRows) {
          const key = tupleKey(relationship.childForeignKey.map(fieldId => child.values[fieldId] ?? null));
          if (childIndex.has(key)) error('RELATION_CARDINALITY_ERROR', `一对一关系 ${relationship.relationshipId} 匹配到多条子记录`, { viewId, datasetId: childDefinition.datasetId, recordId: child.recordId });
          childIndex.set(key, child);
        }
        for (const item of step.fields) {
          if (!childDefinition.fields.some(field => field.fieldId === item.childFieldId)) error('FIELD_NOT_FOUND', `查找字段不存在 ${item.childFieldId}`, { viewId, fieldId: item.childFieldId });
          if (known.has(item.outputFieldId)) error('DUPLICATE_KEY', `查找输出字段重复 ${item.outputFieldId}`, { viewId, fieldId: item.outputFieldId });
          known.add(item.outputFieldId);
        }
        rows = rows.map(record => {
          const key = tupleKey(relationship.parentKey.map(fieldId => record.values[fieldId] ?? null));
          const child = childIndex.get(key);
          return { ...record, values: { ...record.values,
            ...Object.fromEntries(step.fields.map(item => [item.outputFieldId, child?.values[item.childFieldId] ?? null])) },
            sourceRecordIds: lineage(record) };
        });
      } else if (step.op === 'applyFunction') {
        const entry = this.options.functions.resolve(step.functionId, step.version);
        if (!entry.definition.inputDatasetIds.includes(currentDatasetId)) error('VIEW_INVALID',
          `函数 ${step.functionId} 不接受当前数据集 ${currentDatasetId}`, { viewId });
        for (const fieldId of entry.definition.outputFields) if (known.has(fieldId))
          error('DUPLICATE_KEY', `函数输出字段与当前字段冲突 ${fieldId}`, { viewId, fieldId });
        rows = this.options.functions.execute(step.functionId, step.version, rows, step.parameters)
          .map(record => ({ ...record, sourceRecordIds: lineage(record) }));
        currentDatasetId = entry.definition.outputDatasetId;
        known = new Set(entry.definition.outputFields);
      }
    }

    for (const fieldId of view.outputFields) ensureKnown(known, fieldId);
    for (const record of rows) for (const fieldId of view.outputFields) if (!Object.hasOwn(record.values, fieldId))
      record.values[fieldId] = null;
    rows = rows.map(record => ({ recordId: record.recordId,
      values: Object.fromEntries(view.outputFields.map(fieldId => [fieldId, record.values[fieldId] ?? null])),
      sourceRecordIds: lineage(record) }));
    const result: DataViewResult = { viewId, viewVersion: view.version, datasetId: currentDatasetId,
      outputFields: [...view.outputFields], records: rows as ViewRecord[], inputRecordCount: originalCount,
      outputRecordCount: rows.length, diagnostics: [] };
    results.set(viewId, result);

    const childNames = new Set<string>();
    for (const binding of view.children ?? []) {
      if (childNames.has(binding.as)) error('DUPLICATE_KEY', `父视图子集合别名重复 ${binding.as}`, { viewId });
      childNames.add(binding.as);
      const relation = this.relationship(binding.relationshipId, viewId);
      const childView = this.viewById.get(binding.viewId);
      if (!childView) error('RULE_VERSION_NOT_FOUND', `子视图未注册 ${binding.viewId}`, { viewId });
      if (relation.cardinality !== 'one-to-many' || relation.parentDatasetId !== currentDatasetId
        || relation.childDatasetId !== this.outputDatasetId(childView))
        error('RELATION_CARDINALITY_ERROR', `子视图 ${binding.viewId} 与关系 ${relation.relationshipId} 不匹配`, { viewId });
      const rootKeys = binding.parentFieldIds, childKeys = binding.childFieldIds;
      if (!rootKeys.length || rootKeys.length !== childKeys.length || rootKeys.length !== relation.parentKey.length
        || rootKeys.some((fieldId, index) => fieldId !== relation.parentKey[index])
        || childKeys.some((fieldId, index) => fieldId !== relation.childForeignKey[index]))
        error('RELATION_CARDINALITY_ERROR', '子视图关联键必须与数据关系中声明的复合键完整匹配', { viewId });
      for (const fieldId of rootKeys) if (!known.has(fieldId)) error('FIELD_NOT_FOUND', `父视图未保留关联键 ${fieldId}`, { viewId, fieldId });
      for (const fieldId of childKeys) if (!childView.outputFields.includes(fieldId)) error('FIELD_NOT_FOUND', `子视图未输出关联键 ${fieldId}`, { viewId: childView.viewId, fieldId });
      const childResult = this.executeView(childView.viewId, datasets, results, [...stack, viewId]).result;
      const index = new Map<string, ViewRecord[]>();
      for (const child of childResult.records) {
        const key = tupleKey(childKeys.map(fieldId => child.values[fieldId] ?? null));
        const matches = index.get(key) ?? []; matches.push(child); index.set(key, matches);
      }
      result.records = result.records.map(parent => {
        const key = tupleKey(rootKeys.map(fieldId => parent.values[fieldId] ?? null));
        return { ...parent, children: { ...(parent.children ?? {}), [binding.as]: index.get(key) ?? [] } };
      });
    }
    return { result, datasetId: currentDatasetId };
  }

  private relationship(relationshipId: string, viewId: string): DatasetRelationship {
    const relation = this.options.project.relationships.find(item => item.relationshipId === relationshipId);
    if (!relation) error('VIEW_INVALID', `数据关系未注册：${relationshipId}`, { viewId });
    return relation;
  }

  private outputDatasetId(view: DataViewDefinition): string {
    let datasetId = view.sourceDatasetId;
    for (const step of view.steps) if (step.op === 'applyFunction') {
      const fn = this.options.functions.resolve(step.functionId, step.version);
      if (!fn.definition.inputDatasetIds.includes(datasetId)) error('VIEW_INVALID',
        `函数 ${step.functionId} 不接受当前数据集 ${datasetId}`, { viewId: view.viewId });
      datasetId = fn.definition.outputDatasetId;
    }
    return datasetId;
  }
}
