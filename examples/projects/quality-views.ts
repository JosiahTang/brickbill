import type { DataViewDefinition } from '../../src/core/contracts/types.ts';

/** Add one common grouping vocabulary to existing views without changing their selection rules. */
export function createPrintViews(base: DataViewDefinition[]): DataViewDefinition[] {
  const sources: Array<[string, string, string, string]> = [
    ['view.material.lines', 'material.heatNo', 'material.lotNo', 'material'],
    ['view.quality.chemistry.results', 'chem.heatNo', 'chem.lotNo', 'chemistry'],
    ['view.quality.tensile.results', 'tensile.heatNo', 'tensile.lotNo', 'tensile'],
    ['view.hardness-by-sample', 'hardness.sample.heatNo', 'hardness.sample.lotNo', 'hardness'],
    ['view.quality.inspection.results', 'inspection.heatNo', 'inspection.lotNo', 'inspection'],
  ];
  return sources.map(([sourceId, heatNo, lotNo, suffix]) => {
    const original = base.find(view => view.viewId === sourceId);
    if (!original) throw new Error(`Missing base view ${sourceId}`);
    return {
      ...structuredClone(original), viewId: `view.certificate.${suffix}-print`,
      label: `${original.label}（打印分组）`,
      outputFields: [...original.outputFields, 'report.heatNo', 'report.lotNo'],
      steps: [...structuredClone(original.steps), { op: 'project' as const, fields: [
        ...original.outputFields.map(fieldId => ({ sourceFieldId: fieldId, outputFieldId: fieldId })),
        { sourceFieldId: heatNo, outputFieldId: 'report.heatNo' },
        { sourceFieldId: lotNo, outputFieldId: 'report.lotNo' },
      ] }],
      children: undefined,
    };
  });
}
