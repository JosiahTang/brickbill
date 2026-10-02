import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createLocalReportingRuntime } from '../server/runtime.ts';
import { createReportingHttpServer } from '../server/http/app.ts';
import { newDocument } from '../src/domain/model.ts';
import { bindField } from '../src/domain/operations.ts';
import { createTemplatePackage, upsertPageDefinition } from '../src/core/templates/package.ts';
import { encodeCompositeKey } from '../src/core/adapters/project-adapter.ts';

function makeTemplate(projectId) {
  const document = newDocument(); document.name = '演示质保书'; document.sheetName = '主表';
  document.rows = 12; document.cols = 2; document.rowHeightPx = Array(12).fill(22); document.colWidthPx = [90, 100];
  document.fields = [
    { fieldId: 'material.heatNo', path: 'material.heatNo', label: '炉号', format: 'text', sourceKind: 'view', viewId: 'view.material.lines', sourceFieldId: 'material.heatNo' },
    { fieldId: 'material.lineId', path: 'material.lineId', label: '物料行号', format: 'text', sourceKind: 'view', viewId: 'view.material.lines', sourceFieldId: 'material.lineId' },
  ];
  bindField(document, 1, 0, 'material.heatNo'); bindField(document, 1, 1, 'material.lineId');
  let template = createTemplatePackage({ projectId, name: document.name, worksheets: [{ worksheetId: 'sheet.main', document }] });
  template.catalogVersion = '1.0.0';
  template = upsertPageDefinition(template, { pageDefinitionId: 'page.main', label: '主表', pageType: 'main', worksheetIds: ['sheet.main'],
    paperSize: 'A4', orientation: 'portrait', marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    printableRect: { r: 0, c: 0, rows: 12, cols: 2 }, regions: [{ regionId: 'region.material', worksheetId: 'sheet.main',
      label: '物料明细', kind: 'detail', rect: { r: 1, c: 0, rows: 1, cols: 2 }, viewId: 'view.material.lines',
      paginationGroupId: 'certificate', groupBy: ['material.heatNo'], recordHeight: 1, capacityRows: 8,
      emptyPolicy: 'keep', keepGroupsTogether: false, oversizedGroupPolicy: 'split-records' }] });
  return template;
}

