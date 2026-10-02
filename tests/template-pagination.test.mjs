import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { newDocument } from '../src/domain/model.ts';
import { bindField } from '../src/domain/operations.ts';
import { createTemplatePackage, upsertPageDefinition } from '../src/core/templates/package.ts';
import { measureTemplateLayout } from '../src/core/layout/measure.ts';
import { planFixedPages } from '../src/core/pagination/fixed.ts';
import { projectPagePlan } from '../src/core/render/page.ts';
import { exportPagedXlsx } from '../src/export/pagedExcel.ts';
import { loadExcel } from '../src/export/importExcel.ts';

function makeLinkedPackage({ split = false, continuation = false } = {}) {
  const document = newDocument(); document.name = '证书'; document.sheetName = '主表'; document.rows = 12; document.cols = 4;
  document.rowHeightPx = Array(12).fill(22); document.colWidthPx = Array(4).fill(70);
  const fields = [
    { fieldId: 'field.group', path: 'certificate.group', label: '组号', format: 'text', sourceKind: 'view', viewId: 'view.material', sourceFieldId: 'business.group' },
    { fieldId: 'field.material', path: 'certificate.material', label: '物料', format: 'text', sourceKind: 'view', viewId: 'view.material', sourceFieldId: 'business.material' },
    { fieldId: 'field.tensile', path: 'certificate.tensile', label: '抗拉', format: 'number', sourceKind: 'view', viewId: 'view.tensile', sourceFieldId: 'business.tensile' },
    { fieldId: 'field.page', path: 'page.number', label: '页码', format: 'number', sourceKind: 'page', pageField: 'number' },
  ];
  document.fields = structuredClone(fields);
  bindField(document, 0, 0, 'page.number'); bindField(document, 1, 0, 'certificate.group');
  bindField(document, 1, 1, 'certificate.material'); bindField(document, 3, 0, 'certificate.tensile');
  let template = createTemplatePackage({ name: document.name, worksheets: [{ worksheetId: 'sheet.main', document }] });
  const makeRegion = (regionId, viewId, row) => ({ regionId, worksheetId: 'sheet.main', label: regionId, kind: 'detail',
    rect: { r: row, c: 0, rows: 1, cols: 2 }, viewId, paginationGroupId: 'certificate.group', groupBy: ['business.group'],
    recordHeight: 1, capacityRows: 2, emptyPolicy: 'keep', keepGroupsTogether: !split, oversizedGroupPolicy: split ? 'split-records' : 'error',
    mergeFieldIds: ['field.group'], hideRepeatedFieldIds: ['field.group'] });
  const main = { pageDefinitionId: 'page.main', label: '主表', pageType: 'main', worksheetIds: ['sheet.main'], paperSize: 'A4', orientation: 'portrait',
    marginsMm: { top: 10, right: 10, bottom: 10, left: 10 }, printableRect: { r: 0, c: 0, rows: 12, cols: 4 },
    regions: [makeRegion('region.material', 'view.material', 1), makeRegion('region.tensile', 'view.tensile', 3)] };
  template = upsertPageDefinition(template, main);
  if (continuation) template = upsertPageDefinition(template, { ...main, pageDefinitionId: 'page.continuation', label: '续页', pageType: 'continuation', continuationOf: 'page.main',
    regions: main.regions.map(region => ({ ...region, rect: { ...region.rect, r: region.rect.r + 2 } })) });
  return template;
}
const record = (recordId, group, fieldId, value) => ({ recordId, sourceRecordIds: [`source.${recordId}`], values: { 'business.group': group, [fieldId]: value } });
function views() {
  return [
    { viewId: 'view.material', viewVersion: '1.0.0', datasetId: 'material.lines', outputFields: ['business.group', 'business.material'], records: [
      record('m-a1', 'A', 'business.material', 'M1'), record('m-b1', 'B', 'business.material', 'M2'), record('m-b2', 'B', 'business.material', 'M3')], inputRecordCount: 3, outputRecordCount: 3, diagnostics: [] },
    { viewId: 'view.tensile', viewVersion: '1.0.0', datasetId: 'quality.tensile', outputFields: ['business.group', 'business.tensile'], records: [
      record('t-a1', 'A', 'business.tensile', 540), record('t-a2', 'A', 'business.tensile', 545)], inputRecordCount: 2, outputRecordCount: 2, diagnostics: [] },
  ];
}

