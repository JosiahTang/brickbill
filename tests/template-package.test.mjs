import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createPinia, setActivePinia } from 'pinia';
import { importTemplatePackage, loadExcel, METADATA_SHEET, PACKAGE_METADATA_MARKER } from '../src/export/importExcel.ts';
import { exportTemplatePackage } from '../src/export/excel.ts';
import { renameWorksheet, reorderWorksheets, upsertPageDefinition } from '../src/core/templates/package.ts';
import { useDesignerStore } from '../src/stores/designer.ts';

test('imports, reorders, renames, saves and reopens a multi-sheet package without recursively embedding its source workbook', async () => {
  const workbook = new ExcelJS.Workbook();
  for (const [name, value] of [['Header', 'Certificate'], ['Chemistry', 'Carbon'], ['Tests', 'Tensile']]) {
    const sheet = workbook.addWorksheet(name); sheet.getCell('A1').value = value; sheet.getCell('A1').font = { bold: true };
    sheet.getColumn(1).width = 24; sheet.getRow(1).height = 21;
  }
  const initial = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(initial.byteLength); bytes.set(new Uint8Array(initial));
  let template = await importTemplatePackage(bytes, 'quality-certificate.xlsx', 'demo-project');
  assert.equal(template.worksheets.length, 3);
  assert.ok(template.worksheets.every(sheet => sheet.document.excelSource.base64 === ''));
  const ids = template.worksheets.map(sheet => sheet.worksheetId);
  template = renameWorksheet(template, ids[1], 'Chemistry Results');
  template = reorderWorksheets(template, [ids[2], ids[0], ids[1]]);

  const firstSave = await exportTemplatePackage(template);
  let reopened = await importTemplatePackage(firstSave, 'quality-certificate.xlsx', 'demo-project');
  assert.deepEqual(reopened.worksheets.map(sheet => sheet.worksheetId), [ids[2], ids[0], ids[1]]);
  assert.equal(reopened.worksheets[2].name, 'Chemistry Results');
  assert.ok(reopened.worksheets.every(sheet => sheet.document.excelSource.base64 === ''));
  const workbookAfterSave = await loadExcel(firstSave);
  assert.deepEqual(workbookAfterSave.worksheets.filter(sheet => sheet.name !== METADATA_SHEET).map(sheet => sheet.name),
    ['Tests', 'Header', 'Chemistry Results']);
  const metadata = workbookAfterSave.getWorksheet(METADATA_SHEET);
  assert.equal(metadata.getCell('A1').value, PACKAGE_METADATA_MARKER);
  let json = ''; metadata.eachRow((row, rowNumber) => { if (rowNumber > 1) json += String(row.getCell(1).value ?? ''); });
  const embedded = JSON.parse(json);
  assert.equal(embedded.sourceWorkbook.base64, '');
  assert.ok(embedded.worksheets.every(sheet => sheet.document.excelSource.base64 === ''));

  const secondSave = await exportTemplatePackage(reopened);
  reopened = await importTemplatePackage(secondSave, 'quality-certificate.xlsx', 'demo-project');
  const thirdSave = await exportTemplatePackage(reopened);
  assert.ok(thirdSave.byteLength < firstSave.byteLength * 1.5, 'source workbook should stay at package level instead of growing on each save');
  assert.deepEqual(reopened.worksheets.map(sheet => sheet.worksheetId), [ids[2], ids[0], ids[1]]);
});

