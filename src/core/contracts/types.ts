import type { TemplateDocument } from '../../domain/model.ts';

export const REPORTING_CONTRACT_VERSION = 2 as const;
export type Scalar = string | number | boolean | null;
export type ValueType = 'text' | 'number' | 'date' | 'boolean';
export type Cardinality = 'one-to-one' | 'one-to-many';

export type ContractErrorCode =
  | 'CONTRACT_INVALID' | 'CONTRACT_VERSION_UNSUPPORTED' | 'DATA_NOT_FOUND'
  | 'AMBIGUOUS_SCOPE' | 'DUPLICATE_KEY' | 'RELATION_CARDINALITY_ERROR'
  | 'FIELD_NOT_FOUND' | 'VALUE_TYPE_ERROR' | 'VIEW_INVALID'
  | 'RULE_VERSION_NOT_FOUND' | 'GROUP_TOO_LARGE' | 'LAYOUT_OVERFLOW'
  | 'PAGE_PLAN_NOT_CONVERGED' | 'TEMPLATE_MATCH_AMBIGUOUS'
  | 'REVISION_CONFLICT' | 'UNSUPPORTED_FORMULA_LAYOUT' | 'SOURCE_TIMEOUT'
  | 'SOURCE_UNAVAILABLE' | 'SOURCE_RESPONSE_INVALID' | 'RESOURCE_LIMIT_EXCEEDED';

export interface ErrorContext {
  projectId?: string;
  datasetId?: string;
  recordId?: string;
  fieldId?: string;
  viewId?: string;
  templateId?: string;
  worksheetId?: string;
  cell?: string;
  regionId?: string;
  pageNumber?: number;
  sourcePath?: string;
  [key: string]: Scalar | undefined;
}

export interface ReportingErrorShape {
  code: ContractErrorCode;
  message: string;
  stage: 'contract' | 'collect' | 'catalog' | 'view' | 'rule' | 'layout' | 'render' | 'export' | 'repository';
  context?: ErrorContext;
  retryable?: boolean;
}

export interface DataFieldDefinition {
  fieldId: string;
  label: string;
  type: ValueType;
  nullable: boolean;
  unit?: string;
}

export interface DatasetDefinition {
  datasetId: string;
  label: string;
  grain: string;
  required: boolean;
  primaryKey: string[];
  fields: DataFieldDefinition[];
}

export interface DatasetRelationship {
  relationshipId: string;
  parentDatasetId: string;
  childDatasetId: string;
  parentKey: string[];
  childForeignKey: string[];
  cardinality: Cardinality;
}

export interface BusinessKeyParameter {
  label: string;
  type: ValueType;
  required: boolean;
}

export interface ProjectDefinition {
  contractVersion: typeof REPORTING_CONTRACT_VERSION;
  projectId: string;
  displayName: string;
  projectVersion: string;
  adapterId: string;
  adapterVersion: string;
  documentTypes: string[];
  businessKey: Record<string, BusinessKeyParameter>;
  datasets: DatasetDefinition[];
  relationships: DatasetRelationship[];
}

export interface SourceRef {
  kind: 'dataset' | 'view' | 'constant' | 'parameter' | 'page';
  datasetId?: string;
  viewId?: string;
  sourceFieldId?: string;
  value?: Scalar;
  parameterId?: string;
  pageField?: 'number' | 'total' | 'recordNumber' | 'groupNumber';
}

export interface CatalogFieldDefinition {
  fieldId: string;
  label: string;
  type: ValueType;
  nullable: boolean;
  grain: string;
  unit?: string;
  source: SourceRef;
  /** A template may format a field but cannot use this property to execute code. */
  numberFormat?: string;
  group?: string;
}

export interface FieldCatalog {
  contractVersion: typeof REPORTING_CONTRACT_VERSION;
  projectId: string;
  catalogVersion: string;
  fields: CatalogFieldDefinition[];
}

export interface DataRecord {
  recordId: string;
  values: Record<string, Scalar>;
  sourceRecordIds?: string[];
}

export interface DatasetRows {
  datasetId: string;
  records: DataRecord[];
}

export interface DatasetBundle {
  contractVersion: typeof REPORTING_CONTRACT_VERSION;
  projectId: string;
  documentType: string;
  businessKey: Record<string, Scalar>;
  sourceVersion: string;
  collectedAt: string;
  datasets: DatasetRows[];
}