test('layout measurement reports physical scale, wrapped text, image bounds and unavailable fonts', () => {
  const doc = newDocument(); doc.rows = 2; doc.cols = 2; doc.rowHeightPx = [12, 12]; doc.colWidthPx = [900, 900];
  doc.cells['0:0'] = { text: 'A very long certificate heading which must wrap safely', style: { fontFamily: 'Quality Sans', fontSizePt: 12, wrap: true } };
  doc.merges = [{ r: 0, c: 0, rows: 2, cols: 2 }];
  const page = { pageDefinitionId: 'page.measure', label: '测量', pageType: 'main', worksheetIds: ['sheet.1'], paperSize: 'A4', orientation: 'portrait',
    marginsMm: { top: 10, right: 10, bottom: 10, left: 10 }, printableRect: { r: 0, c: 0, rows: 2, cols: 2 }, regions: [] };
  const measured = measureTemplateLayout(doc, page, 'sheet.1', { fonts: { supportedFonts: ['Arial'], measureWidth: text => text.length * 200 }, images: [
    { imageId: 'seal', worksheetId: 'sheet.1', rect: { r: 1, c: 1, rows: 2, cols: 2 } },
  ] });
  assert.ok(measured.scale < 0.85);
  assert.deepEqual(measured.missingFonts, ['Quality Sans']);
  assert.ok(measured.diagnostics.some(issue => issue.message.includes('文字高度')));
  assert.ok(measured.diagnostics.some(issue => issue.message.includes('图片 seal')));
});

test('linked fixed pagination is deterministic and keeps unequal detail collections aligned by business group', () => {
  const template = makeLinkedPackage();
  const first = planFixedPages(template, 'page.main', views());
  const second = planFixedPages(template, 'page.main', views());
  assert.deepEqual(first, second);
  assert.equal(first.totalPages, 2);
  const page1 = first.pages[0].allocations;
  assert.deepEqual(page1.find(item => item.regionId === 'region.material').recordIds, ['m-a1']);
  assert.deepEqual(page1.find(item => item.regionId === 'region.tensile').recordIds, ['t-a1', 't-a2']);
  const page2 = first.pages[1].allocations;
  assert.deepEqual(page2.find(item => item.regionId === 'region.material').recordIds, ['m-b1', 'm-b2']);
  assert.deepEqual(page2.find(item => item.regionId === 'region.tensile').recordIds, []);
});

test('oversized groups fail by default, explicit record splitting converges through continuation pages', () => {
  const records = Array.from({ length: 5 }, (_, i) => record(`m-${i + 1}`, 'A', 'business.material', `M${i + 1}`));
  const sourceViews = [views()[0], { ...views()[1], records: [] }];
  sourceViews[0] = { ...sourceViews[0], records };
  assert.throws(() => planFixedPages(makeLinkedPackage(), 'page.main', sourceViews), error => error.code === 'GROUP_TOO_LARGE');
  const plan = planFixedPages(makeLinkedPackage({ split: true, continuation: true }), 'page.main', sourceViews);
  assert.equal(plan.totalPages, 3);
  assert.deepEqual(plan.pages.map(page => page.pageDefinitionId), ['page.main', 'page.continuation', 'page.continuation']);
  assert.deepEqual(plan.pages.flatMap(page => page.allocations.find(item => item.regionId === 'region.material').recordIds), records.map(item => item.recordId));
  const fixedPoint = planFixedPages(makeLinkedPackage({ split: true }), 'page.main', sourceViews, {
    capacityRows: (_region, _page, totalGuess) => totalGuess === 1 ? 1 : 2,
  });
  assert.equal(fixedPoint.totalPages, 3);
});

