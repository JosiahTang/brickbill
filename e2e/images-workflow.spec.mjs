import { test, expect } from '@playwright/test';
import { imageWorkbook, replacementPng } from '../tests/fixtures/image-workbook.mjs';
import { readFile } from 'node:fs/promises';
import { importTemplatePackage } from '../src/export/importExcel.ts';
import ExcelJS from 'exceljs';
import { crc32 } from 'node:zlib';
import { createTemplatePackage } from '../src/core/templates/package.ts';
import { newDocument } from '../src/domain/model.ts';

test('T45.5 rejected resource commit keeps selection empty and a valid retry succeeds', async ({ page }) => {
  // Valid PNG with a large ancillary text chunk, leaving less room than the next valid PNG.
  const png = Buffer.from(replacementPng, 'base64'), text = Buffer.alloc(20 * 1024 * 1024 - 40 - png.length - 12, 65);
  text.write('note\0', 0); const chunk = Buffer.alloc(text.length + 12); chunk.writeUInt32BE(text.length, 0); chunk.write('tEXt', 4);
  text.copy(chunk, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const large = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  const doc = newDocument(); doc.fields = []; const template = createTemplatePackage({ worksheets: [{ document: doc }] });
  template.resources = [{ resourceId: 'near.limit', mediaType: 'image/png', base64: large.toString('base64') }];
  await page.goto('/'); await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled();
  const open = async value => {
    await page.locator('.topbar input[type=file]').setInputFiles({ name: 'limit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
    await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
  };
  await open(template); await page.getByRole('button', { name: '分页配置', exact: true }).click();
  await page.locator('.properties summary').filter({ hasText: '打印范围、重复表头与图片定位' }).click();
  await expect(page.locator('.image-resources img')).toHaveCount(1);
  expect(await page.locator('.image-resources img').evaluate(img => img.decode().then(() => img.naturalWidth))).toBe(1);
  const upload = page.locator('.image-resources input[type=file]'), select = page.locator('.image-resources').getByLabel('定位图片');
  await upload.setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.image-resources [role=alert]')).toContainText('20 MiB'); await expect(select).toHaveValue('');
  await expect(page.locator('.image-resources img')).toHaveCount(1);
  template.resources = []; await open(template);
  await upload.setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: png });
  await expect(select).not.toHaveValue(''); await expect(page.locator('.image-resources img')).toHaveCount(1);
  await expect(page.locator('.image-resources [role=alert]')).toHaveCount(0);
});

test('T45.5 image decode belongs to its load session; reversed uploads merge and preserve latest selection', async ({ page }) => {
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  await page.addInitScript(() => {
    const decode = window.createImageBitmap.bind(window); window.imageDecodeGates = [];
    window.createImageBitmap = async (...args) => {
      const bitmap = await decode(...args);
      await new Promise(resolve => window.imageDecodeGates.push(resolve)); return bitmap;
    };
  });
  const template = await importTemplatePackage(await imageWorkbook(), 'upload.xlsx');
  const open = async () => {
    await page.locator('.topbar input[type=file]').setInputFiles({ name: 'upload.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(template)) });
    await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.template-image')).toHaveCount(2);
  };
  const saved = async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '保存 JSON', exact: true }).click()]);
    return JSON.parse(await readFile(await download.path(), 'utf8'));
  };
  const showImages = async () => {
    await page.getByRole('button', { name: '分页配置', exact: true }).click();
    const detail = page.locator('.properties details').filter({ has: page.locator('summary', { hasText: '打印范围、重复表头与图片定位' }) });
    if ((await detail.getAttribute('open')) === null) await detail.locator('summary').first().click();
  };
  const upload = async (base64, gateCount) => {
    await page.locator('.image-resources input[type=file]').setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') });
    await expect.poll(() => page.evaluate(() => window.imageDecodeGates.length)).toBe(gateCount);
  };
  const release = index => page.evaluate(i => window.imageDecodeGates[i](), index);
  await page.goto('/'); await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled(); await open(); await showImages();
  try {
    await upload(replacementPng, 1); await open(); // Same packageId, different loadEpoch.
    await release(0); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect((await saved()).resources).toEqual(template.resources);
    await showImages(); await upload(replacementPng, 2);
    await page.getByRole('button', { name: '单元格', exact: true }).click(); await release(1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect((await saved()).resources).toEqual(template.resources);
    await showImages();
    const otherPng = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
      const context = canvas.getContext('2d'); context.fillStyle = '#0000ff'; context.fillRect(0, 0, 2, 2); return canvas.toDataURL().split(',')[1]; });
    await upload(replacementPng, 3); await upload(otherPng, 4); await release(3);
    const select = page.locator('.image-resources').getByLabel('定位图片', { exact: false });
    await expect(select).not.toHaveValue(''); const selected = await select.inputValue();
    await release(2); await expect(page.locator('.image-resources img')).toHaveCount(template.resources.length + 2);
    await expect(select).toHaveValue(selected);
    let result = await saved(); expect(result.resources.map(item => item.base64)).toEqual(expect.arrayContaining([replacementPng, otherPng]));
    await upload(otherPng, 5); await release(4); await expect(select).toHaveValue(selected);
    expect((await saved()).resources).toHaveLength(template.resources.length + 2);
    await upload(replacementPng, 6); await select.selectOption(template.resources[0].resourceId); await release(5);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(select).toHaveValue(template.resources[0].resourceId);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '保存模板 Excel', exact: true }).click()]);
    result = await importTemplatePackage(await readFile(await download.path()), 'uploads.xlsx');
    expect(result.resources.map(item => item.base64)).toEqual(expect.arrayContaining([replacementPng, otherPng]));
    expect(failures).toEqual([]);
  } finally { await page.evaluate(() => window.imageDecodeGates.forEach(resolve => resolve())); }
});

