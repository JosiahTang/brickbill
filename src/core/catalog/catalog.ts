import { ReportingError } from '../contracts/errors.ts';
import { validateContract, validateProjectSemantics } from '../contracts/validate.ts';
import type {
  CatalogFieldDefinition, ContractErrorCode, DatasetBundle, FieldCatalog, ProjectDefinition, Scalar, ValueType,
} from '../contracts/types.ts';

function bad(message: string, fieldId?: string): never {
  throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'catalog', message,
    context: fieldId ? { fieldId } : undefined });
}

export function buildFieldCatalog(project: ProjectDefinition, catalogVersion = project.projectVersion): FieldCatalog {
  validateProjectSemantics(project);
  const fields: CatalogFieldDefinition[] = project.datasets.flatMap(dataset => dataset.fields.map(field => ({
    fieldId: field.fieldId, label: field.label, type: field.type, nullable: field.nullable,
    grain: dataset.grain, ...(field.unit ? { unit: field.unit } : {}),
    source: { kind: 'dataset' as const, datasetId: dataset.datasetId, sourceFieldId: field.fieldId },
  })));
  if (new Set(fields.map(field => field.fieldId)).size !== fields.length)
    throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'catalog',
      message: '项目多个数据集重复定义了字段标识；请为不同业务粒度的字段使用稳定且唯一的标识' });
  const catalog: FieldCatalog = { contractVersion: 2, projectId: project.projectId, catalogVersion, fields };
  validateContract<FieldCatalog>('fieldCatalog', catalog);
  return catalog;
}

export function addControlledField(
  catalog: FieldCatalog,
  field: CatalogFieldDefinition,
): FieldCatalog {
  const existing = catalog.fields.find(item => item.fieldId === field.fieldId);
  if (existing) throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'catalog',
    message: `字段标识已存在：${field.fieldId}`, context: { fieldId: field.fieldId } });
  if (field.source.kind === 'dataset') throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'catalog',
    message: '数据源字段必须由项目字段映射生成，不能作为手工字段新增', context: { fieldId: field.fieldId } });
  const result: FieldCatalog = { ...catalog, fields: [...catalog.fields, structuredClone(field)] };
  validateContract<FieldCatalog>('fieldCatalog', result);
  return result;
}

export function addViewFields(
  catalog: FieldCatalog,
  viewId: string,
  definitions: Array<Omit<CatalogFieldDefinition, 'source'>>,
): FieldCatalog {
  const additions = definitions.map(field => ({ ...structuredClone(field),
    source: { kind: 'view' as const, viewId, sourceFieldId: field.fieldId } }));
  if (new Set(additions.map(field => field.fieldId)).size !== additions.length)
    throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'catalog', message: `视图 ${viewId} 输出字段标识重复` });
  const existing = new Set(catalog.fields.map(field => field.fieldId));
  const duplicate = additions.find(field => existing.has(field.fieldId));
  if (duplicate) throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'catalog',
    message: `视图输出字段标识已存在：${duplicate.fieldId}`, context: { fieldId: duplicate.fieldId, viewId } });
  const result: FieldCatalog = { ...catalog, fields: [...catalog.fields, ...additions] };
  validateContract<FieldCatalog>('fieldCatalog', result);
  return result;
}

export function validateCatalogAgainstProject(catalog: FieldCatalog, project: ProjectDefinition,
  views: Array<{ viewId: string; outputFields: string[] }> = []): void {
  validateContract<FieldCatalog>('fieldCatalog', catalog);
  validateProjectSemantics(project);
  if (catalog.projectId !== project.projectId) throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'catalog',
    message: '字段目录所属项目与项目定义不一致', context: { projectId: project.projectId } });
  const seen = new Set<string>();
  const viewById = new Map(views.map(view => [view.viewId, view]));
  for (const entry of catalog.fields) {
    if (seen.has(entry.fieldId)) throw new ReportingError({ code: 'DUPLICATE_KEY', stage: 'catalog',
      message: `字段目录标识重复：${entry.fieldId}`, context: { fieldId: entry.fieldId } });
    seen.add(entry.fieldId);
    if (entry.source.kind === 'dataset') {
      const dataset = project.datasets.find(item => item.datasetId === entry.source.datasetId);
      const sourceField = dataset?.fields.find(field => field.fieldId === entry.source.sourceFieldId);
      if (!sourceField || entry.fieldId !== sourceField.fieldId || entry.type !== sourceField.type
        || entry.nullable !== sourceField.nullable || entry.grain !== dataset!.grain)
        throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'catalog',
          message: `字段 ${entry.fieldId} 与数据集定义不匹配`, context: { projectId: project.projectId, datasetId: entry.source.datasetId, fieldId: entry.fieldId } });
    } else if (entry.source.kind === 'view') {
      const view = viewById.get(entry.source.viewId!);
      if (!view || !view.outputFields.includes(entry.source.sourceFieldId!) || entry.fieldId !== entry.source.sourceFieldId)
        throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'catalog',
          message: `视图 ${entry.source.viewId} 未声明输出字段 ${entry.fieldId}`, context: { viewId: entry.source.viewId, fieldId: entry.fieldId } });
    } else if (entry.source.kind === 'constant') {
      if (!matchesType(entry.source.value!, entry.type)) throw new ReportingError({ code: 'VALUE_TYPE_ERROR', stage: 'catalog',
        message: `常量字段 ${entry.fieldId} 的值与字段类型不匹配`, context: { fieldId: entry.fieldId } });
    } else if (entry.source.kind === 'page' && entry.type !== 'number') {
      throw new ReportingError({ code: 'VALUE_TYPE_ERROR', stage: 'catalog',
        message: `页面系统字段 ${entry.fieldId} 必须是数字`, context: { fieldId: entry.fieldId } });
    }
  }
}