test('HTTP generation pins a published template, snapshots output, paginates preview, enforces project scope and reprints idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-reporting-'));
  const runtime = await createLocalReportingRuntime(directory);
  const server = createReportingHttpServer(runtime.service, request => {
    if (request.headers.authorization === 'Bearer dalipu') return { projectIds: ['dalipu-demo'] };
    if (request.headers.authorization === 'Bearer mes') return { projectIds: ['general-mes-demo'] };
    return { projectIds: [] };
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); const origin = `http://127.0.0.1:${address.port}/api`;
  const request = async (path, token = 'dalipu', init = {}) => fetch(`${origin}${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  const sendJson = (path, method, body, token) => request(path, token, { method, body: JSON.stringify(body) });
  try {
    const health = await request('/health', 'no-token');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const projects = await request('/projects');
    assert.deepEqual((await projects.json()).map(item => item.projectId), ['dalipu-demo']);
    assert.equal((await request('/projects/general-mes-demo/catalog')).status, 403);

    const template = makeTemplate('dalipu-demo');
    const templatePath = `/projects/dalipu-demo/templates/${encodeURIComponent(template.packageId)}`;
    const saved = await sendJson(`${templatePath}/draft`, 'PUT', { template, expectedRevision: 0 });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 1);
    const resource = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=';
    const resourceSave = await sendJson(`${templatePath}/resources/image.seal`, 'PUT', { mediaType: 'image/png', base64: resource });
    assert.equal(resourceSave.status, 201);
    const resourceRead = await request(`${templatePath}/resources/image.seal`);
    assert.equal((await resourceRead.json()).sha256.length, 64);
    const conflict = await sendJson(`${templatePath}/draft`, 'PUT', { template, expectedRevision: 0 });
    assert.equal(conflict.status, 409);

    const viewId = 'view.material.lines';
    const views = await (await request('/projects/dalipu-demo/views')).json();
    const view = structuredClone(views.find(item => item.viewId === viewId)); view.label = '发布后的物料视图'; view.version = '1.0.1';
    const viewDraft = await sendJson(`/projects/dalipu-demo/views/${viewId}/draft`, 'PUT', { definition: view, expectedRevision: 0 });
    assert.equal(viewDraft.status, 200);
    const viewConflict = await sendJson(`/projects/dalipu-demo/views/${viewId}/draft`, 'PUT', { definition: view, expectedRevision: 0 });
    assert.equal(viewConflict.status, 409);
    const viewPublished = await sendJson(`/projects/dalipu-demo/views/${viewId}/publish`, 'POST', {});
    assert.equal((await viewPublished.json()).version, '1.0.1');
    const publishedResponse = await sendJson(`${templatePath}/publish`, 'POST', {});
    assert.equal(publishedResponse.status, 201);
    const published = await publishedResponse.json(); assert.equal(published.version, 1);
    assert.equal(published.value.viewRefs[0].viewId, 'view.material.lines');
    const matchRule = { documentType: 'qualityCertificate', conditions: { productPart: 'T' }, priority: 10 };
    const matchPath = `${templatePath}/versions/1/match-rule`;
    assert.equal((await sendJson(matchPath, 'PUT', matchRule)).status, 200);

    const generationPath = '/projects/dalipu-demo/generations';
    const payload = { mode: 'preview', documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
      templateRef: { id: template.packageId, version: 1 }, idempotencyKey: 'certificate-preview-1' };
    const generatedResponse = await sendJson(generationPath, 'POST', payload);
    assert.equal(generatedResponse.status, 201, JSON.stringify(await generatedResponse.clone().json()));
    const generated = await generatedResponse.json(); assert.equal(generated.pageCount, 1);
    assert.equal(generated.snapshot.data, undefined, 'status response should not duplicate the stored raw source snapshot');
    const pageResponse = await request(`/projects/dalipu-demo/generations/${generated.generationId}/pages/1`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json(); assert.equal(page.sheets[0].document.cells['1:0'].text, '2512865');
    assert.equal(page.sheets[0].pageNumber, 1);

    const repeated = await sendJson(generationPath, 'POST', payload);
    assert.equal((await repeated.json()).generationId, generated.generationId);
    const reusedKey = await sendJson(generationPath, 'POST', { ...payload, businessKey: { printNo: 'OTHER', productPart: 'T' } });
    assert.equal(reusedKey.status, 409, 'one idempotency key cannot represent different generation input');
    const reprint = await sendJson(`/projects/dalipu-demo/generations/${generated.generationId}/reprint`, 'POST', {});
    assert.equal((await reprint.json()).reusedSnapshot, true);
    const file = await request(`/projects/dalipu-demo/generations/${generated.generationId}/file`);
    assert.equal(file.status, 200); assert.equal(file.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const stored = await runtime.service.generation('dalipu-demo', generated.generationId);
    assert.equal(stored.snapshot.data.sourceVersion, 'dalipu-sample-v1');
    assert.equal(stored.snapshot.output.sha256.length, 64);

    if (process.env.REPORTING_PDF_PYTHON && process.env.REPORTING_PDF_FALLBACK_FONT) {
      const priorGate = process.env.REPORTING_PDF_ENABLED_PROJECTS;
      const priorPython = process.env.REPORTING_PDF_PYTHON;
      const priorFont = process.env.REPORTING_PDF_FALLBACK_FONT;
      const pdfPath = `/projects/dalipu-demo/generations/${generated.generationId}/file.pdf`;
      try {
        assert.equal((await request(pdfPath)).status, 400, 'PDF requires an explicit project gate');
        process.env.REPORTING_PDF_ENABLED_PROJECTS = 'dalipu-demo';
        const status = await (await request(`/projects/dalipu-demo/generations/${generated.generationId}`)).json();
        assert.equal(status.pdfUrl, `/api${pdfPath}`);
        const first = await request(pdfPath);
        assert.equal(first.status, 200, JSON.stringify(await first.clone().json().catch(() => ({}))));
        assert.equal(first.headers.get('content-type'), 'application/pdf');
        const bytes = new Uint8Array(await first.arrayBuffer());
        assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('ascii'), '%PDF-');
        const cached = await runtime.service.snapshots.readPdf('dalipu-demo', generated.generationId);
        assert.equal(cached.sha256.length, 64);
        assert.equal(cached.renderer.pageCount, generated.pageCount);
        process.env.REPORTING_PDF_PYTHON = '';
        process.env.REPORTING_PDF_FALLBACK_FONT = '';
        const cachedStatus = await (await request(`/projects/dalipu-demo/generations/${generated.generationId}`)).json();
        assert.equal(cachedStatus.pdfUrl, `/api${pdfPath}`, 'cached PDF remains available without the renderer');
        assert.deepEqual(new Uint8Array(await (await request(pdfPath)).arrayBuffer()), bytes,
          'reprint reads the immutable PDF sidecar');
        assert.equal((await request(pdfPath, 'mes')).status, 403, 'another project cannot read the PDF');
      } finally {
        if (priorGate === undefined) delete process.env.REPORTING_PDF_ENABLED_PROJECTS;
        else process.env.REPORTING_PDF_ENABLED_PROJECTS = priorGate;
        process.env.REPORTING_PDF_PYTHON = priorPython;
        process.env.REPORTING_PDF_FALLBACK_FONT = priorFont;
      }
    }

    const projectContext = runtime.service.projects.get('dalipu-demo');
    const originalCollect = projectContext.adapter.collect.bind(projectContext.adapter);
    projectContext.adapter.collect = async input => {
      const bundle = await originalCollect(input);
      const material = bundle.datasets.find(dataset => dataset.datasetId === 'material.lines');
      const seedRecord = material.records[0];
      material.records = Array.from({ length: 205 }, (_, index) => ({
        ...structuredClone(seedRecord), sourceRecordIds: [`long-source-${index + 1}`],
        recordId: encodeCompositeKey([seedRecord.values['material.printNo'], seedRecord.values['material.partFlag'], `LONG-${index + 1}`]),
        values: { ...seedRecord.values, 'material.lineId': `LONG-${index + 1}`, 'material.heatNo': `H-${index + 1}` },
      }));
      return bundle;
    };
    const longResponse = await sendJson(generationPath, 'POST', { ...payload, idempotencyKey: 'certificate-long-preview' });
    assert.equal(longResponse.status, 201);
    const longGeneration = await longResponse.json();
    assert.ok(longGeneration.pageCount > 1);
    let visibleRecordCount = 0;
    for (let pageNumber = 1; pageNumber <= longGeneration.pageCount; pageNumber++) {
      const response = await request(`/projects/dalipu-demo/generations/${longGeneration.generationId}/pages/${pageNumber}`);
      assert.equal(response.status, 200);
      const page = await response.json();
      visibleRecordCount += page.sheets.reduce((sum, sheet) => sum + sheet.recordCount, 0);
    }
    assert.equal(visibleRecordCount, 205, 'all rows beyond the old 200-row preview limit remain accessible across pages');

    const otherTemplate = makeTemplate('dalipu-demo');
    const otherPath = `/projects/dalipu-demo/templates/${encodeURIComponent(otherTemplate.packageId)}`;
    assert.equal((await sendJson(`${otherPath}/draft`, 'PUT', { template: otherTemplate, expectedRevision: 0 })).status, 200);
    assert.equal((await sendJson(`${otherPath}/publish`, 'POST', {})).status, 201);
    assert.equal((await sendJson(`${otherPath}/versions/1/match-rule`, 'PUT', { ...matchRule, priority: 5 })).status, 200);
    const autoPayload = { mode: 'preview', documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
      autoMatch: true, idempotencyKey: 'certificate-auto-match-1' };
    const autoGeneration = await (await sendJson(generationPath, 'POST', autoPayload)).json();
    assert.equal(autoGeneration.snapshot.templateRef.packageId, template.packageId, 'the highest registered priority wins');
    assert.equal((await sendJson(`${otherPath}/versions/1/match-rule`, 'PUT', matchRule)).status, 200);
    const ambiguousMatch = await sendJson(generationPath, 'POST', { ...autoPayload, idempotencyKey: 'certificate-auto-match-tie' });
    assert.equal(ambiguousMatch.status, 409);
    assert.equal((await ambiguousMatch.json()).error.code, 'TEMPLATE_MATCH_AMBIGUOUS');

    await sendJson(`${templatePath}/disable`, 'POST', {});
    const disabledGenerate = await sendJson(generationPath, 'POST', { ...payload, idempotencyKey: 'disabled-template-attempt' });
    assert.equal(disabledGenerate.status, 404);
    assert.equal((await request(`/projects/dalipu-demo/generations/${generated.generationId}/file`)).status, 200,
      'an existing snapshot remains available for reprint after its template is disabled');
    const restarted = await createLocalReportingRuntime(directory);
    const persisted = await restarted.service.generation('dalipu-demo', generated.generationId);
    assert.equal(persisted.snapshot.output.sha256, stored.snapshot.output.sha256);
    assert.deepEqual(await restarted.service.snapshots.readFile('dalipu-demo', generated.generationId),
      new Uint8Array(await (await request(`/projects/dalipu-demo/generations/${generated.generationId}/file`)).arrayBuffer()),
      'restart reads the same generated workbook from the persistent data directory');
    const persistedTemplate = await restarted.service.templates.getVersion('dalipu-demo', template.packageId, 1);
    assert.equal(persistedTemplate.value.packageId, template.packageId);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
