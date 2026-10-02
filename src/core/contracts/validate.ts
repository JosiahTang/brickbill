import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import schema from '../../../schemas/v2/reporting-contract.schema.json' with { type: 'json' };
import { ReportingError } from './errors.ts';
import type { ContractErrorCode } from './types.ts';
import type { ProjectDefinition } from './types.ts';

export type ContractKind = 'project' | 'projectAdapter' | 'sourceEnvelope' | 'fieldCatalog' | 'datasetBundle' | 'dataView'
  | 'registeredFunction' | 'templatePackage' | 'pagePlan' | 'generationSnapshot';
const schemaNames: Record<ContractKind, string> = {
  project: 'project', projectAdapter: 'projectAdapter', sourceEnvelope: 'sourceEnvelope',
  fieldCatalog: 'catalog', datasetBundle: 'datasetBundle', dataView: 'dataView',
  registeredFunction: 'functionDefinition', templatePackage: 'templatePackage', pagePlan: 'pagePlan',
  generationSnapshot: 'generationSnapshot',
};
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
const validators = new Map<ContractKind, ValidateFunction>();
function validTimestamp(value: unknown): value is string {
  const match = typeof value === 'string'
    ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
    : null;
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
    || (match[6] !== undefined && (Number(match[6]) > 23 || Number(match[7]) > 59))) return false;
  const calendarDay = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== match[1]) return false;
  const date = new Date(value as string);
  return Number.isFinite(date.getTime());
}
ajv.addFormat('date-time', { type: 'string', validate: validTimestamp });
function validator(kind: ContractKind): ValidateFunction {
  let current = validators.get(kind);
  if (!current) {
    const contractSchema = schema as { $id: string; definitions: Record<string, object> };
    if (!contractSchema.definitions[schemaNames[kind]]) throw new Error(`Schema 定义不存在：${kind}`);
    if (!ajv.getSchema(contractSchema.$id)) ajv.addSchema(contractSchema);
    current = ajv.compile({ $ref: `${contractSchema.$id}#/definitions/${schemaNames[kind]}` });
    validators.set(kind, current);
  }
  return current;
}
function pathOf(error: ErrorObject): string | undefined {
  const params = error.params as { missingProperty?: string; additionalProperty?: string };
  if (params.missingProperty) return `${error.instancePath}/${params.missingProperty}`;
  if (params.additionalProperty) return `${error.instancePath}/${params.additionalProperty}`;
  return error.instancePath || undefined;
}
export function validateContract<T>(kind: ContractKind, value: unknown): asserts value is T {
  const validate = validator(kind);
  if (validate(value)) {
    if (kind === 'sourceEnvelope' || kind === 'datasetBundle') {
      const collectedAt = (value as { collectedAt?: unknown }).collectedAt;
      if (!validTimestamp(collectedAt)) throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'contract',
        message: `${kind} 契约校验失败：/collectedAt 必须是含时区的 ISO 8601 时间` });
    } else if (kind === 'generationSnapshot') {
      const snapshot = value as { collectedAt?: unknown; data?: { collectedAt?: unknown } };
      if (!validTimestamp(snapshot.collectedAt) || !validTimestamp(snapshot.data?.collectedAt))
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'contract',
          message: 'generationSnapshot 契约校验失败：collectedAt 和 data.collectedAt 必须是含时区的 ISO 8601 时间' });
    }
    return;
  }
  const errors = (validate.errors ?? []).map(error => ({
    keyword: error.keyword, path: pathOf(error), message: error.message ?? '格式错误',
  }));
  const sourcePath = errors.find(error => error.path)?.path;
  const message = `${kind} 契约校验失败：${errors.slice(0, 5).map(error =>
    `${error.path ?? '/'} ${error.message}`).join('；')}`;
  throw new ReportingError({ code: 'CONTRACT_INVALID' satisfies ContractErrorCode,
    stage: 'contract', message, context: sourcePath ? { sourcePath } : undefined });
}

export function validateProjectSemantics(project: ProjectDefinition): void {
  validateContract<ProjectDefinition>('project', project);
  const issue = (message: string, context?: Record<string, string>): never => {
    throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'contract', message, context });
  };
  const datasets = new Map<string, ProjectDefinition['datasets'][number]>();
  for (const dataset of project.datasets) {
    if (datasets.has(dataset.datasetId)) issue(`数据集标识重复：${dataset.datasetId}`);
    datasets.set(dataset.datasetId, dataset);
    const fields = new Map(dataset.fields.map(field => [field.fieldId, field]));
    if (fields.size !== dataset.fields.length) issue(`数据集 ${dataset.datasetId} 存在重复字段标识`, { datasetId: dataset.datasetId });
    for (const key of dataset.primaryKey) {
      const field = fields.get(key);
      if (!field) return issue(`数据集 ${dataset.datasetId} 的主键字段 ${key} 未定义`, { datasetId: dataset.datasetId, fieldId: key });
      if (field.nullable) issue(`主键字段 ${key} 不可空`, { datasetId: dataset.datasetId, fieldId: key });
    }
  }
  const relationships = new Set<string>();
  for (const relation of project.relationships) {
    if (relationships.has(relation.relationshipId)) issue(`关系标识重复：${relation.relationshipId}`);
    relationships.add(relation.relationshipId);
    const parent = datasets.get(relation.parentDatasetId), child = datasets.get(relation.childDatasetId);
    if (!parent || !child) return issue(`关系 ${relation.relationshipId} 指向未定义数据集`, { relationshipId: relation.relationshipId });
    if (relation.parentKey.length !== relation.childForeignKey.length)
      issue(`关系 ${relation.relationshipId} 两端复合键字段数量不匹配`, { relationshipId: relation.relationshipId });
    for (let index = 0; index < relation.parentKey.length; index++) {
      const parentField = parent.fields.find(field => field.fieldId === relation.parentKey[index]);
      const childField = child.fields.find(field => field.fieldId === relation.childForeignKey[index]);
      if (!parentField || !childField) return issue(`关系 ${relation.relationshipId} 引用了未定义的关联键`, { relationshipId: relation.relationshipId });
      if (parentField.type !== childField.type) issue(`关系 ${relation.relationshipId} 的关联键类型不同`, { relationshipId: relation.relationshipId });
      if (parentField.nullable || childField.nullable) issue(`关系 ${relation.relationshipId} 的关联键不能为可空字段`, { relationshipId: relation.relationshipId });
    }
  }
}
