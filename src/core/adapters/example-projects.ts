import type {
  DataViewDefinition, DatasetDefinition, ProjectAdapterDefinition, ProjectDefinition, ValueType,
} from '../contracts/types.ts';
import type { ProjectAdapterConfig } from './project-adapter.ts';
import { createQualityFunctionRegistry } from '../functions/hardness.ts';

const field = (fieldId: string, label: string, type: ValueType = 'text', nullable = true, unit?: string) => ({
  fieldId, label, type, nullable, ...(unit ? { unit } : {}),
});
const dataset = (datasetId: string, label: string, grain: string, primaryKey: string[], fields: DatasetDefinition['fields'], required = true): DatasetDefinition => ({
  datasetId, label, grain, primaryKey, fields, required,
});

const headerFields = [
  field('cert.printNo', '质保书打印号', 'text', false), field('cert.partFlag', '产品类别', 'text', false),
  field('cert.saleOrderSubNo', '合同分项号', 'text', false), field('cert.certificateNo', '证书编号'),
  field('cert.customer', '收货客户', 'text', false), field('cert.purchaser', '订货单位'),
  field('cert.productDescription', '产品名称'), field('cert.specification', '产品规格'),
  field('cert.customerPoNo', '客户订单号'), field('cert.contractNo', '合同号'),
  field('cert.internalReference', '内部合同号'), field('cert.issueDate', '签发日期', 'date', false),
  field('cert.makingMethod', '制造方法'), field('cert.deliveryConditions', '交货状态'),
];
const contractFields = [
  field('contract.saleOrderSubNo', '合同分项号', 'text', false), field('contract.orderNo', '合同编号', 'text', false),
  field('contract.standard', '执行标准'), field('contract.heatTreatment', '热处理要求'),
];
const materialFields = [
  field('material.printNo', '质保书打印号', 'text', false), field('material.partFlag', '产品类别', 'text', false),
  field('material.lineId', '物料明细号', 'text', false), field('material.heatNo', '炉号', 'text', false),
  field('material.lotNo', '试批号', 'text', false), field('material.pieces', '根数', 'number', false, 'PCS'),
  field('material.length', '发货长度', 'number', true, 'M'), field('material.weight', '发货重量', 'number', false, 'MT'),
  field('material.deliveryBundle', '发货捆数', 'number'),
];
const chemistryFields = [
  field('chem.printNo', '质保书打印号', 'text', false), field('chem.partFlag', '产品类别', 'text', false),
  field('chem.heatNo', '炉号', 'text', false), field('chem.lotNo', '试批号', 'text', false),
  field('chem.analysisId', '分析记录号', 'text', false), field('chem.analysisType', '分析类型', 'text', false),
  field('chem.sampleId', '试样编号'), field('chem.sequenceNo', '试验序号', 'number', false),
  ...['C', 'Si', 'Mn', 'P', 'S', 'Cr', 'Ni', 'Cu', 'Mo', 'Al', 'Nb'].map(symbol => field(`chem.${symbol}`, symbol, 'number')),
];
const tensileFields = [
  field('tensile.printNo', '质保书打印号', 'text', false), field('tensile.partFlag', '产品类别', 'text', false),
  field('tensile.heatNo', '炉号', 'text', false), field('tensile.lotNo', '试批号', 'text', false),
  field('tensile.resultId', '检验记录号', 'text', false), field('tensile.sampleId', '试样编号'),
  field('tensile.sequenceNo', '试验序号', 'number', false), field('tensile.testType', '试验项目', 'text', false),
  field('tensile.direction', '取样方向'), field('tensile.yieldStrength', '屈服强度', 'number', true, 'MPa'),
  field('tensile.tensileStrength', '抗拉强度', 'number', true, 'MPa'),
  field('tensile.yieldRatio', '屈强比', 'number'), field('tensile.elongation', '伸长率', 'number', true, '%'),
  field('tensile.impactEnergy1', '冲击功 1', 'number', true, 'J'),
  field('tensile.impactEnergy2', '冲击功 2', 'number', true, 'J'),
  field('tensile.impactEnergy3', '冲击功 3', 'number', true, 'J'),
  field('tensile.impactEnergyAverage', '冲击功平均值', 'number', true, 'J'),
];
const hardnessFields = [
  field('hardness.printNo', '质保书打印号', 'text', false), field('hardness.partFlag', '产品类别', 'text', false),
  field('hardness.heatNo', '炉号', 'text', false), field('hardness.lotNo', '试批号', 'text', false),
  field('hardness.sampleId', '试样编号', 'text', false), field('hardness.sequenceNo', '试验序号', 'text', false),
  field('hardness.hardType', '硬度类型', 'text', false), field('hardness.quadrant', '硬度象限', 'text', false),
  field('hardness.position', '硬度位置', 'text', false), field('hardness.spotNo', '测点序号', 'text', false),
  field('hardness.value', '硬度结果', 'number'), field('hardness.isApproved', '是否正式结果', 'boolean', false),
];
const hardnessOutputFields = [
  field('hardness.sample.printNo', '质保书打印号', 'text', false), field('hardness.sample.partFlag', '产品类别', 'text', false),
  field('hardness.sample.heatNo', '炉号', 'text', false), field('hardness.sample.lotNo', '试批号', 'text', false),
  field('hardness.sample.sampleId', '试样编号', 'text', false), field('hardness.sample.sequenceNo', '试验序号', 'text', false),
  field('hardness.sample.hardType', '硬度类型', 'text', false),
  ...['1', '2', '3', '4'].flatMap(quadrant => ['out', 'mid', 'in'].flatMap(position => [
    ...['1', '2', '3', '4'].map(spot => field(`hardness.q${quadrant}.${position}.${spot}`, `象限 ${quadrant} ${position.toUpperCase()} 测点 ${spot}`, 'number')),
    field(`hardness.q${quadrant}.${position}.average`, `象限 ${quadrant} ${position.toUpperCase()} 平均值`, 'number'),
  ])),
];
const inspectionFields = [
  field('inspection.printNo', '质保书打印号', 'text', false), field('inspection.partFlag', '产品类别', 'text', false),
  field('inspection.heatNo', '炉号', 'text', false), field('inspection.lotNo', '试批号', 'text', false),
  field('inspection.resultId', '检验记录号', 'text', false), field('inspection.itemCode', '检验项目编码', 'text', false),
  field('inspection.itemName', '检验项目'), field('inspection.method', '检验方法'),
  field('inspection.result', '检验结果'), field('inspection.isApproved', '是否正式结果', 'boolean', false),
];

