import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument } from '../src/domain/model.ts';
import { bindField } from '../src/domain/operations.ts';
import { createTemplatePackage, upsertPageDefinition } from '../src/core/templates/package.ts';
import { planPages } from '../src/core/pagination/index.ts';
import { planFixedPages } from '../src/core/pagination/fixed.ts';
import { projectPagePlan } from '../src/core/render/page.ts';
import { exportPagedXlsx } from '../src/export/pagedExcel.ts';
import { loadExcel } from '../src/export/importExcel.ts';

function fixture(records, { split = false, continuation = false } = {}) {
  const doc = newDocument(); doc.sheetName = '证书'; doc.rows = 18; doc.cols = 3;
  doc.rowHeightPx = Array(18).fill(24); doc.colWidthPx = [84, 90, 90];
  doc.fields = [
    { fieldId: 'field.group', path: 'group', label: '组', format: 'text', sourceKind: 'view', viewId: 'view.lines', sourceFieldId: 'group' },
    { fieldId: 'field.description', path: 'description', label: '描述', format: 'text', sourceKind: 'view', viewId: 'view.lines', sourceFieldId: 'description' },
    { fieldId: 'field.groupTotal', path: 'groupTotal', label: '组小计', format: 'number', aggregate: { scope: 'group', viewId: 'view.lines', fieldId: 'quantity', operation: 'sum' } },
    { fieldId: 'field.total', path: 'total', label: '总数', format: 'number', aggregate: { scope: 'document', viewId: 'view.lines', fieldId: 'quantity', operation: 'sum' } },
  ];
  bindField(doc, 2, 0, 'group'); bindField(doc, 3, 1, 'description'); bindField(doc, 4, 0, 'group'); bindField(doc, 4, 1, 'groupTotal');
  bindField(doc, 14, 1, 'total');
  doc.cells['0:0'] = { text: '重复表头' };
  doc.cells['14:0'] = { text: '末页合计' };
  doc.cells['15:0'] = { text: '末页声明' };
  const region = (regionId, kind, r) => ({ regionId, worksheetId: 'sheet.main', label: regionId, kind,
    rect: { r, c: 0, rows: 1, cols: 3 }, viewId: 'view.lines', paginationGroupId: 'group.lines', groupBy: ['group'] });
  const page = { pageDefinitionId: 'page.main', label: '流式证书', pageType: 'main', paginationMode: 'flow', worksheetIds: ['sheet.main'],
    paperSize: 'A4', orientation: 'portrait', marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    printableRect: { r: 0, c: 0, rows: 18, cols: 3 }, repeatHeaderRows: [0],
    regions: [region('band.header', 'groupHeader', 2), { ...region('detail', 'detail', 3), keepGroupsTogether: true,
      oversizedGroupPolicy: split ? 'split-records' : 'error' }, region('band.footer', 'groupFooter', 4),
    { regionId: 'last.total', worksheetId: 'sheet.main', label: '末页合计', kind: 'footer', rect: { r: 14, c: 0, rows: 2, cols: 3 }, repeatOn: 'last' }] };
  let template = createTemplatePackage({ name: '流式证书', worksheets: [{ worksheetId: 'sheet.main', document: doc }] });
  template = upsertPageDefinition(template, page);
  if (continuation) template = upsertPageDefinition(template, { ...page, pageDefinitionId: 'page.cont', pageType: 'continuation',
    continuationOf: 'page.main' });
  const view = { viewId: 'view.lines', viewVersion: '1.0.0', datasetId: 'lines', outputFields: ['group', 'description', 'quantity'],
    records: records.map((item, i) => ({ recordId: `line.${i}`, sourceRecordIds: [`source.${i}`], values: item })),
    inputRecordCount: records.length, outputRecordCount: records.length, diagnostics: [] };
  return { template, views: [view] };
}