export function findCatalogField(catalog: FieldCatalog, fieldId: string): CatalogFieldDefinition {
  const field = catalog.fields.find(item => item.fieldId === fieldId);
  if (!field) return bad(`字段目录中不存在 ${fieldId}`, fieldId);
  return field;
}

function matchesType(value: Scalar, type: ValueType): boolean {
  if (value === null) return true;
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'date') return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  return typeof value === 'string';
}

export function validateDatasetBundleAgainstProject(bundle: DatasetBundle, project: ProjectDefinition): void {
  validateContract<DatasetBundle>('datasetBundle', bundle);
  const issue = (code: ContractErrorCode, message: string,
    context?: { datasetId?: string; recordId?: string; fieldId?: string }): never => {
    throw new ReportingError({ code, stage: 'collect', message, context });
  };
  if (bundle.projectId !== project.projectId) issue('CONTRACT_INVALID', '采集数据所属项目与项目定义不一致');
  if (!project.documentTypes.includes(bundle.documentType)) issue('CONTRACT_INVALID', `项目不支持单据类型 ${bundle.documentType}`);
  for (const [key, parameter] of Object.entries(project.businessKey)) {
    const value = bundle.businessKey[key];
    if (parameter.required && (value == null || value === '')) issue('VALUE_TYPE_ERROR',
      `数据包缺少业务单号参数 ${parameter.label}`, { fieldId: key });
    if (value != null && !matchesType(value, parameter.type)) issue('VALUE_TYPE_ERROR',
      `业务单号参数 ${parameter.label} 类型错误`, { fieldId: key });
  }
  for (const key of Object.keys(bundle.businessKey)) if (!Object.hasOwn(project.businessKey, key))
    issue('CONTRACT_INVALID', `项目未登记业务单号参数 ${key}`);
  const supplied = new Map(bundle.datasets.map(dataset => [dataset.datasetId, dataset]));
  if (supplied.size !== bundle.datasets.length) issue('DUPLICATE_KEY', '数据包中存在重复的数据集');
  const definitions = new Map(project.datasets.map(dataset => [dataset.datasetId, dataset]));
  for (const datasetId of supplied.keys()) if (!definitions.has(datasetId))
    issue('CONTRACT_INVALID', `项目中未定义数据集 ${datasetId}`, { datasetId });
  for (const definition of project.datasets) {
    const dataset = supplied.get(definition.datasetId);
    if (!dataset) {
      if (definition.required) issue('DATA_NOT_FOUND', `缺少必需数据集 ${definition.label}`, { datasetId: definition.datasetId });
      continue;
    }
    const keys = new Set<string>();
    for (const record of dataset.records) {
      if (keys.has(record.recordId)) issue('DUPLICATE_KEY', `数据集 ${definition.datasetId} 存在重复记录键 ${record.recordId}`,
        { datasetId: definition.datasetId, recordId: record.recordId });
      keys.add(record.recordId);
      const values = record.values;
      for (const field of definition.fields) {
        const value = values[field.fieldId];
        if (value === undefined || value === null) {
          if (!field.nullable || definition.primaryKey.includes(field.fieldId))
            issue('VALUE_TYPE_ERROR', `记录 ${record.recordId} 缺少字段 ${field.fieldId}`,
              { datasetId: definition.datasetId, recordId: record.recordId, fieldId: field.fieldId });
          continue;
        }
        if (!matchesType(value, field.type)) issue('VALUE_TYPE_ERROR',
          `字段 ${field.fieldId} 应为 ${field.type}，实际类型不匹配`,
          { datasetId: definition.datasetId, recordId: record.recordId, fieldId: field.fieldId });
      }
      for (const fieldId of Object.keys(values)) if (!definition.fields.some(field => field.fieldId === fieldId))
        issue('CONTRACT_INVALID', `数据集 ${definition.datasetId} 未定义字段 ${fieldId}`,
          { datasetId: definition.datasetId, recordId: record.recordId, fieldId });
      for (const keyField of definition.primaryKey) if (values[keyField] == null || values[keyField] === '')
        issue('VALUE_TYPE_ERROR', `复合键字段 ${keyField} 不能为空`,
          { datasetId: definition.datasetId, recordId: record.recordId, fieldId: keyField });
      const canonicalRecordId = definition.primaryKey.map(fieldId => {
        const value = values[fieldId] as Scalar;
        const part = `${typeof value}:${String(value)}`;
        return `${part.length}:${part}`;
      }).join('|');
      if (record.recordId !== canonicalRecordId) issue('CONTRACT_INVALID',
        `记录标识与复合主键不匹配：${record.recordId}`, { datasetId: definition.datasetId, recordId: record.recordId });
    }
  }
}