export function createQualityProjectDefinition(
  projectId: string,
  displayName: string,
  adapterId: string,
  businessKey: ProjectDefinition['businessKey'],
): ProjectDefinition {
  const datasets = [
    dataset('certificate.header', '质保书信息', '一行对应打印号和产品类别', ['cert.printNo', 'cert.partFlag'], headerFields),
    dataset('contract.info', '合同信息', '一行对应合同分项号', ['contract.saleOrderSubNo'], contractFields),
    dataset('material.lines', '发货物料明细', '一行对应质保书内物料明细', ['material.printNo', 'material.partFlag', 'material.lineId'], materialFields),
    dataset('quality.chemistry-results', '化学分析结果', '一行对应试批分析记录及项目', ['chem.printNo', 'chem.partFlag', 'chem.heatNo', 'chem.lotNo', 'chem.analysisId'], chemistryFields),
    dataset('quality.tensile-results', '力学试验结果', '一行对应试样、试验序号及项目', ['tensile.printNo', 'tensile.partFlag', 'tensile.heatNo', 'tensile.lotNo', 'tensile.resultId'], tensileFields),
    dataset('quality.hardness-results', '硬度测点结果', '一行对应试样象限位置和测点', ['hardness.printNo', 'hardness.partFlag', 'hardness.heatNo', 'hardness.lotNo', 'hardness.sampleId', 'hardness.sequenceNo', 'hardness.quadrant', 'hardness.position', 'hardness.spotNo'], hardnessFields),
    dataset('quality.hardness-by-sample', '按试样组织的硬度结果', '一行对应试样和试验类型', ['hardness.sample.printNo', 'hardness.sample.partFlag', 'hardness.sample.heatNo', 'hardness.sample.lotNo', 'hardness.sample.sampleId', 'hardness.sample.sequenceNo', 'hardness.sample.hardType'], hardnessOutputFields, false),
    dataset('quality.inspection-results', '检验项目结果', '一行对应炉批的一个检验项目', ['inspection.printNo', 'inspection.partFlag', 'inspection.heatNo', 'inspection.lotNo', 'inspection.resultId'], inspectionFields),
  ];
  const rel = (relationshipId: string, childDatasetId: string, parentKey: string[], childForeignKey: string[], cardinality: 'one-to-one' | 'one-to-many' = 'one-to-many') => ({
    relationshipId, parentDatasetId: 'certificate.header', childDatasetId, parentKey, childForeignKey, cardinality,
  } as const);
  return {
    contractVersion: 2, projectId, displayName, projectVersion: '1.0.0', adapterId, adapterVersion: '1.0.0',
    documentTypes: ['qualityCertificate'], businessKey, datasets,
    relationships: [
      rel('header-contract', 'contract.info', ['cert.saleOrderSubNo'], ['contract.saleOrderSubNo'], 'one-to-one'),
      rel('header-materials', 'material.lines', ['cert.printNo', 'cert.partFlag'], ['material.printNo', 'material.partFlag']),
      rel('header-chemistry', 'quality.chemistry-results', ['cert.printNo', 'cert.partFlag'], ['chem.printNo', 'chem.partFlag']),
      rel('header-tensile', 'quality.tensile-results', ['cert.printNo', 'cert.partFlag'], ['tensile.printNo', 'tensile.partFlag']),
      rel('header-hardness', 'quality.hardness-by-sample', ['cert.printNo', 'cert.partFlag'], ['hardness.sample.printNo', 'hardness.sample.partFlag']),
      rel('header-inspection', 'quality.inspection-results', ['cert.printNo', 'cert.partFlag'], ['inspection.printNo', 'inspection.partFlag']),
    ],
  };
}

