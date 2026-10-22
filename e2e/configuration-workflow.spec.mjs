import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildExampleTemplate } from '../examples/projects/quality-templates.ts';
import { dalipuTemplates } from '../examples/projects/dalipu/index.ts';
import { generalMesTemplates } from '../examples/projects/general-mes/index.ts';
import { exportTemplatePackage } from '../src/export/excel.ts';
import { importTemplatePackage } from '../src/export/importExcel.ts';
import { createTemplatePackage } from '../src/core/templates/package.ts';
import { newDocument } from '../src/domain/model.ts';

async function pick(page, label, fieldId) {
  const input = page.getByRole('combobox', { name: label, exact: true });
  await input.locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]').click();
  await input.fill(fieldId);
  const listId = await input.getAttribute('aria-controls');
  await page.locator(`[id="${listId}"]`).getByRole('option').filter({ hasText: fieldId }).last().click();
  await input.press('Escape');
}
const dialog = (page, title) => page.locator('.el-dialog').filter({ hasText: title });

async function savedJson(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '保存 JSON', exact: true }).click()]);
  return JSON.parse(await readFile(await download.path(), 'utf8'));
}
async function openCatalogEditor(page) {
  const doc = newDocument(); doc.fields = [];
  const template = createTemplatePackage({ worksheets: [{ document: doc }] });
  await page.goto('/'); await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled();
  await page.locator('.topbar input[type=file]').setInputFiles({ name: 'catalog.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(template)) });
  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  const service = dialog(page, '项目数据服务与模板发布');
  await service.locator('select').first().selectOption('dalipu-demo');
  await expect(service.getByRole('button', { name: '将当前模板关联到所选项目' })).toBeEnabled();
  return service;
}

test('T45.1/2 failed imports preserve the editor and unsafe shared-field undo is recoverable in the UI', async ({ page }) => {
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  const a = newDocument(), b = newDocument(); a.id = 'a'; b.id = 'b'; a.sheetName = 'A'; b.sheetName = 'B'; a.fields = []; b.fields = [];
  const template = createTemplatePackage({ worksheets: [{ worksheetId: 'a', document: a }, { worksheetId: 'b', document: b }] });
  const open = async value => {
    await page.locator('.topbar input[type=file]').setInputFiles({ name: 'editor.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
    await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
  };
  const add = async path => {
    await page.getByRole('button', { name: '＋ 新增', exact: true }).click(); const editor = dialog(page, '新增字段');
    await editor.getByLabel('显示名称').fill(path); await editor.getByLabel('字段路径').fill(path);
    await editor.getByRole('button', { name: '保存字段', exact: true }).click();
  };
  await page.goto('/'); await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled(); await open(template);
  const sheets = page.getByLabel('当前工作表', { exact: true });
  await page.getByLabel('静态文本').fill('A edited'); await page.getByRole('button', { name: '应用文本', exact: true }).click();
  await sheets.selectOption('b'); await add('cert.later'); await sheets.selectOption('a');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  let saved = await savedJson(page); expect(saved.worksheets.every(sheet => sheet.document.fields.some(field => field.path === 'cert.later'))).toBe(true);
  expect(saved.worksheets[0].document.cells['0:0']).toBeUndefined();
  await add('cert.extra'); await sheets.selectOption('b');
  await page.getByLabel('绑定字段', { exact: false }).selectOption('cert.extra'); await page.getByRole('button', { name: '应用绑定', exact: true }).click();
  await sheets.selectOption('a'); await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.el-message--warning')).toContainText('绑定'); await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
  const intact = await savedJson(page), conflict = structuredClone(intact); conflict.worksheets[1].document.fields.find(field => field.path === 'cert.extra').format = 'number';
  await open(conflict); await expect(page.locator('.el-message--error')).toContainText('定义冲突');
  expect(await savedJson(page)).toEqual(intact);
  const broken = newDocument(); broken.name = 'Broken legacy'; broken.excelSource = { base64: 'AA==', fileName: 'broken.xlsx', sheetName: broken.sheetName, warnings: [] };
  await open(broken); await expect(page.locator('.el-message--error').last()).toContainText('无法读取 Excel');
  expect(await savedJson(page)).toEqual(intact);
  await sheets.selectOption('b'); await page.getByRole('button', { name: '解除绑定', exact: true }).click(); await sheets.selectOption('a');
  await page.getByRole('button', { name: '撤销', exact: true }).click(); saved = await savedJson(page);
  expect(saved.worksheets.every(sheet => !sheet.document.fields.some(field => field.path === 'cert.extra'))).toBe(true);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '保存模板 Excel', exact: true }).click()]);
  const reopened = await importTemplatePackage(await readFile(await download.path()), 'safe-undo.xlsx');
  expect(reopened.worksheets.every(sheet => sheet.document.fields.some(field => field.path === 'cert.extra'))).toBe(true);
  expect(failures).toEqual([]);
});