test('T43: native images display, edit, undo and survive save/reopen and worksheet switches', async ({ page }) => {
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'images.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await imageWorkbook()) });
  await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
  const images = page.locator('.template-image');
  await expect(images).toHaveCount(2);
  await expect(images.first().locator('img')).toBeVisible();
  expect(failures).toEqual([]);
  const first = images.first(), before = await first.boundingBox();
  expect(before.x).toBeGreaterThan(0); expect(before.y).toBeGreaterThan(0);
  expect(await first.evaluate(node => { const r = node.getBoundingClientRect(); return document.elementFromPoint(r.x + 8, r.y + 8)?.closest('.template-image') === node; })).toBe(true);
  await page.mouse.move(before.x + 8, before.y + 8);
  await page.mouse.down(); await page.mouse.move(before.x + 38, before.y + 28, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => Math.round((await first.boundingBox()).x - before.x)).toBe(30);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => Math.round((await first.boundingBox()).x - before.x)).toBe(0);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => Math.round((await first.boundingBox()).x - before.x)).toBe(30);
  const handle = first.getByRole('button', { name: /缩放图片/ });
  const grip = await handle.boundingBox(), moved = await first.boundingBox();
  await page.mouse.move(grip.x + 5, grip.y + 5); await page.mouse.down();
  await page.mouse.move(grip.x + 25, grip.y + 20, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => Math.round((await first.boundingBox()).width - moved.width)).toBe(20);
  const edited = await first.boundingBox();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存模板 Excel' }).click();
  const saved = await readFile(await (await downloadEvent).path());
  const template = await importTemplatePackage(saved, 'saved.xlsx');
  const model = template.worksheets[0].document.images[0];
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(saved);
  expect(workbook.worksheets[0].getImages()).toHaveLength(2);
  expect(workbook.worksheets[0].getImages()[0].range.tl.col).toBeCloseTo(model.rect.c, 3);
  await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
  await page.locator('input[type=file]').setInputFiles({ name: 'saved.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: saved });
  await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
  await expect(images).toHaveCount(2);
  await expect.poll(async () => Math.round((await first.boundingBox()).width - edited.width)).toBe(0);
  await page.getByLabel('当前工作表', { exact: true }).selectOption({ label: '图片附表' });
  await expect(images).toHaveCount(1);
  await page.getByLabel('当前工作表', { exact: true }).selectOption({ label: '图片主表' });
  await expect(images).toHaveCount(2);
  await page.getByLabel('画布缩放').selectOption('0.5');
  await expect.poll(async () => Math.round((await first.boundingBox()).width * 2 - edited.width)).toBe(0);
  await page.getByLabel('画布缩放').selectOption('1');
  await expect.poll(async () => Math.round((await first.boundingBox()).width - edited.width)).toBe(0);
  const top = (await first.boundingBox()).y;
  await page.locator('.canvas').hover({ position: { x: 550, y: 250 } }); await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await first.boundingBox()).y).toBeLessThan(top - 30);
  await page.getByLabel('单元格地址').fill('A1'); await page.getByRole('button', { name: '定位', exact: true }).click();
  await expect.poll(async () => Math.round((await first.boundingBox()).y - top)).toBe(0);
  const jsonEvent = page.waitForEvent('download'); await page.getByRole('button', { name: '保存 JSON' }).click();
  const json = await readFile(await (await jsonEvent).path());
  expect(JSON.parse(json).worksheets[0].document.images[0].rect).toEqual(model.rect);
  await expect(page.locator('.save-status')).toContainText('草稿已自动保存');
  await page.reload(); await expect(page.locator('.save-status')).toContainText('已恢复本地草稿');
  await expect(images).toHaveCount(2);
  await expect.poll(async () => Math.round((await first.boundingBox()).width - edited.width)).toBe(0);
  await page.screenshot({ path: 'output/t43/image-editor.png' });

  // Configure the existing fixed-page route, then use the actual designer publish/generate UI.
  template.pageDefinitions = [{ pageDefinitionId: 'native.page', label: '图片主表', pageType: 'main', paginationMode: 'fixed',
    worksheetIds: [template.worksheets[0].worksheetId], paperSize: 'A4', orientation: 'portrait',
    marginsMm: { top: 10, right: 10, bottom: 10, left: 10 }, printableRect: { r: 0, c: 0, rows: 20, cols: 8 }, regions: [] }];
  await page.locator('input[type=file]').setInputFiles({ name: 'image-pages.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(template)) });
  await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  const service = page.locator('.el-dialog').filter({ hasText: '项目数据服务与模板发布' });
  await service.getByRole('button', { name: '保存项目模板草稿' }).click();
  await expect(service).toContainText('服务端草稿修订：1');
  await service.getByRole('button', { name: '发布预检' }).click(); await expect(service).toContainText('预检通过');
  await service.getByRole('button', { name: '发布新版本' }).click(); await expect(service).toContainText('已发布版本：1');
  await service.getByRole('button', { name: '读取业务数据并预览' }).click();
  const preview = page.locator('.el-dialog').filter({ hasText: '固定快照的逐页预览' });
  await expect(preview.locator('.page-image')).toHaveCount(2);
  const generatedEvent = page.waitForEvent('download'); await preview.getByRole('button', { name: '下载 XLSX' }).click();
  const generated = new ExcelJS.Workbook(); await generated.xlsx.load(await readFile(await (await generatedEvent).path()));
  expect(generated.worksheets[0].getImages()).toHaveLength(2);
  expect(generated.worksheets[0].getImages()[0].range.tl.col).toBeCloseTo(model.rect.c, 3);
  expect(generated.worksheets[0].getImages()[0].range.br.row).toBeCloseTo(model.rect.r + model.rect.rows, 3);
  if (process.env.REPORTING_PDF_PYTHON && process.env.REPORTING_PDF_FALLBACK_FONT) {
    const pdfEvent = page.waitForEvent('download'); await preview.getByRole('button', { name: '下载 PDF' }).click();
    const pdf = await readFile(await (await pdfEvent).path()); expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }
  expect(failures).toEqual([]);
});

