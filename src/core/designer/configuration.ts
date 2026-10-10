import type { DataFieldDefinition, DataViewDefinition, DataViewStep, FieldCatalog, ProjectDefinition, RegisteredFunctionDefinition, Scalar } from '../contracts/types.ts';

export interface DesignerMetadata {
  project: ProjectDefinition;
  catalog: FieldCatalog;
  views: DataViewDefinition[];
  functions: RegisteredFunctionDefinition[];
}

/** Only describes selectable fields; execution and validation remain in DataViewEngine. */
export function stepScope(metadata: DesignerMetadata, sourceDatasetId: string, steps: DataViewStep[]) {
  let datasetId = sourceDatasetId;
  let fields = (metadata.project.datasets.find(item => item.datasetId === datasetId)?.fields ?? []).map(field => ({ ...field }));
  const describe = (fieldId: string, source?: DataFieldDefinition): DataFieldDefinition => {
    const catalog = metadata.catalog.fields.find(item => item.fieldId === fieldId);
    return { fieldId, label: catalog?.label ?? source?.label ?? fieldId, type: source?.type ?? catalog?.type ?? 'text', nullable: true };
  };
  for (const step of steps) {
    if (step.op === 'project') fields = step.fields.map(item => describe(item.outputFieldId, fields.find(field => field.fieldId === item.sourceFieldId)));
    else if (step.op === 'group') fields = [
      ...fields.filter(field => step.by.includes(field.fieldId)),
      ...step.aggregations.map(item => ({ ...describe(item.outputFieldId), type: 'number' as const })),
    ];
    else if (step.op === 'pivot') fields = [
      ...fields.filter(field => step.by.includes(field.fieldId)),
      ...Object.values(step.columns).map(item => describe(item.outputFieldId, fields.find(field => field.fieldId === step.valueFieldId))),
    ];
    else if (step.op === 'lookup') {
      const relationship = metadata.project.relationships.find(item => item.relationshipId === step.relationshipId);
      const child = metadata.project.datasets.find(item => item.datasetId === relationship?.childDatasetId);
      fields = fields.concat(step.fields.map(item => describe(item.outputFieldId, child?.fields.find(field => field.fieldId === item.childFieldId))));
    } else if (step.op === 'applyFunction') {
      const fn = metadata.functions.find(item => item.functionId === step.functionId && item.version === step.version);
      if (fn) {
        datasetId = fn.outputDatasetId;
        const output = metadata.project.datasets.find(item => item.datasetId === datasetId);
        fields = fn.outputFields.map(id => describe(id, output?.fields.find(field => field.fieldId === id)));
      }
    }
  }
  return { datasetId, fields };
}

export function parseScalar(value: string, type: string): Scalar {
  if (type === 'number') {
    if (!value.trim() || !Number.isFinite(Number(value))) throw new Error('请输入有效数字');
    return Number(value);
  }
  if (type === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new Error('请选择是或否');
    return value === 'true';
  }
  if (type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error('请输入有效日期');
  return value;
}
