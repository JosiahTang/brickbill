import { newDocument, keyOf, type TemplateDocument, type CellStyle } from './model.ts';
import { inferFields } from './fields.ts';
import { validateDocument } from './operations.ts';

export const certificateData = {
  certificate: { number: 'QC-2026-001', issueDate: '2026-09-30', product: '热轧无缝套管', standard: 'API 5CT', purchaser: '示例采购单位', customer: '示例收货单位', deliveryLength: 599.97, weight: 36.062 },
  chemistry: [
    { heatNo: '2512865', lotNo: '25706099', pcs: 5, length: 58.38, tests: [{ type: 'R', C: 0.26, Si: 0.23, Mn: 0.64, P: 0.0086, S: 0.0023 }, { type: 'C', C: 0.26, Si: 0.21, Mn: 0.64, P: 0.0086, S: 0.0017 }] },
    { heatNo: '2512867', lotNo: '25706095', pcs: 6, length: 70.75, tests: [{ type: 'R', C: 0.26, Si: 0.21, Mn: 0.65, P: 0.0082, S: 0.0018 }, { type: 'C', C: 0.26, Si: 0.19, Mn: 0.64, P: 0.0087, S: 0.0017 }, { type: 'C', C: 0.25, Si: 0.19, Mn: 0.65, P: 0.0088, S: 0.0014 }] },
  ],
  mechanical: [
    { heatNo: '2512865', yieldStrength: 627, tensileStrength: 731, elongation: 30, impact: 86, hardness: 19.5 },
    { heatNo: '2512867', yieldStrength: 618, tensileStrength: 720, elongation: 32, impact: 86, hardness: 18.7 },
  ],
  inspections: [{ location: '管体 Pipe Body', method: 'UT', standard: 'ISO 10893-10', level: 'U2', result: '合格 Passed' }, { location: '管端 Pipe End', method: 'UT', standard: 'ISO 10893-10', level: 'U2', result: '合格 Passed' }],
  remark: '示例数据仅用于验证模板绑定与多行生成，请替换为实际业务数据。', manager: '质量负责人',
};
const labels: Record<string, string> = { number: '证明书号', issueDate: '签发日期', product: '产品名称', standard: '执行标准', purchaser: '订货单位', customer: '收货单位', deliveryLength: '发货长度', weight: '发货重量', heatNo: '炉号', lotNo: '试批号', pcs: '根数', length: '长度', type: '试验类型', C: '碳 C', Si: '硅 Si', Mn: '锰 Mn', P: '磷 P', S: '硫 S', yieldStrength: '屈服强度', tensileStrength: '抗拉强度', elongation: '伸长率', impact: '冲击功', hardness: '硬度', location: '位置', method: '探伤方式', level: '等级', result: '结果', remark: '备注', manager: '质量负责人' };
export function createCertificateDocument(): TemplateDocument {
  const doc = newDocument(); doc.id = 'quality-certificate'; doc.name = '产品质量证明书'; doc.sheetName = '质量证明书';
  doc.rows = 30; doc.cols = 18; doc.rowHeightPx = Array(30).fill(30); doc.colWidthPx = Array(18).fill(66);
  doc.fields = inferFields(certificateData).map(f => ({ ...f, fieldId: `field.${f.path.replaceAll('.', '_')}`, label: labels[f.path.split('.').at(-1)!] ?? f.label,
    numberFormat: f.format === 'number' ? (f.path.includes('tests.') ? '0.0000' : '0.###') : undefined }));
  const base: CellStyle = { fontSizePt: 10, horizontal: 'center', vertical: 'middle', wrap: true, borders: Object.fromEntries(['top', 'right', 'bottom', 'left'].map(side => [side, { style: 'thin', color: '#334155' }])) };
  for (let r = 0; r < 26; r++) for (let c = 0; c < 18; c++) doc.cells[keyOf(r, c)] = { style: structuredClone(base) };
  function cell(r: number, c: number, cols: number, text: string, field = false, rows = 1) {
    if (cols > 1 || rows > 1) doc.merges.push({ r, c, cols, rows });
    const target = doc.cells[keyOf(r, c)];
    if (field) { const f = doc.fields!.find(f => f.path === text)!; target.binding = { path: text, format: f.format, fieldId: f.fieldId }; target.numFmt = f.numberFormat; }
    else target.text = text;
  }
  cell(0, 0, 18, '产 品 质 量 证 明 书', false); doc.cells['0:0'].style = { ...base, fontSizePt: 22, bold: true }; doc.rowHeightPx[0] = 44;
  cell(1, 0, 18, 'INSPECTION CERTIFICATE');
  for (const [r, c, label, path] of [[2, 0, '订货单位 / Purchaser', 'certificate.purchaser'], [3, 0, '收货单位 / Customer', 'certificate.customer'], [4, 0, '标准 / Specification', 'certificate.standard'], [2, 9, '产品名称 / Product', 'certificate.product'], [3, 9, '证明书号 / Certificate No.', 'certificate.number'], [4, 9, '签发日期 / Issue Date', 'certificate.issueDate']] as const) { cell(r, c, 3, label); cell(r, c + 3, 6, path, true); }
  cell(5, 0, 3, '发货长度 (m)'); cell(5, 3, 6, 'certificate.deliveryLength', true); cell(5, 9, 3, '发货重量 (MT)'); cell(5, 12, 6, 'certificate.weight', true);
  cell(6, 0, 18, '化学成分 / Chemical Composition');
  ['炉号 Heat No.', '试批号 Lot No.', '根数 PCS', '长度 (m)', '类型', 'C', 'Si', 'Mn', 'P', 'S'].forEach((label, i) => cell(7, i < 4 ? i * 2 : 8 + (i - 4), i < 4 ? 2 : 1, label));
  for (const [c, path] of [[0, 'heatNo'], [2, 'lotNo'], [4, 'pcs'], [6, 'length']] as const) cell(8, c, 2, `chemistry.${path}`, true, 3);
  cell(8, 8, 10, '试验记录 / 每炉可包含多次分析');
  ['type', 'C', 'Si', 'Mn', 'P', 'S'].forEach((path, i) => cell(9, 8 + i, 1, `chemistry.tests.${path}`, true));
  cell(10, 8, 10, '成分数值由业务系统提供，模板不改变计量单位');
  cell(11, 0, 18, '力学性能 / Mechanical Properties');
  ['炉号', '屈服强度 MPa', '抗拉强度 MPa', '伸长率 %', '冲击功 J', '硬度 HRC'].forEach((label, i) => cell(12, i * 3, 3, label));
  ['heatNo', 'yieldStrength', 'tensileStrength', 'elongation', 'impact', 'hardness'].forEach((path, i) => cell(13, i * 3, 3, `mechanical.${path}`, true));
  cell(14, 0, 18, '无损检测 / Non-Destructive Test');
  for (const [c, cols, label] of [[0, 4, '位置'], [4, 3, '探伤方式'], [7, 4, '标准'], [11, 3, '等级'], [14, 4, '结果']] as const) cell(15, c, cols, label);
  for (const [c, cols, path] of [[0, 4, 'location'], [4, 3, 'method'], [7, 4, 'standard'], [11, 3, 'level'], [14, 4, 'result']] as const) cell(16, c, cols, `inspections.${path}`, true);
  cell(17, 0, 18, '工艺项目检验 / Process Inspection Items');
  cell(18, 0, 6, '水压试验 / Hydrostatic Test'); cell(18, 6, 6, '尺寸检验 / Dimension Inspection'); cell(18, 12, 6, '表面检验 / Visual Inspection');
  cell(19, 0, 6, '合格 Passed'); cell(19, 6, 6, '合格 Passed'); cell(19, 12, 6, '合格 Passed');
  cell(20, 0, 2, '备注'); cell(20, 2, 16, 'remark', true, 2); cell(21, 0, 2, 'Remark');
  cell(22, 0, 14, '兹证明本表所列产品按约定要求制造、取样、检验和试验。', false, 2); cell(22, 14, 4, '技术质量负责人'); cell(23, 14, 4, 'manager', true);
  cell(24, 0, 18, 'This is a sample layout for template design.'); cell(25, 0, 18, '');
  for (const r of [6, 11, 14, 17]) doc.cells[keyOf(r, 0)].style = { ...base, bold: true, background: '#E8EEF5' };
  doc.repeatRegions = [
    { id: 'chem', name: '化学成分 · 按炉号', source: 'chemistry', rect: { r: 8, c: 0, rows: 3, cols: 18 }, empty: 'keep' },
    { id: 'chem-tests', name: '每炉多次分析', source: 'chemistry.tests', parentId: 'chem', rect: { r: 9, c: 8, rows: 1, cols: 10 }, empty: 'keep' },
    { id: 'mech', name: '力学性能', source: 'mechanical', rect: { r: 13, c: 0, rows: 1, cols: 18 }, empty: 'keep' },
    { id: 'inspection', name: '无损检测', source: 'inspections', rect: { r: 16, c: 0, rows: 1, cols: 18 }, empty: 'keep' },
  ];
  validateDocument(doc); return doc;
}