test('a template may explicitly release group integrity to split an oversized group', () => {
  const records = Array.from({ length: 5 }, (_, i) => record(`m-open-${i + 1}`, 'A', 'business.material', `M${i + 1}`));
  const sourceViews = [views()[0], { ...views()[1], records: [] }]; sourceViews[0] = { ...sourceViews[0], records };
  let template = makeLinkedPackage();
  const main = structuredClone(template.pageDefinitions[0]);
  for (const region of main.regions) region.keepGroupsTogether = false;
  template = upsertPageDefinition(template, main);
  const plan = planFixedPages(template, 'page.main', sourceViews);
  assert.equal(plan.totalPages, 3);
  assert.deepEqual(plan.pages.flatMap(page => page.allocations.find(item => item.regionId === 'region.material').recordIds), records.map(item => item.recordId));
});

test('page projection resolves page and aggregate fields, repeats merged group labels, and preserves its inputs', () => {
  const template = makeLinkedPackage();
  const materialView = { ...views()[0], records: [
    { ...record('m-a1', 'A', 'business.material', 'M1'), values: { 'business.group': 'A', 'business.material': 'M1', 'field.group': 'A', 'field.material': 'M1', 'business.amount': 6 } },
    { ...record('m-a2', 'A', 'business.material', 'M2'), values: { 'business.group': 'A', 'business.material': 'M2', 'field.group': 'A', 'field.material': 'M2', 'business.amount': 7 } },
  ] };
  const otherView = { ...views()[1], records: [] };
  const page = template.pageDefinitions[0]; page.regions[0].capacityRows = 2;
  const doc = template.worksheets[0].document;
  page.imagePlacements = [{ imageId: 'seal', resourceId: 'image.seal', worksheetId: 'sheet.main', rect: { r: 6, c: 0, rows: 2, cols: 2 }, repeatOn: 'all' }];
  doc.fields.push({ fieldId: 'field.total', path: 'certificate.amountTotal', label: '合计', format: 'number', aggregate: { scope: 'page', viewId: 'view.material', fieldId: 'business.amount', operation: 'sum' } });
  bindField(doc, 0, 1, 'certificate.amountTotal');
  const before = structuredClone(template);
  const plan = planFixedPages(template, 'page.main', [materialView, otherView]);
  const projection = projectPagePlan(template, plan, [materialView, otherView]);
  assert.equal(projection.pages[0].document.cells['0:0'].text, '1');
  assert.equal(projection.pages[0].document.cells['0:1'].excelValue, 13);
  assert.equal(projection.pages[0].groupCount, 1, 'linked regions count the shared business group once');
  assert.equal(projection.pages[0].document.cells['1:0'].text, 'A');
  assert.equal(projection.pages[0].document.cells['2:0'].text, '');
  assert.ok(projection.pages[0].document.merges.some(merge => merge.r === 1 && merge.rows === 2));
  assert.equal(projection.pages[0].pageSetup.paperSize, 'A4');
  assert.equal(projection.pages[0].imagePlacements[0].resourceId, 'image.seal');
  assert.deepEqual(projection.resources, []);
  assert.deepEqual(template, before);
  assert.equal(materialView.records[0].values['business.amount'], 6);
});

