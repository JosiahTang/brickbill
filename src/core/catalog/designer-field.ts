import type { Field } from '../../domain/model.ts';
import type { CatalogFieldDefinition } from '../contracts/types.ts';

/** Converts a stable service field into the designer's editable binding alias. */
export function catalogDatasetField(item: CatalogFieldDefinition): Field | undefined {
  if (item.source.kind !== 'dataset' || !item.source.datasetId || !item.source.sourceFieldId) return undefined;
  // Designer paths are identifiers, while business IDs may contain numeric-only segments.
  const path = item.fieldId.split('.').map(segment => /^\d+$/.test(segment) ? `n${segment}` : segment).join('.');
  return { path, fieldId: item.fieldId, label: item.label, format: item.type, sourceKind: 'dataset',
    datasetId: item.source.datasetId, sourceFieldId: item.source.sourceFieldId,
    grain: item.grain, unit: item.unit, numberFormat: item.numberFormat,
    group: item.group ?? item.source.datasetId, required: !item.nullable };
}
