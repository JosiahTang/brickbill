import test from 'node:test';
import assert from 'node:assert/strict';
import { imageWorkbook, replacementPng } from './fixtures/image-workbook.mjs';
import { importTemplatePackage, hydrateTemplateImages, parseTemplatePackageJson } from '../src/export/importExcel.ts';
import { exportTemplatePackage, exportTemplate } from '../src/export/excel.ts';
import { createPinia, setActivePinia } from 'pinia';
import { useDesignerStore } from '../src/stores/designer.ts';
import { validateDocument } from '../src/domain/operations.ts';
import { upsertPageDefinition, validateTemplatePackage } from '../src/core/templates/package.ts';
import { planFixedPages } from '../src/core/pagination/fixed.ts';
import { projectPagePlan } from '../src/core/render/page.ts';
import { exportPagedXlsx } from '../src/export/pagedExcel.ts';
import ExcelJS from 'exceljs';
import { copy } from '../src/domain/model.ts';
import { LocalTemplateRepository } from '../server/repositories/local.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDocument } from '../src/domain/generate.ts';

async function readImages(bytes) {
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes); return workbook;
}
function imageBytes(workbook, sheet, index = 0) {
  const image = workbook.getImage(Number(workbook.worksheets[sheet].getImages()[index].imageId));
  return image.base64?.replace(/^data:[^,]+,/, '') ?? Buffer.from(image.buffer).toString('base64');
}

test('T44.1: an authoritative empty image list removes native pictures from saved Excel', async () => {
  const template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  template.worksheets[0].document.images = [];
  const before = JSON.stringify(template);
  const saved = await readImages(await exportTemplatePackage(template));
  assert.equal(saved.worksheets[0].getImages().length, 0);
  assert.equal(saved.worksheets[1].getImages().length, 1);
  assert.equal(JSON.stringify(template), before);
  const reopened = await importTemplatePackage(await exportTemplatePackage(template), 'saved.xlsx');
  assert.equal((await readImages(await exportTemplatePackage(reopened))).worksheets[0].getImages().length, 0);
});

test('T44.1: saved resource bytes are authoritative without changing other shared references', async () => {
  const template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  const original = template.resources[0].base64;
  template.resources.push({ resourceId: 'replacement', mediaType: 'image/png', base64: replacementPng });
  template.worksheets[0].document.images[0].resourceId = 'replacement';
  const saved = await readImages(await exportTemplatePackage(template));
  assert.equal(imageBytes(saved, 0), replacementPng);
  assert.equal(imageBytes(saved, 0, 1), original);
  assert.equal(imageBytes(saved, 1), original);
  template.resources[0].base64 = replacementPng;
  const allChanged = await readImages(await exportTemplatePackage(template));
  assert.equal(imageBytes(allChanged, 0, 1), replacementPng);
  assert.equal(imageBytes(allChanged, 1), replacementPng);
});

test('T44.1: subset and reordered native pictures survive two saves with synchronized source indexes', async () => {
  for (const indexes of [[1], [1, 0]]) {
    let template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
    template.worksheets[0].document.images = indexes.map(index => template.worksheets[0].document.images[index]);
    const expected = copy(template.worksheets[0].document.images), before = JSON.stringify(template);
    let mediaCount;
    for (let round = 0; round < 2; round++) {
      const bytes = await exportTemplatePackage(template), workbook = await readImages(bytes);
      if (mediaCount !== undefined) assert.equal(workbook.model.media.length, mediaCount, 'repeated saves must not accumulate unused media');
      mediaCount = workbook.model.media.length;
      assert.equal(workbook.worksheets[0].getImages().length, expected.length);
      const reopened = await importTemplatePackage(bytes, 'saved.xlsx');
      reopened.worksheets[0].document.images.forEach((image, index) => {
        assert.equal(image.sourceIndex, index);
        assert.equal(image.imageId, expected[index].imageId);
        assert.deepEqual(image.rect, expected[index].rect);
        assert.ok(Math.abs(workbook.worksheets[0].getImages()[index].range.tl.row - image.rect.r) < 0.001);
      });
      if (!round) assert.equal(JSON.stringify(template), before);
      template = reopened;
    }
  }
});