test('paged XLSX export matches the fixed page projection and verifies sheets, merges, images and print setup', async () => {
  let template = makeLinkedPackage();
  const page = structuredClone(template.pageDefinitions[0]);
  page.repeatHeaderRows = [0, 1];
  page.imagePlacements = [{ imageId: 'seal', resourceId: 'asset.seal', worksheetId: 'sheet.main', rect: { r: 0, c: 3, rows: 1, cols: 1 }, repeatOn: 'all' }];
  template.resources = [{ resourceId: 'asset.seal', mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=' }];
  template.pageDefinitions = [page];
  const sourceViews = views();
  const pagePlan = planFixedPages(template, 'page.main', sourceViews);
  const projection = projectPagePlan(template, pagePlan, sourceViews);
  const result = await exportPagedXlsx(template, projection, 'certificate.xlsx');
  assert.equal(result.fileName, 'certificate.xlsx');
  assert.equal(result.sheetNames.length, pagePlan.totalPages);
  const reopened = await loadExcel(result.bytes);
  assert.equal(reopened.worksheets.length, pagePlan.totalPages);
  assert.deepEqual(reopened.worksheets.map(sheet => sheet.name), result.sheetNames);
  assert.equal(reopened.worksheets[0].getCell('A1').value, 1);
  assert.equal(reopened.worksheets[0].getCell('A2').value, 'A');
  assert.equal(reopened.worksheets[1].getCell('A1').value, 2);
  assert.equal(reopened.worksheets[1].getCell('B2').value, 'M2');
  assert.ok(reopened.worksheets[1].model.merges.includes('A2:A3'));
  assert.equal(reopened.worksheets[0].getImages().length, 1);
  assert.equal(reopened.worksheets[1].getImages().length, 1);
  assert.equal(reopened.worksheets[0].pageSetup.printArea, 'A1:D12');
  assert.equal(reopened.worksheets[0].pageSetup.printTitlesRow, '1:2');
  assert.equal(reopened.worksheets.some(sheet => sheet.state !== 'visible'), false, 'generated output must contain visible page sheets only');
});

test('paged XLSX export refuses formulas whose references may move with repeated records', async () => {
  const template = makeLinkedPackage();
  const sourceViews = views();
  const plan = planFixedPages(template, 'page.main', sourceViews);
  const projection = projectPagePlan(template, plan, sourceViews);
  projection.pages[0].document.cells['0:0'].excelValue = { formula: '1+1', result: 2 };
  await assert.rejects(() => exportPagedXlsx(template, projection), error => error.code === 'UNSUPPORTED_FORMULA_LAYOUT');
});

test('paged XLSX export preserves original workbook images when no replacement placement is configured', async () => {
  const source = new ExcelJS.Workbook();
  source.addWorksheet('主表');
  const imageId = source.addImage({
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=',
    extension: 'png',
  });
  source.getWorksheet('主表').addImage(imageId, { tl: { col: 2, row: 2 }, br: { col: 3, row: 3 } });
  const sourceBytes = await source.xlsx.writeBuffer();
  const template = makeLinkedPackage();
  template.sourceWorkbook = { fileName: 'source.xlsx', base64: Buffer.from(sourceBytes).toString('base64') };
  const sourceViews = views(), plan = planFixedPages(template, 'page.main', sourceViews);
  const projection = projectPagePlan(template, plan, sourceViews);
  const result = await exportPagedXlsx(template, projection);
  const reopened = await loadExcel(result.bytes);
  for (const sheet of reopened.worksheets) {
    assert.equal(sheet.getImages().length, 1);
    const { tl, br } = sheet.getImages()[0].range;
    assert.deepEqual([tl.nativeCol, tl.nativeRow, br.nativeCol, br.nativeRow], [2, 2, 3, 3]);
  }
});

test('page definitions reject overlapping regions and pagination groups with incompatible keys', () => {
  const template = makeLinkedPackage();
  const broken = structuredClone(template);
  broken.pageDefinitions[0].regions[1].rect = { ...broken.pageDefinitions[0].regions[0].rect };
  assert.throws(() => planFixedPages(broken, 'page.main', views()), error => error.code === 'LAYOUT_OVERFLOW');
  const other = structuredClone(template);
  other.pageDefinitions[0].regions[1].groupBy = ['business.heatNo'];
  assert.throws(() => planFixedPages(other, 'page.main', views()), error => error.code === 'AMBIGUOUS_SCOPE');
  const tooLarge = structuredClone(template); tooLarge.pageDefinitions[0].regions[0].capacityRows = 12;
  assert.throws(() => planFixedPages(tooLarge, 'page.main', views()), error => error.code === 'LAYOUT_OVERFLOW');
});