function sourceColumn(projectId: string, fieldId: string): string {
  if (projectId === 'dalipu-demo') {
    const dalipu: Record<string, string> = {
      'cert.printNo': 'CERTI_PRINT_NO', 'cert.partFlag': 'TUBE_COUP_FLAG',
      'cert.saleOrderSubNo': 'SALE_ORDER_SUB_NO', 'cert.customer': 'ORD_CUST_NAME',
      'cert.certificateNo': 'CERTI_NO', 'cert.customerPoNo': 'P_O_NO', 'cert.makingMethod': 'MAKE_METHOD',
      'material.printNo': 'CERTI_PRINT_NO', 'material.partFlag': 'TUBE_COUP_FLAG',
      'material.heatNo': 'HEAT_NO', 'material.lotNo': 'SAMPLE_LOT_NO',
      'material.pieces': 'MAT_NUM', 'material.length': 'TOTAL_LEN', 'material.weight': 'weight',
      'tensile.yieldStrength': 'YS_TC', 'tensile.tensileStrength': 'TS_TC',
      'tensile.yieldRatio': 'YIELD_RATE_TC', 'tensile.elongation': 'EL_TC',
      'hardness.printNo': 'CERTI_PRINT_NO',
      'hardness.partFlag': 'TUBE_COUP_FLAG', 'hardness.heatNo': 'HEAT_NO',
      'hardness.lotNo': 'SAMPLE_LOT_NO', 'inspection.printNo': 'CERTI_PRINT_NO',
      'inspection.partFlag': 'TUBE_COUP_FLAG', 'inspection.heatNo': 'HEAT_NO', 'inspection.lotNo': 'SAMPLE_LOT_NO',
    };
    if (dalipu[fieldId]) return dalipu[fieldId];
    // Non-confirmed columns in the synthetic Dalipu fixture keep their source aliases explicit in camelCase.
    return fieldId.split('.').at(-1)!;
  }
  // The second project deliberately uses a different source naming convention.
  return fieldId.split('.').at(-1)!.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

export function createExampleAdapterDefinition(project: ProjectDefinition): ProjectAdapterDefinition {
  const mappings = project.datasets.filter(item => item.required).map(item => ({
    datasetId: item.datasetId,
    sourceName: project.projectId === 'dalipu-demo'
      ? ({ 'certificate.header': 'header_by_print_no', 'contract.info': 'contract_by_sub_order',
        'material.lines': 'material_lines', 'quality.chemistry-results': 'chemistry_rows',
        'quality.tensile-results': 'mechanical_rows', 'quality.hardness-results': 'hardness_points',
        'quality.inspection-results': 'inspection_rows' } as Record<string, string>)[item.datasetId]
      : ({ 'certificate.header': 'order_summary', 'contract.info': 'order_requirements',
        'material.lines': 'shipment_coils', 'quality.chemistry-results': 'lab_chemistry',
        'quality.tensile-results': 'lab_mechanical', 'quality.hardness-results': 'lab_hardness',
        'quality.inspection-results': 'process_checks' } as Record<string, string>)[item.datasetId],
    keyFieldIds: [...item.primaryKey],
    fields: item.fields.map(field => ({ fieldId: field.fieldId, sourceColumn: sourceColumn(project.projectId, field.fieldId),
      type: field.type, nullable: field.nullable, ...(field.unit ? { unit: field.unit } : {}) })),
  }));
  return { contractVersion: 2, projectId: project.projectId, adapterId: project.adapterId, version: project.adapterVersion,
    maxRecords: 50000, datasets: mappings };
}

export function createDalipuDemoProject(): ProjectDefinition {
  return createQualityProjectDefinition('dalipu-demo', '达力普油管质保书演示适配器', 'dalipu-readonly-v1', {
    printNo: { label: '质保书打印号', type: 'text', required: true },
    productPart: { label: '产品类别', type: 'text', required: true },
  });
}

export function createSecondDemoProject(): ProjectDefinition {
  return createQualityProjectDefinition('general-mes-demo', '通用 MES 质保书演示适配器', 'generic-mes-readonly-v1', {
    certificateRequestId: { label: '质检单号', type: 'text', required: true },
  });
}

const all = <T>(items: T[]) => items;
export function createQualityDataViews(): DataViewDefinition[] {
  const project = createDalipuDemoProject();
  const definition = (datasetId: string) => project.datasets.find(item => item.datasetId === datasetId)!;
  const fields = (datasetId: string) => definition(datasetId).fields.map(item => item.fieldId);
  const sorted = (datasetId: string, by: string[]): DataViewDefinition => ({
    contractVersion: 2, viewId: `view.${datasetId.replace(/[^A-Za-z0-9]+/g, '.')}`,
    label: definition(datasetId).label, version: '1.0.0', sourceDatasetId: datasetId,
    outputFields: fields(datasetId), steps: [{ op: 'sort', by: by.map(fieldId => ({ fieldId, direction: 'asc' as const })) }],
  });
  const materials = sorted('material.lines', ['material.heatNo', 'material.lotNo', 'material.lineId']);
  const chemistry = sorted('quality.chemistry-results', ['chem.heatNo', 'chem.lotNo', 'chem.analysisType', 'chem.sequenceNo']);
  const tensile = sorted('quality.tensile-results', ['tensile.heatNo', 'tensile.lotNo', 'tensile.sequenceNo']);
  const hardnessFunction = createQualityFunctionRegistry().list()[0];
  const hardness: DataViewDefinition = {
    contractVersion: 2, viewId: 'view.hardness-by-sample', label: '按试样组织硬度结果', version: '1.0.0',
    sourceDatasetId: 'quality.hardness-results', outputFields: hardnessFunction.outputFields,
    steps: [
      { op: 'sort', by: ['hardness.heatNo', 'hardness.lotNo', 'hardness.sampleId', 'hardness.sequenceNo', 'hardness.quadrant', 'hardness.position', 'hardness.spotNo'].map(fieldId => ({ fieldId, direction: 'asc' })) },
      { op: 'applyFunction', functionId: hardnessFunction.functionId, version: hardnessFunction.version, parameters: { approvedOnly: true } },
    ],
  };
  const inspection = sorted('quality.inspection-results', ['inspection.heatNo', 'inspection.lotNo', 'inspection.itemCode']);
  const header: DataViewDefinition = {
    contractVersion: 2, viewId: 'view.certificate-header', label: '质保书基本信息与业务明细', version: '1.0.0',
    sourceDatasetId: 'certificate.header',
    outputFields: [...fields('certificate.header'), 'contract.orderNo', 'contract.standard', 'contract.heatTreatment'],
    steps: [{ op: 'lookup', relationshipId: 'header-contract', fields: [
      { childFieldId: 'contract.orderNo', outputFieldId: 'contract.orderNo' },
      { childFieldId: 'contract.standard', outputFieldId: 'contract.standard' },
      { childFieldId: 'contract.heatTreatment', outputFieldId: 'contract.heatTreatment' },
    ] }],
    children: [
      { relationshipId: 'header-materials', viewId: materials.viewId, as: 'materials', parentFieldIds: ['cert.printNo', 'cert.partFlag'], childFieldIds: ['material.printNo', 'material.partFlag'] },
      { relationshipId: 'header-chemistry', viewId: chemistry.viewId, as: 'chemistry', parentFieldIds: ['cert.printNo', 'cert.partFlag'], childFieldIds: ['chem.printNo', 'chem.partFlag'] },
      { relationshipId: 'header-tensile', viewId: tensile.viewId, as: 'tensile', parentFieldIds: ['cert.printNo', 'cert.partFlag'], childFieldIds: ['tensile.printNo', 'tensile.partFlag'] },
      { relationshipId: 'header-hardness', viewId: hardness.viewId, as: 'hardness', parentFieldIds: ['cert.printNo', 'cert.partFlag'], childFieldIds: ['hardness.sample.printNo', 'hardness.sample.partFlag'] },
      { relationshipId: 'header-inspection', viewId: inspection.viewId, as: 'inspections', parentFieldIds: ['cert.printNo', 'cert.partFlag'], childFieldIds: ['inspection.printNo', 'inspection.partFlag'] },
    ],
  };
  return all([materials, chemistry, tensile, hardness, inspection, header]);
}

export function toRuntimeAdapterConfig(definition: ProjectAdapterDefinition): ProjectAdapterConfig {
  return { ...definition, datasets: definition.datasets.map(dataset => ({ ...dataset,
    fields: dataset.fields.map(field => ({ ...field, ...(field.valueMap ? { valueMap: { ...field.valueMap } } : {}) })) })) };
}
