import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createLocalReportingRuntime } from '../server/runtime.ts';
import { createReportingHttpServer, loopbackAuthorizer } from '../server/http/app.ts';
import { newDocument } from '../src/domain/model.ts';
import { bindField } from '../src/domain/operations.ts';
import { createTemplatePackage, upsertPageDefinition } from '../src/core/templates/package.ts';
import { encodeCompositeKey } from '../src/core/adapters/project-adapter.ts';

test('T33.3: configured bearer token maps to stable server-side actor and unmapped tokens cannot sign', () => {
  const tokens = JSON.stringify({ 'employee-token-a': ['dalipu-demo'], 'employee-token-b': ['general-mes-demo'], 'preview-token': ['dalipu-demo'] });
  const actors = JSON.stringify({ 'employee-token-a': 'employee:0042', 'employee-token-b': 'employee:0042' });
  const authorize = loopbackAuthorizer(tokens, [], actors);
  const request = token => ({ headers: { authorization: 'Bearer ' + token }, socket: { remoteAddress: '10.0.0.12' } });
  assert.deepEqual(authorize(request('employee-token-a')), { projectIds: ['dalipu-demo'], actorId: 'employee:0042' });
  assert.deepEqual(authorize(request('employee-token-b')), { projectIds: ['general-mes-demo'], actorId: 'employee:0042' });
  const previewOnly = authorize(request('preview-token'));
  assert.deepEqual(previewOnly.projectIds, ['dalipu-demo']);
  assert.equal(previewOnly.actorId, undefined, 'an unmapped token keeps read access but cannot produce a signoff identity');
  assert.throws(() => loopbackAuthorizer(tokens, [], JSON.stringify({ outsider: 'employee:1' })), /必须同时配置/);
  const legacy = loopbackAuthorizer(JSON.stringify({ 'legacy-token': ['dalipu-demo'] }), [], undefined);
  assert.match(legacy(request('legacy-token')).actorId, /^token:[0-9a-f]{16}$/);
});

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
    if (request.headers.authorization === 'Bearer dalipu') return { projectIds: ['dalipu-demo'], actorId: 'qa-issuer' };
    if (request.headers.authorization === 'Bearer no-actor') return { projectIds: ['dalipu-demo'] };
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
    const projectList = await projects.json();
    assert.deepEqual(projectList.map(item => item.projectId), ['dalipu-demo']);
    assert.deepEqual(projectList[0].templateMatchFields.customer,
      { label: '收货客户', datasetId: 'certificate.header', fieldId: 'cert.customer' });
    assert.equal((await request('/projects/general-mes-demo/catalog')).status, 403);

    const template = makeTemplate('dalipu-demo');
    const templatePath = `/projects/dalipu-demo/templates/${encodeURIComponent(template.packageId)}`;
    const saved = await sendJson(`${templatePath}/draft`, 'PUT', { template, expectedRevision: 0 });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 1);
    const preflight = await sendJson(`${templatePath}/preflight`, 'POST', { expectedRevision: 1 });
    assert.equal(preflight.status, 200, await preflight.clone().text());
    const preflightResult = await preflight.json();
    assert.equal(preflightResult.draftRevision, 1);
    assert.ok(preflightResult.viewRefs.some(ref => ref.viewId === 'view.material.lines'));
    assert.equal((await runtime.service.templates.listVersions('dalipu-demo', template.packageId)).length, 0,
      'preflight resolves the same dependencies as publish without creating a version');
    assert.equal((await sendJson(`${templatePath}/preflight`, 'POST', { expectedRevision: 0 })).status, 409,
      'preflight rejects an outdated draft revision without changing it');
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
    const pinnedTrial = await sendJson('/projects/dalipu-demo/views/preview', 'POST', {
      documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
      versionMode: 'pinned', templateRef: { id: template.packageId, version: 1 },
      template: { projectId: 'untrusted-client-package' }, viewIds: ['view.material.lines'], limit: 2,
    });
    assert.equal(pinnedTrial.status, 200, await pinnedTrial.clone().text());
    assert.equal((await pinnedTrial.json()).mode, 'pinned', 'pinned trial loads the canonical published package using its server-side reference');
    const oneViewTrial = await sendJson('/projects/dalipu-demo/views/preview', 'POST', {
      documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
      versionMode: 'draft', definitions: [], viewIds: ['view.material.lines'], limit: 2,
    });
    assert.equal(oneViewTrial.status, 200, await oneViewTrial.clone().text());
    assert.equal((await oneViewTrial.json()).pagePlan, undefined, 'single-view trial does not plan unrelated template pages');
    const templates = await (await request('/projects/dalipu-demo/templates')).json();
    assert.ok(templates.some(item => item.templateId === template.packageId && item.latestVersion === 1 && !item.disabled));
    const loadedVersion = await request(`${templatePath}/versions/1`);
    assert.equal((await loadedVersion.json()).value.packageId, template.packageId);
    const matchRule = { documentType: 'qualityCertificate', conditions: { productPart: 'T' }, priority: 10 };
    const matchPath = `${templatePath}/versions/1/match-rule`;
    assert.equal((await sendJson(matchPath, 'PUT', matchRule)).status, 200);
    const matchPreview = await sendJson('/projects/dalipu-demo/templates/match-preview', 'POST', {
      documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
    });
    assert.equal(matchPreview.status, 200);
    assert.equal((await matchPreview.json()).winner.templateId, template.packageId);
    const unmatchedPreview = await sendJson('/projects/dalipu-demo/templates/match-preview', 'POST', {
      documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'X' },
    });
    const unmatchedResult = await unmatchedPreview.json();
    assert.equal(unmatchedResult.winner, undefined);
    assert.ok(unmatchedResult.candidates[0].mismatchedFields.includes('productPart'));

    const generationPath = '/projects/dalipu-demo/generations';
    const payload = { mode: 'preview', documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
      templateRef: { id: template.packageId, version: 1 }, idempotencyKey: 'certificate-preview-1' };
    const directIssue = await sendJson(generationPath, 'POST', { ...payload, mode: 'issue', idempotencyKey: 'forbidden-direct-issue' });
    assert.equal(directIssue.status, 400, 'a formal issue must refer to an already previewed snapshot');
    const generatedResponse = await sendJson(generationPath, 'POST', payload);
    assert.equal(generatedResponse.status, 201, JSON.stringify(await generatedResponse.clone().json()));
    const generated = await generatedResponse.json(); assert.equal(generated.pageCount, 1);
    assert.equal(generated.snapshot.data, undefined, 'status response should not duplicate the stored raw source snapshot');
    const historyBeforeIssue = await request(`${generationPath}?q=DEMO-CERT-001&status=preview&page=1&pageSize=5`);
    assert.equal(historyBeforeIssue.status, 200, await historyBeforeIssue.clone().text());
    const historyPage = await historyBeforeIssue.json();
    assert.equal(historyPage.total, 1);
    assert.equal(historyPage.items[0].generationId, generated.generationId);
    assert.equal(historyPage.items[0].businessKey.printNo, 'DEMO-CERT-001');
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
    const beforeIssueBytes = await runtime.snapshots.readFile('dalipu-demo', generated.generationId);
    const missingActor = await sendJson(`/projects/dalipu-demo/generations/${generated.generationId}/issue`, 'POST', {}, 'no-actor');
    assert.equal(missingActor.status, 403, 'issuance requires the authenticated host to provide an audit identity');
    const [issuedResponse, duplicateIssueResponse] = await Promise.all([
      sendJson(`/projects/dalipu-demo/generations/${generated.generationId}/issue`, 'POST', { actorId: 'spoofed-client' }),
      sendJson(`/projects/dalipu-demo/generations/${generated.generationId}/issue`, 'POST', {}),
    ]);
    assert.equal(issuedResponse.status, 200);
    assert.equal(duplicateIssueResponse.status, 200);
    const issued = await issuedResponse.json(), duplicateIssued = await duplicateIssueResponse.json();
    assert.equal(issued.signoff.actorId, 'qa-issuer', 'the signoff identity comes from server authorization, not the request body');
    assert.equal(duplicateIssued.signoff.signedAt, issued.signoff.signedAt, 'repeated confirmation returns the original signoff');
    assert.equal((await runtime.service.generation('dalipu-demo', generated.generationId)).mode, 'issue');
    assert.deepEqual(await runtime.snapshots.readFile('dalipu-demo', generated.generationId), beforeIssueBytes,
      'confirming issuance reuses the exact preview workbook bytes');
    const signedHistory = await (await request(`${generationPath}?q=DEMO-CERT-001&status=issue`)).json();
    assert.equal(signedHistory.total, 1);
    assert.equal(signedHistory.items[0].signoff.actorId, 'qa-issuer');
    await rm(join(runtime.snapshots.path('dalipu-demo', generated.generationId), 'history.json'));
    const upgradedHistory = await (await request(`${generationPath}?q=DEMO-CERT-001&status=issue`)).json();
    assert.equal(upgradedHistory.items[0].signoff.actorId, 'qa-issuer', 'legacy records backfill the compact history index from their stored snapshot');
    const futureHistory = await (await request(`${generationPath}?from=2999-01-01T00%3A00%3A00.000Z&page=1&pageSize=1`)).json();
    assert.equal(futureHistory.total, 0, 'date filtering excludes records outside the requested interval');
    const signedReprint = await sendJson(`/projects/dalipu-demo/generations/${generated.generationId}/reprint`, 'POST', {});
    assert.equal((await signedReprint.json()).reusedSnapshot, true);
    assert.equal((await request(`/projects/dalipu-demo/generations/${generated.generationId}/issue`, 'mes')).status, 403);

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
    assert.equal((await sendJson(`${otherPath}/versions/1/match-rule`, 'PUT', {
      documentType: 'qualityCertificate', conditions: { customer: '演示客户乙' }, priority: 50,
    })).status, 200);
    const autoPayload = { mode: 'preview', documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
      autoMatch: true, idempotencyKey: 'certificate-auto-match-1' };
    const matchProjectContext = runtime.service.projects.get('dalipu-demo');
    const originalMatchCollect = matchProjectContext.adapter.collect.bind(matchProjectContext.adapter);
    let autoCollectCount = 0;
    matchProjectContext.adapter.collect = async request => {
      autoCollectCount++;
      const bundle = await originalMatchCollect(request);
      bundle.datasets.find(item => item.datasetId === 'certificate.header').records[0].values['cert.customer'] = '演示客户乙';
      return bundle;
    };
    const customerBResponse = await sendJson(generationPath, 'POST', { ...autoPayload, idempotencyKey: 'certificate-customer-b' });
    assert.equal(customerBResponse.status, 201, await customerBResponse.clone().text());
    const customerBGeneration = await customerBResponse.json();
    assert.equal(customerBGeneration.snapshot.templateRef.packageId, otherTemplate.packageId,
      'the selected customer comes from trusted collected MES data');
    assert.equal(autoCollectCount, 1, 'auto matching and generation share one MES collection');
    const customerBAudit = (await runtime.service.generation('dalipu-demo', customerBGeneration.generationId)).snapshot.templateMatch;
    assert.equal(customerBAudit.facts.customer.value, '演示客户乙');
    assert.equal(customerBAudit.facts.customer.datasetId, 'certificate.header');
    assert.equal(customerBAudit.rule.conditions.customer, '演示客户乙');
    const customerBMatchPreview = await sendJson('/projects/dalipu-demo/templates/match-preview', 'POST', {
      documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
    });
    assert.equal((await customerBMatchPreview.json()).matchFacts.customer.value, '演示客户乙');
    const customerBHistory = await (await request(`${generationPath}?templateId=${encodeURIComponent(otherTemplate.packageId)}`)).json();
    assert.equal(customerBHistory.total, 1);
    assert.equal(customerBHistory.items[0].templateMatch.facts.customer.value, '演示客户乙',
      'the compact history index retains the original template-selection evidence');
    const spoofedCustomer = await sendJson('/projects/dalipu-demo/templates/match-preview', 'POST', {
      documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T', customer: '伪造客户' },
    });
    assert.equal(spoofedCustomer.status, 400, 'clients cannot provide trusted collected match fields');
    const spoofedGeneration = await sendJson(generationPath, 'POST', { ...autoPayload,
      businessKey: { ...autoPayload.businessKey, customer: '伪造客户' }, idempotencyKey: 'certificate-spoofed-customer' });
    assert.equal(spoofedGeneration.status, 400, 'generation also rejects a caller-supplied customer match value');
    matchProjectContext.adapter.collect = async request => {
      const bundle = await originalMatchCollect(request);
      const header = bundle.datasets.find(item => item.datasetId === 'certificate.header');
      const conflictingValues = { ...header.records[0].values, 'cert.partFlag': 'C', 'cert.customer': '演示客户乙' };
      header.records.push({ ...structuredClone(header.records[0]),
        recordId: encodeCompositeKey([conflictingValues['cert.printNo'], conflictingValues['cert.partFlag']]), values: conflictingValues });
      return bundle;
    };
    const conflictingCustomer = await sendJson(generationPath, 'POST', { ...autoPayload, idempotencyKey: 'certificate-customer-conflict' });
    assert.equal(conflictingCustomer.status, 422, await conflictingCustomer.clone().text());
    assert.equal((await conflictingCustomer.json()).error.code, 'AMBIGUOUS_SCOPE');
    matchProjectContext.adapter.collect = async request => {
      const bundle = await originalMatchCollect(request);
      bundle.datasets.find(item => item.datasetId === 'certificate.header').records = [];
      return bundle;
    };
    const missingCustomer = await sendJson(generationPath, 'POST', { ...autoPayload, idempotencyKey: 'certificate-customer-missing' });
    assert.equal(missingCustomer.status, 404);
    assert.equal((await missingCustomer.json()).error.code, 'DATA_NOT_FOUND');
    matchProjectContext.adapter.collect = originalMatchCollect;
    assert.equal((await sendJson(`${otherPath}/versions/1/match-rule`, 'PUT', { ...matchRule, priority: 5 })).status, 200);
    let parameterOnlyCollectionCount = 0;
    matchProjectContext.adapter.collect = async request => { parameterOnlyCollectionCount++; return originalMatchCollect(request); };
    const autoGeneration = await (await sendJson(generationPath, 'POST', autoPayload)).json();
    assert.equal(parameterOnlyCollectionCount, 1, 'parameter-only matching generates with a single source read');
    assert.equal(autoGeneration.snapshot.templateRef.packageId, template.packageId, 'the highest registered priority wins');
    assert.deepEqual(autoGeneration.snapshot.templateMatch.facts, {}, 'a parameter-only rule does not perform an unnecessary second data lookup');
    assert.equal(autoGeneration.snapshot.templateMatch.rule.conditions.productPart, 'T');
    const collectedMatchPreview = await sendJson('/projects/dalipu-demo/templates/match-preview', 'POST', {
      documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
    });
    assert.equal((await collectedMatchPreview.json()).matchFacts, undefined);
    assert.equal(parameterOnlyCollectionCount, 1, 'parameter-only match diagnostics do not query MES');
    matchProjectContext.adapter.collect = originalMatchCollect;
    assert.equal((await sendJson(`${otherPath}/versions/1/match-rule`, 'PUT', matchRule)).status, 200);
    const ambiguousMatch = await sendJson(generationPath, 'POST', { ...autoPayload, idempotencyKey: 'certificate-auto-match-tie' });
    assert.equal(ambiguousMatch.status, 409);
    assert.equal((await ambiguousMatch.json()).error.code, 'TEMPLATE_MATCH_AMBIGUOUS');
    const ambiguousPreview = await sendJson('/projects/dalipu-demo/templates/match-preview', 'POST', {
      documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
    });
    assert.equal((await ambiguousPreview.json()).ambiguous, true);

    const otherDraftReply = await (await request(`${otherPath}/draft`)).json();
    const revisedOther = { ...otherDraftReply.value, name: `${otherDraftReply.value.name} v2` };
    assert.equal((await sendJson(`${otherPath}/draft`, 'PUT', { template: revisedOther, expectedRevision: otherDraftReply.revision })).status, 200);
    assert.equal((await sendJson(`${otherPath}/publish`, 'POST', { expectedRevision: otherDraftReply.revision + 1 })).status, 201);
    const copiedRule = await (await request(`${otherPath}/versions/1/match-rule`)).json();
    assert.equal((await sendJson(`${otherPath}/versions/2/match-rule`, 'PUT', copiedRule)).status, 200);
    const latestRulePreview = await sendJson('/projects/dalipu-demo/templates/match-preview', 'POST', {
      documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
    });
    const latestRuleResult = await latestRulePreview.json();
    assert.ok(latestRuleResult.candidates.some(item => item.templateId === otherTemplate.packageId && item.version === 2));
    assert.equal((await request(`${otherPath}/versions/2/match-rule`, 'dalipu', { method: 'DELETE' })).status, 200);

    await sendJson(`${templatePath}/disable`, 'POST', {});
    const disabledInspection = await (await sendJson('/projects/dalipu-demo/templates/match-preview', 'POST', {
      documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
    })).json();
    assert.equal(disabledInspection.candidates.find(item => item.templateId === template.packageId).disabled, true);
    const disabledGenerate = await sendJson(generationPath, 'POST', { ...payload, idempotencyKey: 'disabled-template-attempt' });
    assert.equal(disabledGenerate.status, 404);
    assert.equal((await request(`/projects/dalipu-demo/generations/${generated.generationId}/file`)).status, 200,
      'an existing snapshot remains available for reprint after its template is disabled');
    const restarted = await createLocalReportingRuntime(directory);
    const persisted = await restarted.service.generation('dalipu-demo', generated.generationId);
    assert.equal(persisted.snapshot.output.sha256, stored.snapshot.output.sha256);
    assert.equal(persisted.signoff.actorId, 'qa-issuer', 'signoff metadata survives a service restart');
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