test('T44.1: invalid source and malformed picture bytes fail explicitly; legacy images remain', async () => {
  const template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  const invalid = copy(template); invalid.worksheets[0].document.images[0].sourceIndex = 99;
  await assert.rejects(() => exportTemplatePackage(invalid), /图片.*源/);
  invalid.worksheets[0].document.images[0].sourceIndex = 0; invalid.resources[0].base64 = 'not-an-image';
  await assert.rejects(() => exportTemplatePackage(invalid), /图片.*(资源|内容)/);
  const legacy = copy(template);
  for (const sheet of legacy.worksheets) { delete sheet.document.images; delete sheet.document.imageLayoutVersion; }
  assert.equal((await readImages(await exportTemplatePackage(legacy))).worksheets[0].getImages().length, 2);
  const doc = copy(template.worksheets[0].document); doc.excelSource.base64 = template.sourceWorkbook.base64;
  doc.images = [];
  assert.equal((await readImages(await exportTemplate(doc))).worksheets[0].getImages().length, 0);
});

test('T44.2: deleting empty details preserves adjacent image edges and moves following fractional anchors', async () => {
  const template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  const doc = copy(template.worksheets[0].document);
  doc.images[0].rect = { r: 8.25, c: 0, rows: 1.75, cols: 1 };
  doc.images[1].rect = { r: 13.25, c: 4, rows: 1.5, cols: 1 };
  doc.repeatRegions = [10, 12].map(r => ({ id: `rows.${r}`, name: '明细', source: `rows${r}`,
    rect: { r, c: 0, rows: 1, cols: 10 }, empty: 'remove' }));
  const before = JSON.stringify(doc);
  const generated = generateDocument(doc, { rows10: [], rows12: [] });
  assert.deepEqual(generated.document.images[0].rect, doc.images[0].rect);
  assert.equal(generated.document.images[1].rect.r, 11.25);
  assert.equal(generated.document.images[1].rect.rows, 1.5);
  const source = generated.document; source.excelSource.base64 = template.sourceWorkbook.base64;
  const saved = await readImages(await exportTemplate(source, { embed: false, rowMap: generated.rowMap, resources: template.resources }));
  assert.ok(Math.abs(saved.worksheets[0].getImages()[0].range.br.row - 10) < 0.001);
  assert.ok(Math.abs(saved.worksheets[0].getImages()[1].range.tl.row - 11.25) < 0.001);
  assert.equal(JSON.stringify(doc), before);
  const crossing = copy(doc); crossing.images[0].rect.rows = 2;
  assert.throws(() => generateDocument(crossing, { rows10: [], rows12: [] }), /图片.*重复区域/);
});

async function detailImages(count = 5, recordHeight = 1) {
  const template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  const sheet = template.worksheets[0]; sheet.document.merges = [];
  sheet.document.images = [{ ...sheet.document.images[0], rect: { r: 6, c: 0, rows: 1, cols: 1 } }];
  const detail = { regionId: 'detail', worksheetId: sheet.worksheetId, label: '明细', kind: 'detail',
    rect: { r: 3, c: 0, rows: 1, cols: 3 }, viewId: 'rows', paginationGroupId: 'rows', groupBy: ['id'], recordHeight, capacityRows: 8 };
  template.pageDefinitions = [{ pageDefinitionId: 'page', label: '主表', pageType: 'main', paginationMode: 'fixed',
    worksheetIds: [sheet.worksheetId], paperSize: 'A4', orientation: 'portrait',
    marginsMm: { top: 10, right: 10, bottom: 10, left: 10 }, printableRect: { r: 0, c: 0, rows: 20, cols: 8 }, regions: [detail] }];
  const records = Array.from({ length: count }, (_, id) => ({ recordId: String(id), sourceRecordIds: [String(id)], values: { id } }));
  const views = [{ viewId: 'rows', viewVersion: '1.0.0', datasetId: 'rows', outputFields: ['id'], records,
    inputRecordCount: count, outputRecordCount: count, diagnostics: [] }];
  return { template, views, detail, doc: sheet.document };
}

test('T44.3: pictures in expanded records or blank capacity fail with page and region diagnostics', async () => {
  for (const count of [0, 1, 5, 9]) {
    const { template, views, doc } = await detailImages(count);
    const plan = planFixedPages(template, 'page', views), before = JSON.stringify(template);
    assert.throws(() => projectPagePlan(template, plan, views), error => error.code === 'LAYOUT_OVERFLOW'
      && error.context.worksheetId === template.worksheets[0].worksheetId && error.context.regionId === 'detail' && error.context.pageNumber === 1);
    assert.equal(JSON.stringify(template), before);
    // The lower edge of the reserved body is a legal, non-overlapping header/footer boundary.
    doc.images[0].rect.r = 11;
    assert.equal(projectPagePlan(template, planFixedPages(template, 'page', views), views).pages[0].imagePlacements.length, 1);
  }
});