test('T44: authoritative images, empty details, rejected conflicts and repeated saves use the existing UI', async ({ page }) => {
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  page.on('console', event => { if (event.type() === 'warning' && event.text().includes('Duplicate keys')) failures.push(event.text()); });
  const ready = () => expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
  const open = async template => { await ready(); await page.locator('input[type=file]').setInputFiles({ name: 'images.json',
    mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(template)) }); await ready(); };
  const download = async button => {
    const [file] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), button.click()]);
    const bytes = await readFile(await file.path()); await ready(); return bytes;
  };
  const read = async bytes => { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes); return workbook; };
  const imageContent = (workbook, sheet, index = 0) => Buffer.from(workbook.getImage(Number(workbook.worksheets[sheet].getImages()[index].imageId)).buffer).toString('base64');
  await page.goto('/');
  let template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  // The appendix label must fit the real PDF renderer's measured text height.
  template.worksheets[1].document.rowHeightPx[19] = 32;
  const original = template.resources[0].base64, local = structuredClone(template);
  local.worksheets[0].document.images[0].rect = { r: 8.25, c: 0, rows: 1.75, cols: 1 };
  local.worksheets[0].document.images[1].rect = { r: 13.25, c: 4, rows: 1.5, cols: 1 };
  local.worksheets[0].document.repeatRegions = [{ id: 'local', name: '明细', source: 'rows', empty: 'remove', rect: { r: 10, c: 0, rows: 1, cols: 10 } }];
  await open(local);
  await page.getByRole('button', { name: '从 JSON 数据自动生成字段' }).click();
  await page.getByLabel('业务 JSON 数据').fill('{"rows":[]}');
  await page.getByRole('button', { name: '生成预览', exact: true }).click();
  const localPreview = page.locator('.el-dialog').filter({ hasText: '生成结果预览' });
  const localWorkbook = await read(await download(localPreview.getByRole('button', { name: '下载生成结果 Excel' })));
  expect(localWorkbook.worksheets[0].getImages()[0].range.br.row).toBeCloseTo(10, 3);
  expect(localWorkbook.worksheets[0].getImages()[1].range.tl.row).toBeCloseTo(12.25, 3);
  await localPreview.getByRole('button', { name: 'Close this dialog' }).click();

  // JSON manifest edits are supported inputs; no new delete/replace image UI is introduced.
  template.resources.push({ resourceId: 'replacement', mediaType: 'image/png', base64: replacementPng });
  template.worksheets[0].document.images = [{ ...template.worksheets[0].document.images[1], imageId: 'native.0', resourceId: 'replacement' }];
  await open(template);
  for (let i = 0; i < 2; i++) {
    const bytes = await download(page.getByRole('button', { name: '保存模板 Excel' })), workbook = await read(bytes);
    expect(workbook.worksheets[0].getImages()).toHaveLength(1);
    expect(imageContent(workbook, 0)).toBe(replacementPng); expect(imageContent(workbook, 1)).toBe(original);
    template = await importTemplatePackage(bytes, 'saved.xlsx');
    expect(template.worksheets[0].document.images[0].sourceIndex).toBe(0);
    await page.locator('input[type=file]').setInputFiles({ name: 'saved.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
    await ready(); await expect(page.locator('.template-image')).toHaveCount(1);
  }
  await page.getByLabel('当前工作表', { exact: true }).selectOption({ label: '图片附表' });
  await expect(page.locator('.template-image')).toHaveCount(1);
  await expect(page.locator('.template-image img')).toHaveAttribute('src', `data:image/png;base64,${original}`);
  await page.getByLabel('当前工作表', { exact: true }).selectOption({ label: '图片主表' });
  await expect(page.locator('.template-image img')).toHaveAttribute('src', `data:image/png;base64,${replacementPng}`);
  const pageDefinition = { pageDefinitionId: 'main', label: '图片主表', pageType: 'main', paginationMode: 'fixed',
    worksheetIds: [template.worksheets[0].worksheetId], paperSize: 'A4', orientation: 'portrait',
    marginsMm: { top: 10, right: 10, bottom: 10, left: 10 }, printableRect: { r: 0, c: 0, rows: 20, cols: 8 }, regions: [] };
  template.pageDefinitions = [pageDefinition, { ...structuredClone(pageDefinition), pageDefinitionId: 'appendix', label: '附表', pageType: 'appendix',
    continuationOf: 'main', worksheetIds: [template.worksheets[1].worksheetId] }];
  const collision = structuredClone(template);
  collision.pageDefinitions[0].imagePlacements = [{ imageId: 'native.0', resourceId: 'replacement', worksheetId: template.worksheets[0].worksheetId, rect: { r: 15, c: 0, rows: 1, cols: 1 } }];
  await open(collision);
  await expect(page.locator('.el-message--error').last()).toContainText('标识冲突');
  await expect(page.locator('.template-image img')).toHaveAttribute('src', `data:image/png;base64,${replacementPng}`);
  const unchanged = JSON.parse((await download(page.getByRole('button', { name: '保存 JSON' }))).toString());
  expect(unchanged.worksheets[0].document.images[0].resourceId).toBe('replacement');
  expect(unchanged.pageDefinitions ?? []).toHaveLength(0);

  // Publish a valid contract with a picture in expanded/blank detail capacity; generation must reject it.
  const conflicting = structuredClone(template); conflicting.worksheets[0].document.merges = [];
  conflicting.worksheets[0].document.images[0].rect = { r: 6, c: 0, rows: 1, cols: 1 };
  conflicting.pageDefinitions[0].regions = [{ regionId: 'material', label: '物料', worksheetId: template.worksheets[0].worksheetId,
    kind: 'detail', rect: { r: 3, c: 0, rows: 1, cols: 3 }, viewId: 'view.certificate.material-print', paginationGroupId: 'material',
    groupBy: ['report.heatNo'], recordHeight: 1, capacityRows: 8 }];
  await open(conflicting);
  const service = page.locator('.el-dialog').filter({ hasText: '项目数据服务与模板发布' });
  const publish = async () => {
    await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
    await service.getByRole('button', { name: '保存项目模板草稿' }).click(); await ready();
    await service.getByRole('button', { name: '发布预检' }).click(); await expect(service).toContainText('预检通过');
    await service.getByRole('button', { name: '发布新版本' }).click(); await ready();
  };
  await publish(); await service.getByRole('button', { name: '读取业务数据并预览' }).click();
  await expect(service.locator('.error-box')).toContainText('动态重复区域');
  await service.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.template-image')).toHaveCount(1);
  // A new template is deliberate: the failed published fixture remains immutable.
  template.packageId += '.safe'; await open(template); await publish();
  await service.getByRole('button', { name: '读取业务数据并预览' }).click();
  const preview = page.locator('.el-dialog').filter({ hasText: '固定快照的逐页预览' });
  await expect(preview.locator('.page-image')).toHaveCount(1);
  const generated = await read(await download(preview.getByRole('button', { name: '下载 XLSX' })));
  expect(generated.worksheets.map(sheet => sheet.getImages().length)).toEqual([1, 1]);
  expect(imageContent(generated, 0)).toBe(replacementPng); expect(imageContent(generated, 1)).toBe(original);
  await preview.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(preview.locator('.page-image')).toHaveCount(1);
  await expect(preview.locator('.page-image')).toHaveAttribute('src', `data:image/png;base64,${original}`);
  if (process.env.REPORTING_PDF_PYTHON && process.env.REPORTING_PDF_FALLBACK_FONT) {
    const pdf = await download(preview.getByRole('button', { name: '下载 PDF' }));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }
  expect(failures).toEqual([]);
});