export interface AdapterFieldMapping {
  fieldId: string;
  sourceColumn: string;
  type: ValueType;
  nullable: boolean;
  unit?: string;
  valueMap?: Record<string, Scalar>;
}

export interface AdapterDatasetMapping {
  datasetId: string;
  sourceName: string;
  keyFieldIds: string[];
  fields: AdapterFieldMapping[];
}

export interface ProjectAdapterDefinition {
  contractVersion: typeof REPORTING_CONTRACT_VERSION;
  projectId: string;
  adapterId: string;
  version: string;
  maxRecords: number;
  datasets: AdapterDatasetMapping[];
}

export interface SourceRecordEnvelope { [column: string]: Scalar }
export interface ProjectSourceEnvelope {
  contractVersion: typeof REPORTING_CONTRACT_VERSION;
  projectId: string;
  documentType: string;
  businessKey: Record<string, string>;
  sourceVersion: string;
  collectedAt: string;
  datasets: Array<{ datasetId: string; records: SourceRecordEnvelope[] }>;
}

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'isNull';
export type AggregateOperation = 'count' | 'sum' | 'average' | 'min' | 'max';
export type DuplicateValuePolicy = 'reject' | 'sum' | 'average' | 'min' | 'max';

export type DataViewStep =
  | { op: 'filter'; fieldId: string; operator: FilterOperator; value?: Scalar | Scalar[] }
  | { op: 'sort'; by: Array<{ fieldId: string; direction: 'asc' | 'desc' }> }
  | { op: 'project'; fields: Array<{ sourceFieldId: string; outputFieldId: string }> }
  | { op: 'group'; by: string[]; aggregations: Array<{
      operation: AggregateOperation; fieldId?: string; outputFieldId: string;
    }> }
  | { op: 'pivot'; by: string[]; columnFieldId: string; valueFieldId: string;
      columns: Record<string, { value: Scalar; outputFieldId: string }>;
      duplicatePolicy: DuplicateValuePolicy }
  | { op: 'lookup'; relationshipId: string;
      fields: Array<{ childFieldId: string; outputFieldId: string }> }
  | { op: 'applyFunction'; functionId: string; version: string; parameters: Record<string, Scalar> };

export interface ChildViewBinding {
  relationshipId: string;
  viewId: string;
  as: string;
  parentFieldIds: string[];
  childFieldIds: string[];
}

export interface DataViewDefinition {
  contractVersion: typeof REPORTING_CONTRACT_VERSION;
  viewId: string;
  label: string;
  version: string;
  sourceDatasetId: string;
  outputFields: string[];
  steps: DataViewStep[];
  children?: ChildViewBinding[];
}

export interface ViewRecord extends DataRecord {
  sourceRecordIds: string[];
  children?: Record<string, ViewRecord[]>;
}

export interface DataViewResult {
  viewId: string;
  viewVersion: string;
  datasetId: string;
  outputFields: string[];
  records: ViewRecord[];
  inputRecordCount: number;
  outputRecordCount: number;
  diagnostics: string[];
}

export interface RegisteredFunctionDefinition {
  functionId: string;
  version: string;
  label: string;
  inputDatasetIds: string[];
  outputDatasetId: string;
  outputFields: string[];
  parameterSchema: Record<string, ValueType>;
  deterministic: true;
}

export interface TemplateFieldBinding {
  fieldId: string;
  format: ValueType;
}

export interface TemplateWorksheet {
  worksheetId: string;
  name: string;
  visible: boolean;
  /** v0.2 document fields are preserved during migration; T07 upgrades storage. */
  bindingMode: 'stable-field-id' | 'legacy-path';
  document: TemplateDocument;
}