test('T44.3: recordHeight and continuation capacity use row units, and each detail lane is checked', async () => {
  const { template, views, detail, doc } = await detailImages(3, 2);
  template.pageDefinitions.push({ ...copy(template.pageDefinitions[0]), pageDefinitionId: 'continued', pageType: 'continuation',
    continuationOf: 'page', regions: [{ ...copy(detail), capacityRows: 4 }] });
  doc.images[0].rect.r = 8;
  const plan = planFixedPages(template, 'page', views);
  assert.equal(plan.pages.length, 2);
  assert.equal(plan.pages[1].blankRows.detail, 2, 'blank capacity is measured in rows, never record counts');
  assert.throws(() => projectPagePlan(template, plan, views), /图片.*动态重复区域/);
  doc.images[0].rect = { r: 1, c: 0, rows: 2, cols: 1 };
  assert.equal(projectPagePlan(template, planFixedPages(template, 'page', views), views).pages.length, 2);
  doc.images[0].rect = { r: 6, c: 4, rows: 1, cols: 1 };
  assert.equal(projectPagePlan(template, planFixedPages(template, 'page', views), views).pages.length, 2, 'another column lane is safe');
  template.pageDefinitions[0].regions.push({ ...copy(detail), regionId: 'other', rect: { r: 3, c: 4, rows: 1, cols: 3 } });
  template.pageDefinitions[1].regions.push({ ...copy(template.pageDefinitions[0].regions[1]), capacityRows: 4 });
  assert.throws(() => projectPagePlan(template, planFixedPages(template, 'page', views), views), error => error.context?.regionId === 'other');
});

test('T44.4: native/configured image identity conflicts fail; local IDs and shared resources remain valid', async () => {
  const { template, views, doc } = await detailImages(1);
  doc.images[0].rect.r = 1;
  const page = template.pageDefinitions[0], sheetId = template.worksheets[0].worksheetId;
  page.imagePlacements = [{ imageId: doc.images[0].imageId, resourceId: doc.images[0].resourceId,
    worksheetId: sheetId, rect: { r: 15, c: 0, rows: 1, cols: 1 } }];
  assert.throws(() => validateTemplatePackage(template), error => error.code === 'DUPLICATE_KEY' && error.context.worksheetId === sheetId && !!error.context.cell);
  page.imagePlacements[0].imageId = 'configured';
  page.worksheetIds.push(template.worksheets[1].worksheetId);
  validateTemplatePackage(template);
  const projection = projectPagePlan(template, planFixedPages(template, 'page', views), views);
  assert.deepEqual(projection.pages.map(sheet => sheet.imagePlacements.length), [2, 1]);
  assert.equal(projection.pages[0].imagePlacements[0].imageId, projection.pages[1].imagePlacements[0].imageId);
  assert.equal(projection.pages[0].imagePlacements[0].resourceId, projection.pages[0].imagePlacements[1].resourceId);
});

test('T43.1: native Excel images become editable anchors backed by existing package resources', async () => {
  const template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  assert.equal(template.worksheets[0].document.images?.length, 2, 'retaining workbook bytes alone does not make images editable');
  assert.equal(template.worksheets[1].document.images?.length, 1);
  const image = template.worksheets[0].document.images[0];
  assert.ok(template.resources.some(resource => resource.resourceId === image.resourceId));
  assert.ok(Math.abs(image.rect.r - 1.25) < 0.001);
  assert.ok(Math.abs(image.rect.cols - 2.2) < 0.001);
});

