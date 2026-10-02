import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { buildExampleTemplate } from '../examples/projects/quality-templates.ts';
import { dalipuTemplates } from '../examples/projects/dalipu/index.ts';
import { exportTemplatePackage } from '../src/export/excel.ts';
import { importTemplatePackage } from '../src/export/importExcel.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dialog = (page, title) => page.locator('.el-dialog').filter({ hasText: title });

async function downloadedBytes(download) {
  expect(download.failure ? await download.failure() : null).toBeNull();
  return readFile(await download.path());
}

test('import, drag a field, edit pagination, save, publish and generate matching XLSX/PDF pages', async ({ page, request }) => {
  const template = await buildExampleTemplate(dalipuTemplates[0]);
  template.packageId = `e2e-${randomUUID()}`;
  template.name = '浏览器验收质保书';
  // Give certificate, customer and contract values enough room in the imported sample layout.
  template.worksheets[0].document.colWidthPx[2] = 145;
  template.worksheets[0].document.colWidthPx[6] = 120;
  template.worksheets[0].document.colWidthPx[10] = 145;
  template.worksheets[0].document.colWidthPx[0] = 140;
  template.worksheets[0].document.merges.push({ r: 42, c: 0, rows: 1, cols: 16 });
  template.worksheets[1].document.colWidthPx[2] = 145;
  const sourceXlsx = await exportTemplatePackage(template);

  await page.goto('/');
  await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({ name: 'browser-acceptance.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(sourceXlsx) });
  await expect(page.getByRole('textbox', { name: '模板名称' })).toHaveValue('dalipu-certificate-v1');
  await expect(page.locator('.materials .field').first()).toBeVisible();

  const fieldPath = 'sample.sample_header_cert_certificateNo';
  const field = page.locator(`.field[data-field="${fieldPath}"]`);
  await expect(field).toBeVisible();
  await expect.poll(() => page.evaluate(() => { const rect = document.querySelector('.canvas').getBoundingClientRect();
    return document.elementFromPoint(rect.left + 350, rect.top + 145)?.closest('[data-u-comp="workbench-skeleton-shimmer"]') ? 'loading' : 'ready';
  })).toBe('ready');
  await field.dragTo(page.locator('.canvas'), { targetPosition: { x: 350, y: 145 } });
  await expect(page.locator('.statusbar')).toContainText('已绑定', { timeout: 3000 });
  const boundAddress = (await page.locator('.statusbar').innerText()).match(/已绑定 ([A-Z]+\d+) →/);
  expect(boundAddress).toBeTruthy();

  await page.getByRole('button', { name: '分页配置' }).click();
  const materialRegion = page.locator('.region-card').filter({ hasText: '质保书 · main' }).locator('small').filter({ hasText: '发货物料：detail' });
  await materialRegion.getByRole('button', { name: '编辑区域' }).click();
  await page.getByLabel('额外指定容量行数').fill('5');
  await page.getByRole('button', { name: '保存页面区域' }).click();
  await expect(page.getByText('页面和区域配置已保存')).toBeVisible();

  const templateDownloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存模板 Excel' }).click();
  const templateDownload = await templateDownloadEvent;
  const savedTemplate = await importTemplatePackage(await downloadedBytes(templateDownload), 'saved.xlsx');
  expect(savedTemplate.pageDefinitions.find(item => item.pageType === 'main').regions.find(item => item.regionId === 'region.material').capacityRows).toBe(5);
  expect(savedTemplate.worksheets[0].document.cells[`${Number(boundAddress[1].match(/\d+/)[0]) - 1}:${[...boundAddress[1].match(/[A-Z]+/)[0]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1}`].binding.path)
    .toBe(fieldPath);

  await page.reload();
  await expect(page.locator('.save-status')).toContainText('已恢复本地草稿');
  await page.getByRole('button', { name: '分页配置' }).click();
  await materialRegion.getByRole('button', { name: '编辑区域' }).click();
  await expect(page.getByLabel('额外指定容量行数')).toHaveValue('5');

  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  const service = dialog(page, '项目数据服务与模板发布');
  await expect(service.locator('select').first()).toHaveValue('dalipu-demo');
  await service.getByRole('button', { name: '保存项目模板草稿' }).click();
  await expect(service).toContainText('服务端草稿修订：1');
  await service.getByRole('button', { name: '发布新版本' }).click();
  await expect(service).toContainText('已发布版本：1');

  await service.getByRole('button', { name: '读取业务数据并预览' }).click();
  const preview = dialog(page, '固定快照的逐页预览');
  await expect(preview).toBeVisible();
  await expect(preview.locator('.preview-controls strong')).toContainText('1 /');
  await expect(preview.locator('.grid-cell').filter({ hasText: 'DLP-DEMO-1001' }).first()).toBeVisible();
  const generationId = (await preview.innerText()).match(/生成记录 ([\w-]+)/)?.[1];
  expect(generationId).toBeTruthy();
  const generationResponse = await request.get(`/api/projects/dalipu-demo/generations/${generationId}`);
  expect(generationResponse.ok()).toBeTruthy();
  const generation = await generationResponse.json();
  expect(generation.pageCount).toBeGreaterThanOrEqual(2);
  await preview.getByRole('button', { name: '末页' }).click();
  await expect(preview.locator('.page-kind')).toContainText('appendix');

  const xlsxDownloadEvent = page.waitForEvent('download');
  await preview.getByRole('button', { name: '下载 XLSX' }).click();
  const xlsx = await downloadedBytes(await xlsxDownloadEvent);
  expect(hash(xlsx)).toBe(generation.snapshot.output.sha256);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsx);
  expect(workbook.worksheets.length).toBe(generation.pageCount);
  expect(workbook.worksheets.at(-1).getCell('A1').text).toContain('硬度检验附页');

  if (process.env.REPORTING_PDF_PYTHON && process.env.REPORTING_PDF_FALLBACK_FONT) {
    expect(generation.pdfUrl).toBeTruthy();
    const pdfResponse = await request.get(generation.pdfUrl, { timeout: 60_000 });
    if (!pdfResponse.ok()) throw new Error(`PDF API returned ${pdfResponse.status()}: ${await pdfResponse.text()}`);
    const servedPdfBytes = Buffer.from(await pdfResponse.body());
    expect(servedPdfBytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    const pdfDownloadEvent = page.waitForEvent('download', { timeout: 30_000 });
    await preview.getByRole('button', { name: '下载 PDF' }).click();
    const pdf = await downloadedBytes(await pdfDownloadEvent);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(hash(pdf)).toBe(hash(servedPdfBytes));
  }

  await preview.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  const reopened = dialog(page, '项目数据服务与模板发布');
  await reopened.getByLabel('业务单号参数 JSON').fill(JSON.stringify({ printNo: 'DEMO-CERT-BULK-001', productPart: 'T' }));
  await reopened.getByRole('button', { name: '读取业务数据并预览' }).click();
  await expect(preview).toBeVisible();
  const pages = Number((await preview.locator('.preview-controls strong').innerText()).split('/')[1].trim());
  expect(pages).toBeGreaterThan(2);
  await preview.getByRole('button', { name: '末页' }).click();
  await expect(preview.locator('.page-kind')).toContainText('appendix');
});
