import { ReportingError } from '../contracts/errors.ts';
import type { DataRecord, RegisteredFunctionDefinition, Scalar } from '../contracts/types.ts';
import { encodeCompositeKey } from '../adapters/project-adapter.ts';
import { FunctionRegistry } from './registry.ts';

const QUADRANTS = ['1', '2', '3', '4'] as const;
const POSITIONS = ['OUT', 'MID', 'IN'] as const;
const SPOTS = ['1', '2', '3', '4'] as const;
const identityFields = ['hardness.printNo', 'hardness.partFlag', 'hardness.heatNo', 'hardness.lotNo', 'hardness.sampleId', 'hardness.sequenceNo', 'hardness.hardType'] as const;
const outputIdentityFieldMap: Record<(typeof identityFields)[number], string> = {
  'hardness.printNo': 'hardness.sample.printNo',
  'hardness.partFlag': 'hardness.sample.partFlag',
  'hardness.heatNo': 'hardness.sample.heatNo',
  'hardness.lotNo': 'hardness.sample.lotNo',
  'hardness.sampleId': 'hardness.sample.sampleId',
  'hardness.sequenceNo': 'hardness.sample.sequenceNo',
  'hardness.hardType': 'hardness.sample.hardType',
};
const valueFieldIds = QUADRANTS.flatMap(quadrant => POSITIONS.flatMap(position => [
  ...SPOTS.map(spot => `hardness.q${quadrant}.${position.toLowerCase()}.${spot}`),
  `hardness.q${quadrant}.${position.toLowerCase()}.average`,
]));
const definition: RegisteredFunctionDefinition = {
  functionId: 'hardness-by-sample', version: '1.0.0', label: '按试样组织硬度测点',
  inputDatasetIds: ['quality.hardness-results'], outputDatasetId: 'quality.hardness-by-sample',
  outputFields: [...Object.values(outputIdentityFieldMap), ...valueFieldIds],
  parameterSchema: { approvedOnly: 'boolean' }, deterministic: true,
};

function err(message: string, recordId?: string, fieldId?: string): never {
  throw new ReportingError({ code: 'VALUE_TYPE_ERROR', stage: 'rule', message,
    context: { datasetId: definition.inputDatasetIds[0], ...(recordId ? { recordId } : {}), ...(fieldId ? { fieldId } : {}) } });
}

function makeHardnessRows(records: DataRecord[], parameters: Record<string, Scalar>): DataRecord[] {
  const approvedOnly = parameters.approvedOnly;
  if (typeof approvedOnly !== 'boolean') err('必须明确选择是否只使用正式审核的硬度结果', undefined, 'approvedOnly');
  const groups = new Map<string, { values: Record<string, Scalar>; recordIds: string[]; seen: Set<string> }>();
  for (const record of records) {
    const value = record.values;
    if (approvedOnly && typeof value['hardness.isApproved'] !== 'boolean')
      err('缺少正式审核状态，不能自动选择结果', record.recordId, 'hardness.isApproved');
    if (approvedOnly && value['hardness.isApproved'] !== true) continue;
    for (const fieldId of identityFields) if (typeof value[fieldId] !== 'string' || !value[fieldId])
      err(`硬度记录缺少分组字段 ${fieldId}`, record.recordId, fieldId);
    const identity = identityFields.map(fieldId => value[fieldId] as string);
    const id = encodeCompositeKey(identity);
    let group = groups.get(id);
    if (!group) {
      const values: Record<string, Scalar> = Object.fromEntries(identityFields.map((fieldId, i) => [outputIdentityFieldMap[fieldId], identity[i]]));
      for (const fieldId of valueFieldIds) values[fieldId] = null;
      group = { values, recordIds: [], seen: new Set() }; groups.set(id, group);
    }
    const quadrant = String(value['hardness.quadrant'] ?? '');
    const position = String(value['hardness.position'] ?? '').toUpperCase();
    const spot = String(value['hardness.spotNo'] ?? '');
    if (!(QUADRANTS as readonly string[]).includes(quadrant)) err(`未知硬度象限 ${quadrant}`, record.recordId, 'hardness.quadrant');
    if (!(POSITIONS as readonly string[]).includes(position)) err(`未知硬度位置 ${position}`, record.recordId, 'hardness.position');
    if (!(SPOTS as readonly string[]).includes(spot)) err(`未知硬度测点 ${spot}`, record.recordId, 'hardness.spotNo');
    const result = value['hardness.value'];
    if (result !== null && (typeof result !== 'number' || !Number.isFinite(result)))
      err('硬度结果必须是有效数字或空值', record.recordId, 'hardness.value');
    const outputId = `hardness.q${quadrant}.${position.toLowerCase()}.${spot}`;
    if (group.seen.has(outputId)) err(`同一试样的硬度位置 ${outputId} 有多个结果，请先配置正式结果视图`, record.recordId, outputId);
    group.seen.add(outputId); group.values[outputId] = result;
    group.recordIds.push(...(record.sourceRecordIds ?? [record.recordId]));
  }
  return [...groups.entries()].map(([recordId, group]) => {
    for (const quadrant of QUADRANTS) for (const position of POSITIONS) {
      const spotValues = SPOTS.map(spot => group.values[`hardness.q${quadrant}.${position.toLowerCase()}.${spot}`]);
      const present = spotValues.filter((value): value is number => typeof value === 'number');
      group.values[`hardness.q${quadrant}.${position.toLowerCase()}.average`] = present.length
        ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
    }
    return { recordId: `hardness-sample:${recordId}`, values: group.values,
      sourceRecordIds: [...new Set(group.recordIds)].sort() };
  });
}

export function createQualityFunctionRegistry(): FunctionRegistry {
  const registry = new FunctionRegistry();
  registry.register(definition, makeHardnessRows);
  return registry;
}