test('T43.3/4: image edits use worksheet undo, preserve other sheets and survive Excel/JSON reopen', async () => {
  setActivePinia(createPinia()); const store = useDesignerStore();
  store.loadTemplatePackage(await importTemplatePackage(await imageWorkbook(), 'images.xlsx'));
  const before = store.snapshot().images[0].rect;
  const other = copy(store.templatePackage.worksheets[1].document.images);
  store.updateImage(store.doc.images[0].imageId, { r: 2.5, c: 2.2, rows: 2.75, cols: 1.5 });
  const edited = store.snapshot().images[0].rect;
  store.undo(); assert.deepEqual(store.snapshot().images[0].rect, before);
  store.redo(); assert.deepEqual(store.snapshot().images[0].rect, edited);
  store.switchWorksheet(store.worksheets[1].worksheetId);
  assert.deepEqual(store.snapshot().images, other);
  store.switchWorksheet(store.worksheets[0].worksheetId);
  const snapshot = store.packageSnapshot();
  const reopened = await importTemplatePackage(await exportTemplatePackage(snapshot), 'saved.xlsx');
  assert.deepEqual(reopened.worksheets[0].document.images[0].rect, edited);
  assert.deepEqual(reopened.worksheets[1].document.images, other);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await exportTemplatePackage(snapshot));
  const actual = workbook.worksheets[0].getImages()[0].range;
  assert.ok(Math.abs(actual.tl.row - edited.r) < 0.001);
  assert.ok(Math.abs(actual.br.col - edited.c - edited.cols) < 0.001);
  const json = parseTemplatePackageJson(JSON.stringify(snapshot));
  assert.deepEqual(json.worksheets[0].document.images[0].rect, edited);
  for (const rect of [{ ...edited, c: NaN }, { ...edited, rows: 0 }, { ...edited, r: -1 }, { ...edited, c: 99 }]) {
    const invalid = store.snapshot(); invalid.images[0].rect = rect;
    assert.throws(() => validateDocument(invalid), /图片/);
  }
});

