export type Format = 'text' | 'number' | 'date' | 'boolean';
export type Syntax = 'mustache' | 'dollar';
export interface Rect { r: number; c: number; rows: number; cols: number }
export interface Binding { path: string; format: Format; fieldId?: string }
export interface Edge { style: 'thin' | 'medium' | 'dashed'; color: string }
export interface CellStyle {
  fontFamily?: string; fontSizePt?: number; bold?: boolean;
  color?: string; background?: string;
  horizontal?: 'left' | 'center' | 'right';
  vertical?: 'top' | 'middle' | 'bottom'; wrap?: boolean;
  borders?: Partial<Record<'top' | 'right' | 'bottom' | 'left', Edge>>;
}
export interface Cell {
  text?: string; binding?: Binding; style?: CellStyle; owner?: string;
  /** Original Excel value/style are retained until the corresponding property is edited. */
  excelValue?: unknown; excelStyle?: Record<string, unknown>; styleEdits?: CellStyle; numFmt?: string;
}
export interface RepeatRegion {
  id: string; name: string; source: string; rect: Rect;
  empty: 'remove' | 'keep'; parentId?: string;
}
export interface ExcelSource {
  fileName: string; sheetName: string; base64: string; warnings: string[];
}
export interface LocalCell extends Cell { r: number; c: number }
export interface RepeatSpec {
  source: string; rowOffset: number; rowCount: number;
  mode: 'insert'; empty: 'remove' | 'keep';
}
export interface BlockDefinition {
  schemaVersion: 1; id: string; name: string; rows: number; cols: number;
  cells: LocalCell[]; merges: Rect[]; defaultStyle?: CellStyle;
  repeat?: RepeatSpec;
}
export interface BlockInstance {
  id: string; definitionId: string; rect: Rect; repeat?: RepeatSpec;
}
export interface TemplateDocument {
  schemaVersion: 1; id: string; revision: number; name: string; sheetName: string;
  syntax: Syntax; rows: number; cols: number;
  rowHeightPx: number[]; colWidthPx: number[];
  cells: Record<string, Cell>; merges: Rect[]; blocks: BlockInstance[];
  fields?: Field[]; repeatRegions?: RepeatRegion[]; excelSource?: ExcelSource;
}
export interface Field {
  path: string; label: string; format: Format; collection?: string;
  group?: string; required?: boolean; example?: string; numberFormat?: string;
  /** Stable business identity used by reporting contracts; path remains the v0.2 binding alias. */
  fieldId?: string;
  sourceKind?: 'legacy' | 'dataset' | 'view' | 'constant' | 'parameter' | 'page' | 'derived';
  datasetId?: string; viewId?: string; sourceFieldId?: string; parameterId?: string;
  functionId?: string; functionVersion?: string;
  unit?: string; grain?: string;
  constantValue?: string | number | boolean | null;
  pageField?: 'number' | 'total' | 'recordNumber' | 'groupNumber';
  aggregate?: { scope: 'page' | 'document' | 'group'; viewId: string; fieldId: string; operation: 'count' | 'sum' | 'average' | 'min' | 'max' };
  scope?: string;
}
export const FIELDS: Field[] = [
  { path: 'orderNo', label: '订单号', format: 'text' },
  { path: 'orderDate', label: '订单日期', format: 'date' },
  { path: 'customer.name', label: '客户名称', format: 'text' },
  { path: 'customer.contact', label: '联系人', format: 'text' },
  { path: 'customer.phone', label: '联系电话', format: 'text' },
  { path: 'items.name', label: '品名', format: 'text', collection: 'items' },
  { path: 'items.quantity', label: '数量', format: 'number', collection: 'items' },
  { path: 'items.price', label: '单价', format: 'number', collection: 'items' },
  { path: 'items.amount', label: '金额', format: 'number', collection: 'items' },
  { path: 'totalAmount', label: '总金额', format: 'number' },
  { path: 'approver.name', label: '审批人', format: 'text' },
];
export const keyOf = (r: number, c: number) => `${r}:${c}`;
// This project deliberately accepts JSON-only state. This also works on older CEF runtimes.
export function copy<T>(value: T): T {
  // Strings are immutable. Avoid repeatedly serializing the retained source XLSX into undo snapshots.
  if (Array.isArray(value)) return value.map(item => copy(item)) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, copy(item)]),
  ) as T;
  return value;
}
export function newDocument(): TemplateDocument {
  return {
    schemaVersion: 1, id: 'order-template', revision: 0, name: '业务单据模板',
    sheetName: '单据', syntax: 'mustache', rows: 60, cols: 12,
    rowHeightPx: Array(60).fill(32), colWidthPx: Array(12).fill(140),
    cells: {}, merges: [], blocks: [],
  };
}
export const documentFields = (doc: TemplateDocument): Field[] => doc.fields ?? FIELDS;
export function fieldByPath(path: string, fields: Field[] = FIELDS): Field {
  const field = fields.find(f => f.path === path);
  if (!field) throw new Error(`未授权或未知字段：${path}`);
  return field;
}
export function displayText(cell: Cell, syntax: Syntax): string {
  if (!cell.binding) return cell.text ?? '';
  const path = cell.binding.path;
  return syntax === 'mustache' ? `{{${path}}}` : '${' + path + '}';
}
export const numberFormat = (cell: Cell): string =>
  cell.numFmt ?? (cell.binding?.format === 'number' ? '#,##0.00'
    : cell.binding?.format === 'date' ? 'yyyy-mm-dd' : '@');
