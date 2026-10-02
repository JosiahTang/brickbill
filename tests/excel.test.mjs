import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { newDocument } from '../src/domain/model.ts';
import { BLOCKS } from '../src/domain/blocks.ts';
import { transaction, placeBlock, setText } from '../src/domain/operations.ts';
import { exportTemplate, pxToExcelWidth } from '../src/export/excel.ts';
async function roundTrip() {
  const doc = transaction(newDocument(), d => {
    placeBlock(d, BLOCKS[0], 0, 0, 'title');
    placeBlock(d, BLOCKS[1], 2, 0, 'customer');
    placeBlock(d, BLOCKS[2], 5, 0, 'items');
    setText(d, 9, 0, '=SUM(1,2)');
  });
  const bytes = await exportTemplate(doc); const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes); return { doc, sheet: wb.getWorksheet(doc.sheetName) };
}
test('XLSX reload preserves scalar and list placeholders as strings', async () => {
  const {sheet} = await roundTrip();
  assert.equal(sheet.getCell('B3').value, '{{customer.name}}');
  assert.equal(sheet.getCell('C7').value, '{{items.price}}');
  assert.equal(sheet.getCell('C7').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('C7').numFmt, '#,##0.00');
});
test('XLSX reload preserves merges, fill, borders and dimensions', async () => {
  const {sheet} = await roundTrip();
  assert.ok(sheet.getCell('D1').isMerged); assert.equal(sheet.getCell('D1').master.address, 'A1');
  assert.equal(sheet.getCell('A1').fill.fgColor.argb, 'FFE2E8F0');
  assert.equal(sheet.getCell('D1').border.right.style, 'thin');
  assert.equal(sheet.getRow(1).height, 24);
  assert.ok(Math.abs(sheet.getColumn(1).width - pxToExcelWidth(140)) < 0.01);
});
test('literal equals text does not become a formula', async () => {
  const {sheet} = await roundTrip();
  assert.equal(sheet.getCell('A10').value, '=SUM(1,2)');
  assert.equal(sheet.getCell('A10').type, ExcelJS.ValueType.String);
});