test('T44: a late initial template list cannot discard an image template save acknowledgment', async ({ page, request }) => {
  const template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
  let releaseList, listStarted, releaseSave, saveStarted;
  const listGate = new Promise(resolve => { releaseList = resolve; }), listed = new Promise(resolve => { listStarted = resolve; });
  const saveGate = new Promise(resolve => { releaseSave = resolve; }), saved = new Promise(resolve => { saveStarted = resolve; });
  let capturedList = false;
  await page.route('**/api/projects/dalipu-demo/templates', async route => {
    if (capturedList) return route.continue(); capturedList = true;
    const response = await route.fetch(); listStarted(); await listGate; await route.fulfill({ response });
  });
  const path = `/api/projects/dalipu-demo/templates/${template.packageId}/draft`;
  await page.route(`**${path}`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch(); saveStarted(); await saveGate; await route.fulfill({ response });
  });
  try {
    await page.goto('/'); await page.locator('input[type=file]').setInputFiles({ name: 'images.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(template)) });
    await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '项目服务 / 分页生成' }).click(); await listed;
    const service = page.locator('.el-dialog').filter({ hasText: '项目数据服务与模板发布' });
    await service.getByRole('button', { name: '保存项目模板草稿' }).click(); await saved;
    const listedResponse = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/projects/dalipu-demo/templates'));
    releaseList(); await listedResponse;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    releaseSave();
    await expect(service).toContainText('服务端草稿修订：1');
    await expect(service.getByRole('button', { name: '发布新版本', exact: true })).toBeEnabled();
    const remote = await (await request.get(path)).json();
    expect(remote.revision).toBe(1); expect(remote.value.worksheets[0].document.images).toHaveLength(2);
  } finally { releaseList(); releaseSave(); }
});