test('T45.1 delayed file preparation cannot replace edits made after opening started', async ({ page }) => {
  await page.addInitScript(() => {
    const text = File.prototype.text;
    File.prototype.text = async function() {
      if (this.name === 'delayed.json') await new Promise(resolve => { window.fileReadRelease = resolve; });
      return text.call(this);
    };
  });
  await page.goto('/'); await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled();
  const next = newDocument(); next.name = 'Late file';
  await page.locator('.topbar input[type=file]').setInputFiles({ name: 'delayed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(next)) });
  await expect.poll(() => page.evaluate(() => typeof window.fileReadRelease)).toBe('function');
  try {
    await page.getByLabel('模板名称', { exact: true }).fill('Keep newer edit'); await page.getByLabel('模板名称', { exact: true }).press('Tab');
    await page.evaluate(() => window.fileReadRelease()); await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
    expect((await savedJson(page)).name).toBe('Keep newer edit');
  } finally { await page.evaluate(() => window.fileReadRelease?.()); }
});

test('T45.1 late server draft cannot overwrite a newer local edit', async ({ page, request }) => {
  const template = await buildExampleTemplate(dalipuTemplates[0]); template.packageId = `e2e-t45-open-${randomUUID()}`;
  const path = `/api/projects/${template.projectId}/templates/${template.packageId}/draft`;
  expect((await request.put(path, { data: { template, expectedRevision: 0 } })).ok()).toBeTruthy();
  await page.goto('/'); await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled();
  await page.locator('.topbar input[type=file]').setInputFiles({ name: 'open.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(template)) });
  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  const service = dialog(page, '项目数据服务与模板发布'); await service.getByLabel('项目模板', { exact: true }).selectOption(template.packageId);
  await expect(service.getByRole('button', { name: '打开草稿', exact: true })).toBeEnabled();
  let release, started; const gate = new Promise(resolve => { release = resolve; }), received = new Promise(resolve => { started = resolve; });
  await page.route(`**${path}`, async route => { const response = await route.fetch(); started(); await gate; await route.fulfill({ response }); });
  try {
    await service.getByRole('button', { name: '打开草稿', exact: true }).click(); await received;
    await service.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByLabel('模板名称', { exact: true }).fill('Keep edit during server open'); await page.getByLabel('模板名称', { exact: true }).press('Tab');
    release(); await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
    expect((await savedJson(page)).name).toBe('Keep edit during server open');
  } finally { release(); await page.unroute(`**${path}`); }
});
test('T45.4 invalid catalog and network failure leave association and dictionary unchanged', async ({ page, request }) => {
  const service = await openCatalogEditor(page);
  const catalog = await (await request.get('/api/projects/dalipu-demo/catalog')).json();
  const source = catalog.fields.find(field => field.source.kind === 'dataset');
  const pattern = '**/projects/dalipu-demo/catalog';
  await page.route(pattern, route => route.fulfill({ json: { ...catalog, fields: [
    { ...source, fieldId: 'qa.good', label: 'Good' }, { ...source, fieldId: 'qa.bad', label: '' },
  ] } }));
  await service.getByRole('button', { name: '导入项目字段目录', exact: true }).click();
  await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
  await expect(service.locator('.error-box')).toContainText('字段名称');
  await service.getByRole('button', { name: '关闭', exact: true }).click();
  let saved = await savedJson(page); expect(saved.projectId).toBe('unassigned'); expect(saved.worksheets[0].document.fields).toEqual([]);
  await page.unroute(pattern);
  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  await page.route(pattern, route => route.fulfill({ status: 503, json: { error: { message: 'T45 catalog offline' } } }));
  await service.getByRole('button', { name: '导入项目字段目录', exact: true }).click(); await expect(service.locator('.error-box')).toContainText('T45 catalog offline');
  await service.getByRole('button', { name: '关闭', exact: true }).click();
  saved = await savedJson(page); expect(saved.projectId).toBe('unassigned'); expect(saved.worksheets[0].document.fields).toEqual([]);
});
test('T45.4 late catalog cannot import A fields into B and normal retry keeps concurrent manual edits', async ({ page, request }) => {
  const service = await openCatalogEditor(page);
  const catalog = await (await request.get('/api/projects/dalipu-demo/catalog')).json();
  const source = catalog.fields.find(field => field.source.kind === 'dataset');
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), received = new Promise(resolve => { started = resolve; });
  const pattern = '**/projects/dalipu-demo/catalog';
  await page.route(pattern, async route => { started(); await gate; await route.fulfill({ json: { ...catalog, fields: [{ ...source, fieldId: 'qa.old', label: 'Old A' }] } }); });
  try {
    await service.getByRole('button', { name: '导入项目字段目录', exact: true }).click(); await received;
    await service.locator('select').first().selectOption('general-mes-demo'); release();
    await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
    await service.getByRole('button', { name: '关闭', exact: true }).click();
    const saved = await savedJson(page); expect(saved.projectId).toBe('unassigned'); expect(saved.worksheets[0].document.fields).toEqual([]);
  } finally { release(); await page.unroute(pattern); }
  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  await service.locator('select').first().selectOption('dalipu-demo');
  await expect(service.getByRole('button', { name: '将当前模板关联到所选项目' })).toBeEnabled();
  const retryGate = new Promise(resolve => { release = resolve; }), retryReceived = new Promise(resolve => { started = resolve; });
  await page.route(pattern, async route => { started(); await retryGate; await route.fulfill({ json: { ...catalog, fields: [
    { ...source, fieldId: 'qa.manual', label: 'Catalog overwrite' }, { ...source, fieldId: 'qa.fresh', label: 'Fresh' },
  ] } }); });
  try {
    await service.getByRole('button', { name: '导入项目字段目录', exact: true }).click(); await retryReceived;
    await service.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '＋ 新增', exact: true }).click();
    const field = dialog(page, '新增字段'); await field.getByLabel('显示名称').fill('Manual stays');
    await field.getByLabel('字段路径').fill('qa.manual'); await field.getByRole('button', { name: '保存字段', exact: true }).click();
    release(); await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
    const saved = await savedJson(page); expect(saved.projectId).toBe('dalipu-demo');
    expect(saved.worksheets[0].document.fields.find(field => field.path === 'qa.manual').label).toBe('Manual stays');
    expect(saved.worksheets[0].document.fields.filter(field => field.path === 'qa.manual')).toHaveLength(1);
    expect(saved.worksheets[0].document.fields.some(field => field.path === 'qa.fresh')).toBe(true);
  } finally { release(); await page.unroute(pattern); }
});

test('T45.3 late draft and pinned trials never acquire the current configuration or overwrite its errors', async ({ page, request }) => {
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  const template = await buildExampleTemplate(dalipuTemplates[0]); template.packageId = `e2e-t45-trial-${randomUUID()}`;
  const path = `/api/projects/${template.projectId}/templates/${template.packageId}`;
  expect((await request.put(`${path}/draft`, { data: { template, expectedRevision: 0 } })).ok()).toBeTruthy();
  expect((await request.post(`${path}/publish`, { data: { expectedRevision: 1 } })).ok()).toBeTruthy();
  await page.goto('/'); await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled();
  await page.locator('.topbar input[type=file]').setInputFiles({ name: 'trial.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(template)) });
  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  const service = dialog(page, '项目数据服务与模板发布'), trial = service.getByRole('button', { name: '视图试算', exact: true });
  await service.getByLabel('项目模板', { exact: true }).selectOption(template.packageId);
  await expect(service.locator('label').filter({ hasText: /^已发布版本/ }).locator('select')).toHaveValue('1');
  const parameter = service.locator('input[placeholder="printNo"]'), pattern = '**/views/preview';
  const originalPrintNo = await parameter.inputValue();
  for (const mode of ['draft', 'pinned']) {
    await service.getByLabel('试算口径').selectOption(mode);
    let release, started;
    const gate = new Promise(resolve => { release = resolve; }), received = new Promise(resolve => { started = resolve; });
    await page.route(pattern, async route => {
      const response = await route.fetch(); expect(response.ok()).toBeTruthy();
      const body = await response.json(); body.catalogVersion = `OLD-${mode}`; started(); await gate; await route.fulfill({ json: body });
    });
    try {
      await trial.click(); await received; await parameter.fill('DEMO-CERT-BULK-001'); release();
      await expect(trial).toBeEnabled(); await expect(service).not.toContainText(`OLD-${mode}`);
    } finally { release(); await page.unroute(pattern); }
    await parameter.fill(originalPrintNo); await trial.click(); await expect(service).toContainText('试算完成');
    const failureGate = new Promise(resolve => { release = resolve; }), failureReceived = new Promise(resolve => { started = resolve; });
    await page.route(pattern, async route => { started(); await failureGate; await route.fulfill({ status: 503, json: { error: { code: 'LATE_FAILURE', message: 'T45 旧试算错误' } } }); });
    try {
      await trial.click(); await failureReceived; await parameter.fill('DEMO-CERT-BULK-001'); release();
      await expect(trial).toBeEnabled(); await expect(service).not.toContainText('T45 旧试算错误');
      await expect(page.locator('.el-message')).not.toContainText('T45 旧试算错误');
    } finally { release(); await page.unroute(pattern); }
    await parameter.fill(originalPrintNo);
    // Ask the real endpoint for one-row batches so next-page behavior is observable with the small fixture.
    await page.route(pattern, async route => {
      const response = await route.fetch({ postData: JSON.stringify({ ...route.request().postDataJSON(), limit: 1 }) });
      await route.fulfill({ response });
    });
    await trial.click(); const next = service.getByRole('button', { name: '下一批结果', exact: true }); await expect(next).toBeEnabled();
    await page.unroute(pattern);
    const batchGate = new Promise(resolve => { release = resolve; }), batchReceived = new Promise(resolve => { started = resolve; });
    await page.route(pattern, async route => {
      expect(route.request().postDataJSON().offset).toBe(1); const response = await route.fetch(); expect(response.ok()).toBeTruthy();
      const body = await response.json(); body.catalogVersion = `OLD-batch-${mode}`; started(); await batchGate; await route.fulfill({ json: body });
    });
    try {
      await next.click(); await batchReceived; await parameter.fill('DEMO-CERT-BULK-001'); release();
      await expect(trial).toBeEnabled(); await expect(service).not.toContainText(`OLD-batch-${mode}`);
    } finally { release(); await page.unroute(pattern); }
    await parameter.fill(originalPrintNo);
  }
  expect(failures).toEqual([]);
});

test('T45.3 late view-step and page-configuration trials stay separate from current edits', async ({ page }) => {
  const template = await buildExampleTemplate(dalipuTemplates[0]); template.packageId = `e2e-t45-layout-${randomUUID()}`;
  await page.goto('/'); await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled();
  await page.locator('.topbar input[type=file]').setInputFiles({ name: 'layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(template)) });
  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  const service = dialog(page, '项目数据服务与模板发布');
  await expect(service.getByRole('button', { name: '保存项目模板草稿', exact: true })).toBeEnabled();
  await service.getByRole('button', { name: '关闭', exact: true }).click(); await page.getByRole('button', { name: '数据视图', exact: true }).click();
  const editor = page.locator('.view-editor'); await editor.getByRole('button', { name: '新建视图', exact: true }).click();
  await editor.getByLabel('视图 ID', { exact: true }).fill('qa.t45.trial'); await editor.getByLabel('来源数据集').selectOption('material.lines');
  const pattern = '**/views/preview';
  const delay = async (button, change, marker) => {
    let release, started; const gate = new Promise(resolve => { release = resolve; }), received = new Promise(resolve => { started = resolve; });
    await page.route(pattern, async route => { const response = await route.fetch(); expect(response.ok()).toBeTruthy();
      const body = await response.json(); body.catalogVersion = marker; started(); await gate; await route.fulfill({ json: body }); });
    try {
      await button.click(); await received; await change(); release(); await expect(page.locator('.designer')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('.properties')).not.toContainText(marker);
    } finally { release(); await page.unroute(pattern); }
  };
  await delay(editor.getByRole('button', { name: '试算当前草稿', exact: true }), async () => {
    await pick(page, '筛选字段', 'material.pieces'); await editor.getByLabel('筛选条件', { exact: true }).selectOption('gt');
    await editor.getByLabel('比较值（属于条件用逗号分隔）').fill('2'); await editor.getByRole('button', { name: '追加步骤' }).click();
  }, 'OLD-view-step');
  await editor.getByRole('button', { name: '试算当前草稿', exact: true }).click(); await expect(page.locator('.properties .view-trial-results')).toContainText('qa.t45.trial');
  await page.getByRole('button', { name: '分页配置', exact: true }).click();
  await page.locator('.properties .region-card').filter({ hasText: '· main' }).locator('small').filter({ hasText: '发货物料：detail' }).getByRole('button', { name: '编辑区域' }).click();
  const trial = page.getByRole('button', { name: '试算当前分页配置', exact: true });
  await delay(trial, () => page.getByLabel('页面名称').fill('Edited page while waiting'), 'OLD-page');
  await trial.click(); await expect(page.locator('.properties .view-trial-results')).toContainText('分页试算：');
});

test('T32.3 template switching preserves the editor baseline and ignores late selection responses', async ({ page, request }) => {
  page.setDefaultTimeout(20_000);
  const template = await buildExampleTemplate(dalipuTemplates[0]);
  template.packageId = `e2e-t32-a-${randomUUID()}`; template.status = 'draft';
  const other = structuredClone(template); other.packageId = `e2e-t32-b-${randomUUID()}`; other.name = 'Other template';
  const localView = { contractVersion: 2, viewId: `qa.reload.${randomUUID().replaceAll('-', '')}`, label: 'Old view', version: '0.1.0',
    sourceDatasetId: 'material.lines', steps: [], outputFields: ['material.pieces'] };
  template.viewDrafts = [localView];
  const viewPath = `/api/projects/${template.projectId}/views/${localView.viewId}/draft`;
  expect((await request.put(viewPath, { data: { definition: localView, expectedRevision: 0 } })).ok()).toBeTruthy();
  const path = id => `/api/projects/${template.projectId}/templates/${id}/draft`;
  for (const value of [template, other]) expect((await request.put(path(value.packageId), { data: { template: value, expectedRevision: 0 } })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled();
  await page.locator('.topbar input[type=file]').setInputFiles({ name: 'switch.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await exportTemplatePackage(template)) });
  await expect(page.getByRole('textbox', { name: '模板名称' })).toHaveValue(dalipuTemplates[0].templateId);
  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  const service = dialog(page, '项目数据服务与模板发布'), select = service.getByLabel('项目模板', { exact: true });
  await select.selectOption(template.packageId);
  await service.getByRole('button', { name: '打开草稿', exact: true }).click();
  await expect(service).toContainText('服务端草稿修订：1');
  const newer = structuredClone(template); newer.name = 'Remote revision two';
  for (const sheet of newer.worksheets) sheet.document.name = newer.name;
  expect((await request.put(path(template.packageId), { data: { template: newer, expectedRevision: 1 } })).ok()).toBeTruthy();
  await select.selectOption(other.packageId);
  await expect(service).toContainText('选中：Other template');
  await select.selectOption(template.packageId);
  await expect(service).toContainText('服务端草稿已变化');
  await service.getByRole('button', { name: '保存项目模板草稿', exact: true }).click();
  await expect(service.locator('.error-box')).toContainText('修订冲突');
  expect((await (await request.get(path(template.packageId))).json()).revision).toBe(2);
  await service.getByRole('button', { name: '打开草稿', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '模板名称' })).toHaveValue('Remote revision two');
  expect((await request.put(viewPath, { data: { definition: { ...localView, label: 'New view' }, expectedRevision: 1 } })).ok()).toBeTruthy();
  await service.getByRole('button', { name: '打开草稿', exact: true }).click();
  await service.getByRole('button', { name: /发布当前模板包中的/ }).click();
  await expect(service.locator('.error-box')).toContainText('已由其他会话修改');
  await service.getByRole('button', { name: '重新载入服务端视图草稿（丢弃本地视图修改）', exact: true }).click();
  await service.getByRole('button', { name: '保存项目模板草稿', exact: true }).click();
  await expect(service).toContainText('服务端草稿修订：3');
  expect((await (await request.get(path(template.packageId))).json()).value.viewDrafts[0].label).toBe('New view');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/templates/${other.packageId}/versions`, async route => { await gate; await route.continue(); });
  await select.selectOption(other.packageId);
  await select.selectOption(template.packageId);
  release();
  await expect(service).toContainText('服务端草稿修订：3');
  await service.getByRole('button', { name: '打开草稿', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '模板名称' })).toHaveValue('Remote revision two');
});

test('T32.4 saving a captured package must not acknowledge edits made while the response is delayed', async ({ page, request }) => {
  page.setDefaultTimeout(20_000);
  const template = await buildExampleTemplate(dalipuTemplates[0]); template.packageId = `e2e-t32-save-${randomUUID()}`;
  await page.goto('/');
  await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled();
  await page.locator('.topbar input[type=file]').setInputFiles({ name: 'capture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(template)) });
  await expect(page.getByRole('textbox', { name: '模板名称' })).toHaveValue(template.worksheets[0].document.name);
  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  const service = dialog(page, '项目数据服务与模板发布');
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), received = new Promise(resolve => { started = resolve; });
  const draftPath = `/api/projects/${template.projectId}/templates/${template.packageId}/draft`;
  await page.route(`**${draftPath}`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
  });
  await service.getByRole('button', { name: '保存项目模板草稿', exact: true }).click();
  await received;
  await service.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('textbox', { name: '模板名称' }).fill('Edited during save');
  await page.getByRole('textbox', { name: '模板名称' }).press('Tab');
  release();
  await expect(page.getByRole('button', { name: '项目服务 / 分页生成' })).toBeEnabled();
  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  await expect(service.getByRole('button', { name: '发布新版本', exact: true })).toBeDisabled();
  expect((await (await request.get(draftPath)).json()).value.name).not.toBe('Edited during save');
  await page.unroute(`**${draftPath}`);
  await service.getByRole('button', { name: '保存项目模板草稿', exact: true }).click();
  await expect(service).toContainText('服务端草稿修订：2');
  await expect(service.getByRole('button', { name: '发布新版本', exact: true })).toBeEnabled();
  expect((await (await request.get(draftPath)).json()).value.name).toBe('Edited during save');
  const other = structuredClone(template); other.packageId = `e2e-save-other-${randomUUID()}`; other.status = 'draft';
  expect((await request.put(`/api/projects/${template.projectId}/templates/${other.packageId}/draft`,
    { data: { template: other, expectedRevision: 0 } })).ok()).toBeTruthy();
  await service.getByRole('button', { name: '刷新项目模板', exact: true }).click();
  let releaseSecond, startedSecond;
  const secondGate = new Promise(resolve => { releaseSecond = resolve; }), secondReceived = new Promise(resolve => { startedSecond = resolve; });
  await page.route(`**${draftPath}`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch(); startedSecond(); await secondGate; await route.fulfill({ response });
  });
  await service.getByRole('button', { name: '保存项目模板草稿', exact: true }).click(); await secondReceived;
  await service.getByLabel('项目模板', { exact: true }).selectOption(other.packageId);
  await expect(service).toContainText('服务端草稿修订：1');
  releaseSecond();
  await expect(service.getByRole('button', { name: '保存项目模板草稿', exact: true })).toBeEnabled();
  await expect(service.getByLabel('项目模板', { exact: true })).toHaveValue(other.packageId);
  await expect(service).toContainText('服务端草稿修订：1');
});

test('T32.5 match diagnostics ignore old parameters and projects and clear evidence after a failed request', async ({ page, request }) => {
  page.setDefaultTimeout(20_000);
  const template = await buildExampleTemplate(dalipuTemplates[0]); template.packageId = `e2e-match-${randomUUID()}`; template.status = 'draft';
  const templatePath = `/api/projects/${template.projectId}/templates/${template.packageId}`;
  expect((await request.put(`${templatePath}/draft`, { data: { template, expectedRevision: 0 } })).ok()).toBeTruthy();
  expect((await request.post(`${templatePath}/publish`, { data: { expectedRevision: 1 } })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled();
  await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
  const service = dialog(page, '项目数据服务与模板发布');
  await service.locator('select').first().selectOption('dalipu-demo');
  await service.getByLabel('项目模板', { exact: true }).selectOption(template.packageId);
  const inspect = service.getByRole('button', { name: /试算当前参数的模板命中/ });
  const response = customer => ({ candidates: [], ambiguous: false,
    winner: { templateId: customer, version: 1, priority: 1 },
    matchFacts: { customer: { value: customer, datasetId: 'certificate.header', fieldId: 'cert.customer', recordCount: 1 } } });
  let release, started;
  let gate = new Promise(resolve => { release = resolve; }), received = new Promise(resolve => { started = resolve; });
  const pattern = '**/templates/match-preview';
  await page.route(pattern, async route => { started(); await gate; await route.fulfill({ json: response('过期客户') }); });
  await inspect.click(); await received;
  await service.locator('input[placeholder="printNo"]').fill('DEMO-CERT-BULK-001');
  release();
  await expect(inspect).toBeEnabled(); await expect(service).not.toContainText('过期客户');
  await page.unroute(pattern);
  await page.route(pattern, route => route.fulfill({ json: response('当前客户') }));
  await inspect.click(); await expect(service).toContainText('当前客户');
  await page.unroute(pattern);
  await page.route(pattern, route => route.fulfill({ status: 503, json: { error: { code: 'TEST_MATCH_FAILURE', message: '匹配试算失败注入' } } }));
  await inspect.click(); await expect(service.locator('.error-box')).toContainText('匹配试算失败注入');
  await expect(service).not.toContainText('当前客户');
  await page.unroute(pattern);
  gate = new Promise(resolve => { release = resolve; }); received = new Promise(resolve => { started = resolve; });
  await page.route(pattern, async route => { started(); await gate; await route.fulfill({ json: response('旧项目客户') }); });
  await inspect.click(); await received;
  await service.locator('select').first().selectOption('general-mes-demo');
  release(); await expect(page.getByRole('button', { name: '项目服务 / 分页生成' })).toBeEnabled();
  await expect(service).not.toContainText('旧项目客户');
});

for (const spec of [dalipuTemplates[0], generalMesTemplates[0]]) {
  test(`T29 form configuration, unsaved trial, image placement and save/reopen in ${spec.projectId}`, async ({ page, request }) => {
    const failures = []; page.on('pageerror', error => failures.push(error.message));
    const template = await buildExampleTemplate(spec); template.packageId = `e2e-t29-${randomUUID()}`;
    await page.goto('/');
    await expect(page.getByRole('button', { name: '导入 / 打开模板' })).toBeEnabled();
    await page.locator('.topbar input[type=file]').setInputFiles({ name: 'configuration.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await exportTemplatePackage(template)) });
    await expect(page.getByRole('textbox', { name: '模板名称' })).toHaveValue(spec.templateId);
    await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
    const service = dialog(page, '项目数据服务与模板发布');
    await service.locator('select').first().selectOption(spec.projectId);
    const metadata = await (await request.get(`/api/projects/${spec.projectId}/designer-metadata`)).json();
    expect(metadata.project.templateMatchFields.customer).toEqual({
      label: '收货客户', datasetId: 'certificate.header', fieldId: 'cert.customer',
    });
    await expect(service).not.toContainText('服务处理失败');
    await service.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '数据视图', exact: true }).click();
    const editor = page.locator('.view-editor');
    await expect(editor.getByLabel('来源数据集').locator('option')).toHaveCount(metadata.project.datasets.length + 1);

    const groupId = `qa.group.${randomUUID().replaceAll('-','')}`;
    await editor.getByRole('button', { name: '新建视图', exact: true }).click();
    await editor.getByLabel('视图 ID', { exact: true }).fill(groupId);
    await editor.getByLabel('视图名称', { exact: true }).fill('物料根数平均值');
    await editor.getByLabel('来源数据集').selectOption('material.lines');
    await editor.getByLabel('步骤类型').selectOption('group');
    await pick(page, '分组字段', 'material.partFlag');
    await editor.getByRole('button', { name: '添加汇总' }).click();
    await pick(page, '汇总字段 1', 'material.pieces');
    await pick(page, '汇总输出 1', 'material.pieces');
    await editor.getByRole('button', { name: '追加步骤', exact: true }).click();
    await expect(editor).toContainText('步骤 1 · 分组汇总');
    await editor.getByRole('button', { name: '试算当前草稿' }).click();
    const results = page.locator('.properties .view-trial-results');
    await expect(results).toContainText(groupId);
    const groupResults = results.locator('details').filter({ has: page.locator('summary').filter({ hasText: groupId }) }).first();
    await expect(groupResults.locator('tbody')).toContainText(spec.projectId === 'dalipu-demo' ? '5.5' : '3.5');
    expect((await request.get(`/api/projects/${spec.projectId}/views/${groupId}/draft`)).status()).toBe(404);
    await editor.getByRole('button', { name: '校验并保存视图草稿' }).click();

    await expect(page.getByText('视图草稿已保存', { exact: true })).toBeVisible();

    await editor.getByRole('button', { name: '编辑步骤 1' }).click();
    await expect(editor.getByLabel('汇总方式')).toHaveValue('average');
    await editor.getByRole('button', { name: '更新步骤', exact: true }).click();
    await editor.locator('details').filter({ hasText: '高级视图 JSON' }).locator('summary').click();
    const json = editor.locator('textarea'); const before = JSON.parse(await json.inputValue());
    await editor.getByRole('button', { name: '应用 JSON 到表单' }).click();
    expect(JSON.parse(await json.inputValue())).toEqual(before);
    await editor.locator('details').filter({ hasText: '高级视图 JSON' }).locator('summary').click();

    await editor.getByLabel('步骤类型').selectOption('sort');
    await editor.getByRole('button', { name: '添加排序', exact: true }).click();
    await pick(page, '排序字段 1', 'material.pieces');
    await editor.getByRole('button', { name: '追加步骤', exact: true }).click();
    await editor.getByRole('button', { name: '上移', exact: true }).last().click();
    await expect(editor.locator('.region-card').filter({ hasText: '步骤 1' })).toContainText('排序');
    await editor.getByRole('button', { name: '下移', exact: true }).first().click();
    await editor.getByRole('button', { name: '删除步骤', exact: true }).last().click();

    const functionId = `qa.hardness.${randomUUID().replaceAll('-','')}`;
    await editor.getByRole('button', { name: '新建视图', exact: true }).click();
    await editor.getByLabel('视图 ID', { exact: true }).fill(functionId);
    await editor.getByLabel('来源数据集').selectOption('quality.hardness-results');
    await editor.getByLabel('步骤类型').selectOption('applyFunction');
    await editor.getByLabel('公共函数及版本').selectOption('hardness-by-sample@1.0.0');
    await editor.getByLabel('approvedOnly · boolean').selectOption('true');
    await editor.getByRole('button', { name: '追加步骤', exact: true }).click();
    await editor.getByRole('button', { name: '试算当前草稿' }).click();
    await expect(results).toContainText(functionId);
    await expect(results).toContainText('hardness.q1.out.average');
    await editor.getByRole('button', { name: '校验并保存视图草稿' }).click();

    const pivotId = `qa.pivot.${randomUUID().replaceAll('-','')}`;
    await editor.getByRole('button', { name: '新建视图', exact: true }).click();
    await editor.getByLabel('视图 ID', { exact: true }).fill(pivotId);
    await editor.getByLabel('来源数据集').selectOption('material.lines');
    await editor.getByLabel('步骤类型').selectOption('filter');
    await pick(page, '筛选字段', 'material.pieces');
    await editor.getByLabel('筛选条件', { exact: true }).selectOption('gt');
    await editor.getByLabel('比较值（属于条件用逗号分隔）').fill('0');
    await editor.getByRole('button', { name: '追加步骤', exact: true }).click();
    await editor.getByLabel('步骤类型').selectOption('pivot');
    await pick(page, '展开依据字段', 'material.heatNo');
    await pick(page, '展开数值字段', 'material.pieces');
    await editor.getByRole('button', { name: '添加展开列' }).click();
    await editor.getByLabel('展开列名称', { exact: true }).last().fill('第一炉');
    await editor.getByLabel('匹配值', { exact: true }).last().fill(spec.projectId === 'dalipu-demo' ? '2512865' : 'G25101');
    await pick(page, '展开输出 1', 'material.pieces');
    await editor.getByRole('button', { name: '添加展开列' }).click();
    await editor.getByLabel('展开列名称', { exact: true }).last().fill('第二炉');
    await editor.getByLabel('匹配值', { exact: true }).last().fill(spec.projectId === 'dalipu-demo' ? '2512867' : 'G25102');
    await pick(page, '展开输出 2', 'material.length');
    await editor.getByRole('button', { name: '追加步骤', exact: true }).click();
    await editor.getByLabel('步骤类型').selectOption('project');
    await editor.getByRole('button', { name: '添加字段映射' }).click();
    await pick(page, '来源字段 1', 'material.pieces');
    await pick(page, '目标字段 1', 'material.weight');
    await editor.getByRole('button', { name: '追加步骤', exact: true }).click();
    await editor.getByRole('button', { name: '试算当前草稿' }).click();
    await expect(results).toContainText(pivotId);
    const pivotResults = results.locator('details').filter({ has: page.locator('summary').filter({ hasText: pivotId }) }).first();
    await expect(pivotResults.locator('tbody')).toContainText(spec.projectId === 'dalipu-demo' ? '5' : '3');
    await editor.getByRole('button', { name: '校验并保存视图草稿' }).click();

    const parentId = `qa.parent.${randomUUID().replaceAll('-','')}`;
    await editor.getByRole('button', { name: '新建视图', exact: true }).click();
    await editor.getByLabel('视图 ID', { exact: true }).fill(parentId);
    await editor.getByLabel('来源数据集').selectOption('certificate.header');
    await editor.getByLabel('步骤类型').selectOption('lookup');
    await editor.getByLabel('关联关系').selectOption('header-contract');
    await editor.getByRole('button', { name: '添加字段映射' }).click();
    await pick(page, '来源字段 1', 'contract.orderNo');
    await pick(page, '目标字段 1', 'contract.orderNo');
    await editor.getByRole('button', { name: '追加步骤', exact: true }).click();
    await pick(page, '输出字段', 'contract.orderNo');
    await editor.locator('details').filter({ hasText: '父子视图集合' }).locator('summary').click();
    await editor.getByLabel('子集合关系').selectOption('header-materials');
    await editor.getByLabel('子视图', { exact: true }).selectOption('view.material.lines');
    await editor.getByLabel('集合名称').fill('materials');
    await editor.getByRole('button', { name: '添加子集合' }).click();
    await editor.getByRole('button', { name: '试算当前草稿' }).click();
    await expect(results).toContainText(parentId);
    await expect(results).toContainText('子集合（每组最多');
    await editor.getByRole('button', { name: '校验并保存视图草稿' }).click();

    await page.getByRole('button', { name: '分页配置', exact: true }).click();
    const materialCard = page.locator('.properties .region-card').filter({ hasText: '· main' }).locator('small').filter({ hasText: '发货物料：detail' });
    await materialCard.getByRole('button', { name: '编辑区域' }).click();
    await expect(page.getByLabel('视图标识')).toHaveValue('view.certificate.material-print');
    await expect(page.locator('.properties')).toContainText('当前区域容量：');
    await page.getByLabel('额外指定容量行数').fill('5');
    await page.getByRole('button', { name: '试算当前分页配置' }).click();
    await expect(page.locator('.properties .view-trial-results')).toContainText('分页试算：');
    await page.getByLabel('额外指定容量行数').fill('999');
    await page.getByRole('button', { name: '试算当前分页配置' }).click();
    await expect(page.locator('.properties .error-box')).toContainText('容量');
    await page.getByRole('button', { name: '定位配置问题' }).click();
    await expect(page.getByLabel('额外指定容量行数')).toHaveValue(String(template.pageDefinitions[0].regions.find(item => item.regionId === 'region.material').capacityRows));
    await page.getByLabel('额外指定容量行数').fill('5');

    await page.locator('.properties details').filter({ hasText: '打印范围、重复表头与图片定位' }).locator('summary').first().click();
    const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16; const context = canvas.getContext('2d'); context.fillStyle = '#cc0000'; context.fillRect(0,0,16,16); return canvas.toDataURL('image/png').split(',')[1]; });
    await page.getByLabel('上传图片').setInputFiles({ name: 'seal.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect(page.locator('.image-resources img')).toHaveCount(1);
    await page.getByRole('textbox', { name: '单元格地址' }).fill('O1:P2');
    await page.getByRole('textbox', { name: '单元格地址' }).press('Enter');
    await page.getByLabel('图片显示页').selectOption('first');
    await page.getByRole('button', { name: '将图片定位到当前选区' }).click();
    await page.getByRole('button', { name: '删除资源', exact: true }).click();
    await expect(page.locator('.image-resources [role=alert]')).toContainText('图片仍被引用');
    await page.getByRole('button', { name: '保存页面区域' }).click();
    await expect(page.getByText('页面和区域配置已保存', { exact: true })).toBeVisible();

    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存模板 Excel' }).click();
    const saved = await importTemplatePackage(new Uint8Array(await readFile(await (await downloaded).path())), 'configured.xlsx');
    const main = saved.pageDefinitions[0];
    expect(main.regions.find(item => item.regionId === 'region.material').rect).toEqual(template.pageDefinitions[0].regions.find(item => item.regionId === 'region.material').rect);
    expect(main.regions.find(item => item.regionId === 'region.material').capacityRows).toBe(5);
    expect(main.imagePlacements[0].rect).toEqual({ r: 0, c: 14, rows: 2, cols: 2 });
    expect(saved.viewDrafts.find(item => item.viewId === functionId).steps[0].parameters.approvedOnly).toBe(true);
    expect(saved.viewDrafts.find(item => item.viewId === groupId).steps[0].op).toBe('group');
    await page.reload();
    await expect(page.locator('.save-status')).toContainText('已恢复本地草稿');
    await page.getByRole('button', { name: '项目服务 / 分页生成' }).click();
    await service.locator('select').first().selectOption(spec.projectId);
    await service.getByRole('button', { name: '保存项目模板草稿' }).click();
    await expect(service).toContainText('服务端草稿修订：1');
    let publishCount = 0;
    const publishPattern = '**/views/*/publish';
    await page.route(publishPattern, async route => {
      if (++publishCount === 3) return route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'TEST_PUBLISH_FAILURE', message: '第三个视图发布故障注入' } }) });
      return route.continue();
    });
    await service.getByRole('button', { name: /发布当前模板包中的/ }).click();
    await expect(service.locator('.error-box')).toContainText('第三个视图发布故障注入');
    const partialVersions = Object.fromEntries((await (await request.get(`/api/projects/${spec.projectId}/views`)).json())
    .filter(view => [groupId, functionId, pivotId, parentId].includes(view.viewId)).map(view => [view.viewId, view.version]));
    expect(Object.keys(partialVersions)).toHaveLength(2);
    await page.unroute(publishPattern);
    await service.getByRole('button', { name: /发布当前模板包中的/ }).click();
    await expect(service).toContainText('已发布 4 个项目视图');
    const firstPublishVersions = Object.fromEntries((await (await request.get(`/api/projects/${spec.projectId}/views`)).json()).map(view => [view.viewId, view.version]));
    for (const [id, version] of Object.entries(partialVersions)) expect(firstPublishVersions[id]).toBe(version);
    await service.getByRole('button', { name: /发布当前模板包中的/ }).click();
    await expect(service).toContainText('已发布 4 个项目视图');
    const retryPublishVersions = Object.fromEntries((await (await request.get(`/api/projects/${spec.projectId}/views`)).json()).map(view => [view.viewId, view.version]));
    expect(retryPublishVersions).toEqual(firstPublishVersions);
    await service.getByRole('button', { name: '发布新版本' }).click();
    await expect(service).toContainText('已发布版本：1');
    await expect(service).toContainText('自动匹配条件（业务参数与 MES 采集字段）');
    await service.getByRole('button', { name: '读取业务数据并预览' }).click();
    const preview = dialog(page, '固定快照的逐页预览');
    await expect(preview).toBeVisible();
    await expect(preview.locator('img')).toHaveCount(1);
    await preview.getByRole('button', { name: '确认签发', exact: true }).click();
    await expect(preview).toContainText('已由 loopback');
    expect(failures).toEqual([]);
  });
}