test('T43.4: opening legacy native images upgrades a copy, and draft edits do not alter published anchors', async () => {
  const template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  for (const sheet of template.worksheets) { delete sheet.document.images; delete sheet.document.imageLayoutVersion; }
  delete template.resources;
  const legacy = JSON.stringify(template);
  const normalized = await hydrateTemplateImages(parseTemplatePackageJson(legacy));
  assert.equal(normalized.worksheets[0].document.images.length, 2);
  assert.equal(JSON.stringify(template), legacy, 'opening a legacy template must not rewrite the stored version');
  const root = await mkdtemp(join(tmpdir(), 'brickbill-image-versions-'));
  try {
    const repo = new LocalTemplateRepository(root);
    const draft = await repo.saveDraft(normalized, 0);
    const published = await repo.publish(normalized.projectId, normalized.packageId, normalized, draft.revision);
    const next = copy(normalized); next.worksheets[0].document.images[0].rect.c += 1;
    await repo.saveDraft(next, draft.revision);
    const stored = await repo.getVersion(normalized.projectId, normalized.packageId, published.version);
    assert.deepEqual(stored.value.worksheets[0].document.images, normalized.worksheets[0].document.images);
    const reopened = await hydrateTemplateImages(parseTemplatePackageJson(JSON.stringify(stored.value)));
    assert.deepEqual(reopened.worksheets[0].document.images, normalized.worksheets[0].document.images);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('T43.4: referenced native image resources cannot be deleted or saved with missing/unsupported layouts', async () => {
  setActivePinia(createPinia()); const store = useDesignerStore();
  store.loadTemplatePackage(await importTemplatePackage(await imageWorkbook(), 'images.xlsx'));
  assert.throws(() => store.saveResources([]), /图片.*引用/);
  const before = JSON.stringify(store.snapshot());
  assert.throws(() => store.updateImage('native.0', { r: 0, c: 0, rows: -1, cols: 1 }), /图片/);
  assert.equal(JSON.stringify(store.snapshot()), before);
  const broken = store.packageSnapshot(); broken.worksheets[0].document.imageLayoutVersion = 99;
  assert.throws(() => parseTemplatePackageJson(JSON.stringify(broken)), /图片定位版本/);
  const missing = store.packageSnapshot(); missing.resources = [];
  assert.throws(() => parseTemplatePackageJson(JSON.stringify(missing)), /引用的资源不存在/);
});

test('T43.1: images beyond populated cells extend the editable sheet instead of clipping', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('图片');
  const source = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  const id = workbook.addImage({ extension: 'png', base64: source.resources[0].base64 });
  sheet.addImage(id, { tl: { row: 30, col: 12 }, br: { row: 34, col: 14 } });
  const template = await importTemplatePackage(new Uint8Array(await workbook.xlsx.writeBuffer()), 'far-image.xlsx');
  assert.ok(template.worksheets[0].document.rows >= 34);
  assert.ok(template.worksheets[0].document.cols >= 14);
  assert.equal(template.worksheets[0].document.images.length, 1);
  const saved = new ExcelJS.Workbook(); await saved.xlsx.load(await exportTemplatePackage(template));
  assert.equal(saved.worksheets[0].pageSetup.printArea, 'A1:N34', 'automatic print range must include native images');
});

test('T43.5: paged output uses edited fractional native anchors, even alongside configured images', async () => {
  let template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  const worksheet = template.worksheets[0], image = worksheet.document.images[0];
  image.rect = { r: 2.25, c: 1.75, rows: 2.5, cols: 1.5 };
  template = upsertPageDefinition(template, { pageDefinitionId: 'images.page', label: '图片', pageType: 'main', paginationMode: 'fixed',
    worksheetIds: [worksheet.worksheetId], paperSize: 'A4', orientation: 'portrait', marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    printableRect: { r: 0, c: 0, rows: 20, cols: 10 }, regions: [],
    imagePlacements: [{ imageId: 'placed', resourceId: image.resourceId, worksheetId: worksheet.worksheetId, rect: { r: 10, c: 1, rows: 1, cols: 1 } }] });
  const projection = projectPagePlan(template, planFixedPages(template, 'images.page', []), []);
  assert.equal(projection.pages[0].imagePlacements.length, 3, 'configured images must not hide imported images');
  assert.deepEqual(projection.pages[0].imagePlacements.find(item => item.imageId === image.imageId).rect, image.rect);
  const output = await exportPagedXlsx(template, projection);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(output.bytes);
  const native = workbook.worksheets[0].getImages()[0];
  assert.ok(Math.abs(native.range.tl.row - image.rect.r) < 0.001);
  assert.ok(Math.abs(native.range.tl.col - image.rect.c) < 0.001);
  assert.ok(Math.abs(native.range.br.row - image.rect.r - image.rect.rows) < 0.001);
});

test('T43.5: local row expansion relocates fixed footer images and rejects ambiguous repeating images', async () => {
  const template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  const doc = copy(template.worksheets[0].document);
  doc.images[1].rect = { r: 15.25, c: 4, rows: 1.5, cols: 1 };
  doc.repeatRegions = [{ id: 'local.rows', name: '本地明细', source: 'rows', rect: { r: 10, c: 0, rows: 1, cols: 10 }, empty: 'remove' }];
  const generated = generateDocument(doc, { rows: [{}, {}, {}] });
  assert.equal(generated.document.images[1].rect.r, 17.25);
  assert.deepEqual(generated.document.images[0].rect, doc.images[0].rect);
  doc.images[1].rect.r = 10;
  assert.throws(() => generateDocument(doc, { rows: [{}, {}] }), /图片.*重复区域/);
});

test('T43.5: native pictures outside the print area or in dynamic regions fail with a diagnostic', async () => {
  const template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  const worksheet = template.worksheets[0];
  template.pageDefinitions = [{ pageDefinitionId: 'native.page', label: '图片', pageType: 'main', paginationMode: 'fixed',
    worksheetIds: [worksheet.worksheetId], paperSize: 'A4', orientation: 'portrait', marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    printableRect: { r: 0, c: 0, rows: 2, cols: 2 }, regions: [] }];
  assert.throws(() => projectPagePlan(template, planFixedPages(template, 'native.page', []), []), /图片.*打印范围/);
  template.pageDefinitions[0].printableRect = { r: 0, c: 0, rows: 20, cols: 10 };
  template.pageDefinitions[0].regions = [{ regionId: 'detail', label: '明细', worksheetId: worksheet.worksheetId, kind: 'detail',
    rect: { r: 2, c: 1, rows: 1, cols: 3 }, viewId: 'rows', paginationGroupId: 'rows', groupBy: ['id'], recordHeight: 1, capacityRows: 2 }];
  const views = [{ viewId: 'rows', viewVersion: '1.0.0', datasetId: 'rows', outputFields: ['id'], records: [], inputRecordCount: 0, outputRecordCount: 0, diagnostics: [] }];
  assert.throws(() => projectPagePlan(template, planFixedPages(template, 'native.page', views), views), /图片.*动态重复区域/);
});
