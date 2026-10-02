import type { BlockDefinition, CellStyle, Edge } from './model.ts';
const edge: Edge = { style: 'thin', color: '#CBD5E1' };
export const gridStyle: CellStyle = {
  fontFamily: 'Arial', fontSizePt: 11, vertical: 'middle', wrap: true,
  borders: { top: edge, right: edge, bottom: edge, left: edge },
};
export const CUSTOMER_BLOCK: BlockDefinition = {
  schemaVersion: 1, id: 'customer-info', name: '客户信息（2行×4列）', rows: 2, cols: 4,
  defaultStyle: gridStyle, merges: [],
  cells: [
    { r: 0, c: 0, text: '客户名称', style: { background: '#EEF2F6', bold: true } },
    { r: 0, c: 1, binding: { path: 'customer.name', format: 'text' } },
    { r: 0, c: 2, text: '订单号', style: { background: '#EEF2F6', bold: true } },
    { r: 0, c: 3, binding: { path: 'orderNo', format: 'text' } },
    { r: 1, c: 0, text: '联系人', style: { background: '#EEF2F6', bold: true } },
    { r: 1, c: 1, binding: { path: 'customer.contact', format: 'text' } },
    { r: 1, c: 2, text: '联系电话', style: { background: '#EEF2F6', bold: true } },
    { r: 1, c: 3, binding: { path: 'customer.phone', format: 'text' } },
  ],
};
export const BLOCKS: BlockDefinition[] = [
  { schemaVersion: 1, id: 'title', name: '单据标题头', rows: 1, cols: 4,
    defaultStyle: gridStyle, merges: [{ r: 0, c: 0, rows: 1, cols: 4 }],
    cells: [{ r: 0, c: 0, text: '销售订单', style: { horizontal: 'center', fontSizePt: 18, bold: true, background: '#E2E8F0' } }],
  },
  CUSTOMER_BLOCK,
  { schemaVersion: 1, id: 'items', name: '明细表格（整行扩展）', rows: 2, cols: 4,
    defaultStyle: gridStyle, merges: [],
    repeat: { source: 'items', rowOffset: 1, rowCount: 1, mode: 'insert', empty: 'remove' },
    cells: [
      ...['品名', '数量', '单价', '金额'].map((text, c) => ({ r: 0, c, text, style: { background: '#EEF2F6', bold: true } })),
      { r: 1, c: 0, binding: { path: 'items.name', format: 'text' } },
      { r: 1, c: 1, binding: { path: 'items.quantity', format: 'number' } },
      { r: 1, c: 2, binding: { path: 'items.price', format: 'number' } },
      { r: 1, c: 3, binding: { path: 'items.amount', format: 'number' } },
    ],
  },
  { schemaVersion: 1, id: 'approval', name: '审批汇总与签字栏', rows: 2, cols: 4,
    defaultStyle: gridStyle, merges: [{ r: 1, c: 1, rows: 1, cols: 3 }],
    cells: [
      { r: 0, c: 0, text: '合计金额' }, { r: 0, c: 1, binding: { path: 'totalAmount', format: 'number' } },
      { r: 0, c: 2, text: '审批人' }, { r: 0, c: 3, binding: { path: 'approver.name', format: 'text' } },
      { r: 1, c: 0, text: '签字' },
    ],
  },
];