test('flow mode packs groups, repeats group bands and table header, and reserves last-page total and declaration', async () => {
  const records = [{ group: 'A', description: 'A1', quantity: 1 }, { group: 'A', description: 'A2', quantity: 2 },
    ...Array.from({ length: 8 }, (_, i) => ({ group: 'B', description: `B${i}`, quantity: 1 }))];
  const { template, views } = fixture(records, { continuation: true });
  assert.throws(() => planFixedPages(template, 'page.main', views), error => error.code === 'CONTRACT_INVALID');
  const plan = planPages(template, 'page.main', views);
  assert.equal(plan.totalPages, 2);
  assert.deepEqual(plan.pages.map(page => page.pageDefinitionId), ['page.main', 'page.cont']);
  assert.deepEqual(plan.pages.map(page => page.allocations[0].recordIds.length), [2, 8]);
  for (const page of plan.pages) {
    assert.deepEqual(page.flowItems.map(item => item.regionId).filter(id => id !== 'detail'), ['band.header', 'band.footer']);
    assert.ok(page.flowItems.every(item => item.startRow + item.rowHeightsPx.length <= 18));
  }
  const projection = projectPagePlan(template, plan, views);
  assert.equal(projection.pages[0].document.cells['0:0'].text, '重复表头');
  assert.equal(projection.pages[0].document.cells['14:0']?.text ?? '', '');
  assert.equal(projection.pages[1].document.cells['14:1'].excelValue, 11);
  assert.equal(projection.pages[0].document.cells['5:1'].excelValue, 3);
  assert.equal(projection.pages[1].document.cells['11:1'].excelValue, 8);
  assert.equal(projection.pages[1].document.cells['15:0'].text, '末页声明');
  const result = await exportPagedXlsx(template, projection);
  const reopened = await loadExcel(result.bytes);
  assert.equal(reopened.worksheets.length, 2);
  assert.equal(reopened.worksheets[1].getCell('B15').value, 11);
  assert.equal(reopened.worksheets[1].pageSetup.printTitlesRow, '1:1');
});

test('flow mode measures wrapped records and splits an oversized group without orphaning its group header', async () => {
  const records = Array.from({ length: 13 }, (_, i) => ({ group: 'LONG', description: i === 0 ? '较长说明'.repeat(6) : `记录${i}`, quantity: 1 }));
  const { template, views } = fixture(records, { split: true });
  const plan = planPages(template, 'page.main', views);
  assert.ok(plan.totalPages >= 2);
  assert.deepEqual(plan.pages.flatMap(page => page.allocations[0].recordIds).sort(), views[0].records.map(item => item.recordId).sort());
  for (const page of plan.pages) {
    assert.equal(page.flowItems[0].regionId, 'band.header');
    assert.equal(page.flowItems[1].regionId, 'detail', 'group header must never appear alone');
    const doc = template.worksheets[0].document;
    const flowEnd = page.pageNumber === plan.totalPages ? 14 : 18;
    const consumed = page.flowItems.reduce((sum, item) => sum + item.rowHeightsPx.reduce((a, b) => a + b, 0), 0);
    const budget = doc.rowHeightPx.slice(2, flowEnd).reduce((a, b) => a + b, 0);
    assert.ok(consumed <= budget, `page ${page.pageNumber} exceeds its flow height`);
  }
  assert.ok(plan.pages[0].flowItems.find(item => item.recordId === 'line.0' && item.regionId === 'detail').rowHeightsPx[0] > 24);
  const projection = projectPagePlan(template, plan, views);
  assert.ok(projection.pages[0].document.cells['3:1'].text.includes('较长说明'));
  assert.equal(projection.pages[0].document.cells['3:1'].style.wrap, true);
  assert.equal(projection.pages.at(-1).document.cells['14:1'].excelValue, 13);
  const exported = await exportPagedXlsx(template, projection);
  const workbook = await loadExcel(exported.bytes);
  assert.equal(workbook.worksheets[0].getCell('B4').alignment.wrapText, true);
  assert.ok(workbook.worksheets[0].getRow(4).height > 24 * 72 / 96);
});

test('flow mode rejects unsplittable long groups and malformed group band definitions', () => {
  const records = Array.from({ length: 20 }, (_, i) => ({ group: 'ONE', description: `record ${i}`, quantity: 1 }));
  const { template, views } = fixture(records);
  assert.throws(() => planPages(template, 'page.main', views), error => error.code === 'GROUP_TOO_LARGE');
  const invalid = structuredClone(template);
  invalid.pageDefinitions[0].regions.find(region => region.kind === 'groupHeader').viewId = 'other';
  assert.throws(() => planPages(invalid, 'page.main', views), error => error.code === 'CONTRACT_INVALID');
  const clipped = fixture([{ group: 'A', description: 'an unwrapped value that is much too wide for the available cell', quantity: 1 }]);
  clipped.template.worksheets[0].document.cells['3:1'].style = { wrap: false };
  assert.throws(() => planPages(clipped.template, 'page.main', clipped.views), error => error.code === 'LAYOUT_OVERFLOW');
});
