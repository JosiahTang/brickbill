import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { copy, documentFields, newDocument } from '../src/domain/model.ts';
import { inferFields, upsertField, removeField, addInferredFields } from '../src/domain/fields.ts';
import { transaction, bindField, styleRange } from '../src/domain/operations.ts';
import { createPinia, setActivePinia } from 'pinia';
import { useDesignerStore } from '../src/stores/designer.ts';
import { generateDocument } from '../src/domain/generate.ts';
import { createCertificateDocument, certificateData } from '../src/domain/certificate.ts';
import { importExcel, parseDocumentJson, METADATA_SHEET } from '../src/export/importExcel.ts';
import { exportTemplate } from '../src/export/excel.ts';

const listDoc = () => {
  const d = newDocument(); d.fields = [{ path: 'records.value', label: '数值', format: 'number', collection: 'records' }];
  d.repeatRegions = [{ id: 'records', source: 'records', name: '明细', rect: { r: 2, c: 0, rows: 2, cols: 12 }, empty: 'remove' }];
  d.cells = { '0:0': { text: '表头' }, '2:0': { binding: { path: 'records.value', format: 'number' }, style: { bold: true } }, '3:0': { text: '每条记录备注' }, '4:0': { text: '页脚' } };
  d.merges = [{ r: 2, c: 0, rows: 1, cols: 2 }]; return d;
};
test('custom dictionary fields bind and rename atomically, used fields cannot be deleted', () => {
  let d = transaction(newDocument(), d => upsertField(d, { path: 'certificate.no', label: '证明书', format: 'text' }));
  d = transaction(d, d => bindField(d, 0, 0, 'certificate.no'));
  assert.throws(() => transaction(d, d => removeField(d, 'certificate.no')), /已绑定/);
  d = transaction(d, d => upsertField(d, { path: 'certificate.number', label: '编号', format: 'text' }, 'certificate.no'));
  assert.equal(d.cells['0:0'].binding.path, 'certificate.number');
  assert.throws(() => transaction(d, d => upsertField(d, { path: 'certificate.number', label: '重复', format: 'text' })), /重复/);
});
test('JSON inference unions all rows and nested arrays without overriding existing labels', () => {
  const data = { samples: [{ heat: '001', tests: [{ C: 0.23 }] }, { batch: 'A', tests: [{ Mn: 0.64 }] }], date: '2026-09-30' };
  const inferred = inferFields(data);
  assert.equal(inferred.find(f => f.path === 'samples.tests.Mn').collection, 'samples.tests');
  assert.ok(inferred.some(f => f.path === 'samples.batch'));
  const d = newDocument(); upsertField(d, { path: 'date', label: '签发日期', format: 'text' }); addInferredFields(d, data);
  assert.equal(documentFields(d).find(f => f.path === 'date').label, '签发日期');
});
test('unsafe paths, primitive arrays and duplicate paths are rejected', () => {
  assert.throws(() => inferFields(JSON.parse('{"__proto__":{"x":1}}')), /路径/);
  assert.throws(() => inferFields({ values: [1, 2] }), /对象数组/);
  assert.throws(() => inferFields({ 'bad-key': 'x' }), /路径/);
});
test('multirow records expand values, merges, row heights and footer without mutating template', () => {
  const d = listDoc(), before = JSON.stringify(d); d.rowHeightPx[2] = 41;
  const out = generateDocument(d, { records: [{ value: 0 }, { value: 3 }, { value: 7 }] });
  assert.equal(out.document.cells['2:0'].excelValue, 0); assert.equal(out.document.cells['6:0'].excelValue, 7);
  assert.equal(out.document.cells['8:0'].text, '页脚'); assert.equal(out.rowMap[4], 8);
  assert.equal(out.document.rowHeightPx[6], 41); assert.equal(out.document.merges.length, 3);
  d.rowHeightPx[2] = 32; assert.equal(JSON.stringify(d), before);
});
test('zero and one records obey empty policy and do not lose the footer', () => {
  const d = listDoc();
  assert.equal(generateDocument(d, { records: [] }).document.cells['2:0'].text, '页脚');
  d.repeatRegions[0].empty = 'keep';
  const empty = generateDocument(d, { records: [] }).document;
  assert.equal(empty.cells['2:0'].text, ''); assert.equal(empty.cells['4:0'].text, '页脚');
  assert.equal(generateDocument(d, { records: [{ value: 2 }] }).document.rows, d.rows);
});
test('quality certificate expands nested and independent regions, stretching heat-number merges', () => {
  const d = createCertificateDocument(), out = generateDocument(d, certificateData);
  assert.equal(out.document.rows, 38); assert.equal(out.recordCount, 11);
  assert.equal(out.document.cells['8:0'].text, '2512865'); assert.equal(out.document.cells['12:0'].text, '2512867');
  assert.deepEqual(out.document.merges.find(m => m.r === 8 && m.c === 0), { r: 8, c: 0, rows: 4, cols: 2 });
  assert.deepEqual(out.document.merges.find(m => m.r === 12 && m.c === 0), { r: 12, c: 0, rows: 5, cols: 2 });
  assert.equal(out.document.cells['9:9'].excelValue, 0.26); assert.equal(out.document.cells['15:9'].excelValue, 0.25);
  assert.equal(out.document.cells['31:14'].text, '质量负责人');
  assert.ok(Object.values(out.document.cells).every(c => !c.binding)); assert.deepEqual(out.warnings, []);
});
test('nested empty children keep or remove correctly while parent merge remains coherent', () => {
  const d = createCertificateDocument(), data = copy(certificateData); data.chemistry[0].tests = [];
  assert.equal(generateDocument(d, data).document.merges.find(m => m.r === 8 && m.c === 0).rows, 3);
  d.repeatRegions[1].empty = 'remove';
  assert.equal(generateDocument(d, data).document.merges.find(m => m.r === 8 && m.c === 0).rows, 2);
});
test('repeat validation catches overlaps, missing parents, cycles and cross-boundary merges', () => {
  const d = listDoc();
  assert.throws(() => transaction(d, d => d.repeatRegions.push({ ...d.repeatRegions[0], id: 'other' })), /重叠/);
  assert.throws(() => transaction(d, d => d.repeatRegions[0].parentId = 'missing'), /不存在/);
  assert.throws(() => transaction(d, d => d.repeatRegions[0].parentId = 'records'), /循环/);
  assert.throws(() => transaction(d, d => d.merges.push({ r: 1, c: 5, rows: 2, cols: 1 })), /边界/);
});
test('required and typed values fail before producing a misleading document', () => {
  const d = listDoc(); d.fields[0].required = true;
  assert.throws(() => generateDocument(d, { records: [{}] }), /必填/);
  assert.throws(() => generateDocument(d, { records: [{ value: '5' }] }), /有效数字/);
  assert.throws(() => generateDocument(d, { records: 'not-array' }), /必须是数组/);
});
test('generation handles hundreds of rows and enforces capacity limits', () => {
  const d = listDoc(); const out = generateDocument(d, { records: Array.from({ length: 240 }, (_, value) => ({ value })) });
  assert.equal(out.document.cells['480:0'].excelValue, 239); assert.equal(out.document.cells['482:0'].text, '页脚');
  assert.throws(() => generateDocument(d, { records: Array.from({ length: 6000 }, () => ({ value: 1 })) }), /超过/);
});
async function sourceWorkbook() {
  const wb = new ExcelJS.Workbook(); const s = wb.addWorksheet('质保模板', { pageSetup: { orientation: 'landscape', paperSize: 9, printArea: 'A1:BF25', printTitlesRow: '1:4' } });
  wb.addWorksheet('说明').getCell('A1').value = '保留此表';
  s.mergeCells('A1:F2'); s.getCell('A1').value = '质量证明书'; s.getCell('A1').font = { name: 'Arial', size: 16, bold: true, italic: true };
  s.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
  s.getCell('A4').value = 1.2345; s.getCell('A4').numFmt = '0.0000';
  s.getCell('B4').value = new Date('2026-09-30T00:00:00Z'); s.getCell('B4').numFmt = 'yyyy-mm-dd';
  s.getCell('C4').value = { formula: 'A4*2', result: 2.469 };
  s.getCell('A6').border = { top: { style: 'double', color: { argb: 'FF123456' } } };
  s.getCell('BF25').value = '页脚'; s.getRow(2).height = 11; s.getColumn(58).width = 3;
  const image = wb.addImage({ base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', extension: 'png' });
  s.addImage(image, { tl: { col: 15, row: 1 }, ext: { width: 30, height: 30 } });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
test('imports wide quality layouts, narrow columns, merges, blank-cell styles, dates and formulas', async () => {
  const d = await importExcel(await sourceWorkbook(), 'fixture.xlsx', '质保模板');
  assert.equal(d.cols, 58); assert.equal(d.rows, 25); assert.equal(d.rowHeightPx[1], 11 * 96 / 72);
  assert.equal(d.cells['3:0'].excelValue, 1.2345); assert.equal(d.cells['3:1'].excelValue.date, '2026-09-30T00:00:00.000Z');
  assert.equal(d.cells['3:2'].excelValue.formula, 'A4*2'); assert.equal(d.cells['1:1'].text, undefined);
  assert.equal(d.cells['5:0'].excelStyle.border.top.style, 'double');
});
test('Excel save/reopen retains custom dictionary, repeats, original styles, other sheets and images', async () => {
  let d = await importExcel(await sourceWorkbook(), 'fixture.xlsx', '质保模板');
  d = transaction(d, d => { upsertField(d, { path: 'certificate.number', label: '证明书号', format: 'text' }); bindField(d, 1, 3, 'certificate.number', true); });
  const bytes = await exportTemplate(d), wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes);
  const s = wb.getWorksheet('质保模板');
  assert.equal(s.getCell('A1').value, '{{certificate.number}}'); assert.equal(s.getCell('A1').font.italic, true);
  assert.equal(s.getCell('A6').border.top.style, 'double'); assert.equal(s.getCell('C4').formula, 'A4*2');
  assert.equal(s.getCell('B4').value.toISOString(), '2026-09-30T00:00:00.000Z');
  assert.equal(s.pageSetup.orientation, 'landscape'); assert.equal(s.pageSetup.printTitlesRow, '1:4');
  assert.equal(s.getImages().length, 1); assert.equal(wb.getWorksheet('说明').getCell('A1').value, '保留此表');
  assert.equal(wb.getWorksheet(METADATA_SHEET).state, 'veryHidden');
  const restored = await importExcel(bytes, 'saved.xlsx'); assert.equal(restored.cells['0:0'].binding.path, 'certificate.number');
  assert.ok(documentFields(restored).some(f => f.path === 'certificate.number'));
  const second = await exportTemplate(restored); assert.ok(second.length < bytes.length * 1.1, 'metadata should not recursively embed source workbooks');
});
test('saved complex template restores nested rules and produces typed generated Excel without metadata', async () => {
  const restored = await importExcel(await exportTemplate(createCertificateDocument()), 'saved.xlsx');
  assert.deepEqual(restored.repeatRegions, createCertificateDocument().repeatRegions);
  const result = generateDocument(restored, certificateData);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await exportTemplate(result.document, { embed: false, rowMap: result.rowMap }));
  const sheet = wb.getWorksheet(restored.sheetName);
  assert.equal(sheet.getCell('J10').value, 0.26); assert.equal(sheet.getCell('J10').numFmt, '0.0000');
  assert.equal(sheet.getCell('M5').value.toISOString(), '2026-09-30T00:00:00.000Z');
  assert.equal(wb.getWorksheet(METADATA_SHEET), undefined);
  assert.ok(sheet.getCell('A12').isMerged); assert.equal(sheet.getCell('A12').master.address, 'A9');
});
test('formula expansion is rejected explicitly and legacy JSON remains loadable', () => {
  const d = listDoc(); d.cells['0:2'] = { text: '2', excelValue: { formula: '1+1', result: 2 } };
  assert.throws(() => generateDocument(d, { records: [{ value: 1 }, { value: 2 }] }), /公式/);
  assert.equal(parseDocumentJson(JSON.stringify({ document: newDocument() })).sheetName, '单据');
  assert.throws(() => parseDocumentJson('{"document":{"schemaVersion":99}}'), /结构/);
});
test('adding a field to an existing populated layout never binds static labels', () => {
  const d = newDocument(); d.cells['0:0'] = { text: 'Existing label' };
  const next = transaction(d, d => upsertField(d, { path: 'custom', label: '新增', format: 'text' }));
  assert.deepEqual(next.cells['0:0'], d.cells['0:0']);
});
test('format edits propagate across imported merged cells without losing original font details', async () => {
  let doc = await importExcel(await sourceWorkbook(), 'fixture.xlsx', '质保模板');
  doc = transaction(doc, d => styleRange(d, { r: 0, c: 0, rows: 2, cols: 6 }, { background: '#00CCFF' }));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await exportTemplate(doc));
  const s = wb.getWorksheet(doc.sheetName);
  assert.equal(s.getCell('A1').font.italic, true);
  assert.equal(s.getCell('A1').fill.fgColor.argb, 'FF00CCFF'); assert.equal(s.getCell('F2').fill.fgColor.argb, 'FF00CCFF');
});
test('document replacement and undo/redo isolate dictionaries, source files and selection dimensions', () => {
  setActivePinia(createPinia()); const store = useDesignerStore();
  const d = createCertificateDocument(); d.excelSource = { base64: 'abc', sheetName: d.sheetName, fileName: 'x.xlsx', warnings: [] };
  store.loadDocument(d); store.loadDocument(newDocument());
  assert.equal(store.doc.excelSource, undefined); assert.equal(store.doc.fields, undefined);
  store.undo(); assert.equal(store.doc.fields.length, 31); assert.equal(store.doc.excelSource.base64, 'abc');
  assert.equal(store.templatePackage.sourceWorkbook.base64, 'abc');
  store.redo(); assert.equal(store.doc.cols, 12); assert.equal(store.selection.r, 0); assert.equal(store.templatePackage.sourceWorkbook, undefined);
});
test('invalid calendar dates are rejected and numeric zero remains a populated value', () => {
  const d = createCertificateDocument(), data = copy(certificateData); data.certificate.issueDate = '2026-02-30';
  assert.throws(() => generateDocument(d, data), /日期不存在/);
});