test('designer keeps independent sheet documents and undo history while switching sheets', async () => {
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Main').getCell('A1').value = 'Main title';
  workbook.addWorksheet('Details').getCell('A1').value = 'Detail title';
  const buffer = await workbook.xlsx.writeBuffer(), bytes = new Uint8Array(buffer.byteLength); bytes.set(new Uint8Array(buffer));
  const template = await importTemplatePackage(bytes, 'switching.xlsx', 'demo-project');
  setActivePinia(createPinia()); const store = useDesignerStore(); store.loadTemplatePackage(template);
  const [main, details] = store.worksheets.map(sheet => sheet.worksheetId);
  store.commit(document => { document.cells['0:0'].text = 'Main edited'; });
  store.switchWorksheet(details);
  store.commit(document => { document.cells['0:0'].text = 'Detail edited'; });
  store.switchWorksheet(main);
  assert.equal(store.doc.cells['0:0'].text, 'Main edited');
  assert.equal(store.canUndo, true);
  store.undo(); assert.equal(store.doc.cells['0:0'].text, 'Main title');
  store.redo(); assert.equal(store.doc.cells['0:0'].text, 'Main edited');
  store.switchWorksheet(details); assert.equal(store.doc.cells['0:0'].text, 'Detail edited');
  const snapshot = store.packageSnapshot();
  assert.equal(snapshot.worksheets.length, 2);
  assert.ok(snapshot.worksheets.every(sheet => sheet.document.excelSource.base64 === ''));
});

test('dictionary edits stay shared and block deleting or renaming fields that another sheet uses', async () => {
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Main'); workbook.addWorksheet('Details');
  const buffer = await workbook.xlsx.writeBuffer(), bytes = new Uint8Array(buffer.byteLength); bytes.set(new Uint8Array(buffer));
  setActivePinia(createPinia()); const store = useDesignerStore(); store.loadTemplatePackage(await importTemplatePackage(bytes, 'dictionary.xlsx'));
  const [main, details] = store.worksheets.map(sheet => sheet.worksheetId);
  const field = { fieldId: 'field.printNo', path: 'certificate.printNo', label: '质保书打印号', format: 'text', sourceKind: 'dataset', datasetId: 'certificate.header', sourceFieldId: 'printNo' };
  store.saveField(field);
  store.bind(0, 0, field.path, true);
  store.switchWorksheet(details); store.bind(0, 0, field.path, true);
  store.switchWorksheet(main);
  assert.throws(() => store.deleteField(field.path), /其他工作表/);
  assert.throws(() => store.saveField({ ...field, path: 'certificate.newPrintNo' }, field.path), /共享标识/);
  store.saveField({ ...field, label: '证书打印号' }, field.path);
  const saved = store.packageSnapshot();
  assert.equal(saved.worksheets[0].document.fields.find(item => item.fieldId === field.fieldId).label, '证书打印号');
  assert.equal(saved.worksheets[1].document.cells['0:0'].binding.fieldId, field.fieldId);
});

test('page, print and image resource definitions survive template package round trips', async () => {
  const workbook = new ExcelJS.Workbook(); const worksheet = workbook.addWorksheet('Certificate');
  worksheet.getCell('A1').value = 'Quality Certificate'; worksheet.getCell('H10').value = 'Footer';
  const buffer = await workbook.xlsx.writeBuffer(), bytes = new Uint8Array(buffer.byteLength); bytes.set(new Uint8Array(buffer));
  let template = await importTemplatePackage(bytes, 'page-config.xlsx');
  const worksheetId = template.worksheets[0].worksheetId;
  template.resources = [{ resourceId: 'asset.seal', mediaType: 'image/png', base64: 'cG5n' }];
  template = upsertPageDefinition(template, { pageDefinitionId: 'page.main', label: '主表', pageType: 'main', worksheetIds: [worksheetId],
    paperSize: 'A4', orientation: 'landscape', marginsMm: { top: 8, right: 9, bottom: 10, left: 11 },
    printableRect: { r: 0, c: 0, rows: 10, cols: 8 }, repeatHeaderRows: [0, 1],
    regions: [{ regionId: 'region.title', worksheetId, label: '固定标题', kind: 'fixed', rect: { r: 0, c: 0, rows: 1, cols: 1 } }],
    imagePlacements: [{ imageId: 'seal', resourceId: 'asset.seal', worksheetId, rect: { r: 0, c: 6, rows: 2, cols: 2 }, repeatOn: 'all' }] });
  const reopened = await importTemplatePackage(await exportTemplatePackage(template), 'page-config.xlsx');
  assert.deepEqual(reopened.pageDefinitions, template.pageDefinitions);
  assert.deepEqual(reopened.resources, template.resources);
});