export interface PageMarginMm { top: number; right: number; bottom: number; left: number }
export interface TemplateImagePlacement {
  imageId: string;
  resourceId: string;
  worksheetId: string;
  rect: { r: number; c: number; rows: number; cols: number };
  repeatOn?: 'all' | 'first' | 'last';
}
export interface PageRegionDefinition {
  regionId: string;
  worksheetId: string;
  label: string;
  kind: 'fixed' | 'detail' | 'header' | 'footer' | 'groupHeader' | 'groupFooter';
  rect: { r: number; c: number; rows: number; cols: number };
  viewId?: string;
  paginationGroupId?: string;
  groupBy?: string[];
  orderBy?: Array<{ fieldId: string; direction: 'asc' | 'desc' }>;
  /** Number of physical rows occupied by each logical view record. */
  recordHeight?: number;
  /** Maximum repeat-area height in worksheet rows. Defaults to the remaining printable rows. */
  capacityRows?: number;
  emptyPolicy?: 'keep' | 'hide';
  keepGroupsTogether?: boolean;
  oversizedGroupPolicy?: 'error' | 'split-records';
  repeatOn?: 'all' | 'first' | 'last';
  /** Stable field IDs to merge vertically when consecutive records share a group value. */
  mergeFieldIds?: string[];
  /** Stable field IDs to display only once within a page group. */
  hideRepeatedFieldIds?: string[];
  /** Stable field IDs identifying the key repeated at the start of continuation pages. */
  repeatGroupFieldIds?: string[];
  appendixIfViewHasRecords?: string;
  blankRows?: 'keep' | 'remove';
}

export interface PageDefinition {
  pageDefinitionId: string;
  label: string;
  pageType: 'main' | 'continuation' | 'appendix';
  /** Legacy definitions remain fixed; flow is selected explicitly. */
  paginationMode?: 'fixed' | 'flow';
  worksheetIds: string[];
  paperSize: 'A4' | 'A3' | 'Letter' | 'Legal' | 'custom';
  orientation: 'portrait' | 'landscape';
  customPaperMm?: { width: number; height: number };
  marginsMm: PageMarginMm;
  printableRect?: { r: number; c: number; rows: number; cols: number };
  repeatHeaderRows?: number[];
  continuationOf?: string;
  regions: PageRegionDefinition[];
  imagePlacements?: TemplateImagePlacement[];
}

export interface TemplatePackage {
  contractVersion: typeof REPORTING_CONTRACT_VERSION;
  packageId: string;
  projectId: string;
  name: string;
  revision: number;
  status: 'draft' | 'published' | 'disabled';
  catalogVersion: string;
  viewRefs: Array<{ viewId: string; version: string }>;
  functionRefs: Array<{ functionId: string; version: string }>;
  /** Editable view definitions are drafts; published templates reference immutable versions above. */
  viewDrafts?: DataViewDefinition[];
  worksheets: TemplateWorksheet[];
  pageDefinitions?: PageDefinition[];
  resources?: Array<{ resourceId: string; mediaType: string; base64: string }>;
  /** The original imported XLSX is stored once for the entire package. */
  sourceWorkbook?: { fileName: string; base64: string };
}

export interface PageRecordAllocation {
  regionId: string;
  viewId: string;
  recordIds: string[];
  groupKeys: Scalar[][];
  startRow?: number;
  recordHeight?: number;
}

export interface PagePlanEntry {
  pageNumber: number;
  pageType: string;
  pageDefinitionId: string;
  pageGroupId?: string;
  worksheetIds?: string[];
  rowHeightsPx?: Record<string, number[]>;
  flowItems?: Array<{ regionId: string; viewId: string; recordId: string; groupKey: Scalar[]; startRow: number; rowHeightsPx: number[] }>;
  allocations: PageRecordAllocation[];
  blankRows: Record<string, number>;
  diagnostics: ReportingErrorShape[];
}

export interface PagePlan {
  contractVersion: typeof REPORTING_CONTRACT_VERSION;
  templateId: string;
  templateVersion: number;
  pages: PagePlanEntry[];
  totalPages: number;
  groupCount: number;
}

export interface GenerationSnapshot {
  contractVersion: typeof REPORTING_CONTRACT_VERSION;
  generationId: string;
  projectId: string;
  businessKey: Record<string, Scalar>;
  templateRef: { packageId: string; revision: number };
  catalogVersion: string;
  viewRefs: Array<{ viewId: string; version: string }>;
  functionRefs: Array<{ functionId: string; version: string }>;
  collectedAt: string;
  sourceVersion: string;
  data: DatasetBundle;
  viewResults: DataViewResult[];
  pagePlan?: PagePlan;
  output?: { fileName: string; mediaType: string; sha256: string; byteLength: number };
}
