import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import dalipuBulk from './fixtures/reporting/dalipu/multipage.json' with { type: 'json' };
import dalipuSingle from './fixtures/reporting/dalipu/source.json' with { type: 'json' };
import { createLocalReportingRuntime } from '../server/runtime.ts';
import { InMemoryProjectAdapter } from '../src/core/adapters/project-adapter.ts';
import { createDalipuDemoProject, createExampleAdapterDefinition, createQualityDataViews, toRuntimeAdapterConfig } from '../src/core/adapters/example-projects.ts';
import { installExampleTemplates } from '../examples/projects/install.ts';
import { loadExcel } from '../src/export/importExcel.ts';
import { createPrintViews } from '../examples/projects/quality-views.ts';
import { loadProjectRegistrations } from '../server/project-registration.ts';
import { buildFieldCatalog } from '../src/core/catalog/catalog.ts';
import { catalogDatasetField } from '../src/core/catalog/designer-field.ts';
import { validateFields } from '../src/domain/fields.ts';
import { compareGenerationOutput } from '../src/core/reporting/output-comparison.ts';
import { sha256 } from '../server/repositories/local.ts';
import { imageWorkbook } from './fixtures/image-workbook.mjs';
import { imagePixels } from '../src/domain/images.ts';
import { validateProjectComparisonSuite } from '../src/core/reporting/comparison.ts';

async function imageComparisonFixture() {
  const bytes = await imageWorkbook(), workbook = await loadExcel(bytes);
  const snapshot = { generationId: 'image.check', projectId: 'image.project', businessKey: {},
    output: { sha256: sha256(bytes), byteLength: bytes.byteLength }, pagePlan: { totalPages: 0, pages: [] }, viewResults: [] };
  const expected = { generationId: snapshot.generationId, xlsx: { images: [{ sheet: workbook.worksheets[0].name, count: 2,
    anchors: workbook.worksheets[0].getImages().map(image => ({ tl: { row: image.range.tl.row, col: image.range.tl.col } })) }] } };
  const compare = (wanted = expected) => compareGenerationOutput('image', wanted, snapshot.projectId, {}, snapshot, bytes, workbook, sha256(bytes), { suiteVersion: 2 });
  return { bytes, workbook, snapshot, expected, compare };
}

test('T44.5: image comparison supports tl-only and one-cell extent anchors without uncaught errors', async () => {
  const { workbook, expected, compare } = await imageComparisonFixture();
  assert.equal(compare().passed, true);
  const sheet = workbook.worksheets[0], image = sheet.getImages()[1];
  // Use an oversized fixed extent so clamping to the last populated cell cannot pass.
  image.range.ext.width = 2000; image.range.ext.height = 3000;
  const colWidths = Array.from({ length: 40 }, (_, i) => (sheet.getColumn(i + 1).width ?? sheet.properties.defaultColWidth ?? 10) * 7 + 5);
  const rowHeights = Array.from({ length: 200 }, (_, i) => (sheet.getRow(i + 1).height ?? sheet.properties.defaultRowHeight ?? 18) * 96 / 72);
  const point = (px, sizes) => { let i = 0; while (px >= sizes[i]) px -= sizes[i++]; return i + px / sizes[i]; };
  expected.xlsx.images[0].anchors[1].br = { col: point(imagePixels({ r: 0, c: image.range.tl.col, rows: 1, cols: 1 }, { rowHeightPx: rowHeights, colWidthPx: colWidths }).x + 2000, colWidths),
    row: point(imagePixels({ r: image.range.tl.row, c: 0, rows: 1, cols: 1 }, { rowHeightPx: rowHeights, colWidthPx: colWidths }).y + 3000, rowHeights) };
  assert.equal(compare().passed, true);
  image.range.ext.width = -1;
  const invalid = compare(); assert.equal(invalid.passed, false);
  assert.ok(invalid.issues.some(issue => issue.code === 'IMAGE_ANCHOR_INVALID'));
});

test('T44.5: independent image bytes reject the wrong picture even with self-consistent output integrity', async () => {
  const { workbook, expected, compare } = await imageComparisonFixture();
  delete expected.xlsx.images[0].anchors;
  const actual = sha256(workbook.getImage(Number(workbook.worksheets[0].getImages()[0].imageId)).buffer);
  expected.xlsx.images[0].contentSha256 = ['0'.repeat(64), actual];
  const wrong = compare();
  assert.equal(wrong.passed, false, 'a self-consistent XLSX hash is not an independent image-content assertion');
  assert.ok(wrong.issues.some(issue => issue.code === 'IMAGE_CONTENT_MISMATCH'));
  expected.xlsx.images[0].contentSha256 = [actual, actual];
  assert.equal(compare().passed, true);
  assert.deepEqual(compare().imageContentChecks, { requested: 2, checked: 2, passed: 2 });
  const resource = workbook.getImage(Number(workbook.worksheets[0].getImages()[0].imageId));
  resource.buffer = Buffer.from('broken');
  assert.ok(compare().issues.some(issue => issue.code === 'IMAGE_CONTENT_INVALID'));
});

test('T44.5: suite v2 validates image-content assertions and v1 cannot silently claim them', async () => {
  const { expected } = await imageComparisonFixture();
  const suite = { suiteVersion: 2, suiteId: 'images', projectId: 'image.project', cases: [
    { caseId: 'images', documentType: 'certificate', businessKey: {}, assertions: [], generation: expected }] };
  expected.xlsx.images[0].contentSha256 = ['a'.repeat(64), 'b'.repeat(64)];
  assert.equal(validateProjectComparisonSuite(suite).suiteVersion, 2);
  for (const values of [['a'.repeat(64)], ['A'.repeat(64), 'a'.repeat(64)], ['broken', 'a'.repeat(64)]]) {
    const invalid = structuredClone(suite); invalid.cases[0].generation.xlsx.images[0].contentSha256 = values;
    assert.throws(() => validateProjectComparisonSuite(invalid), /contentSha256/);
  }
  suite.suiteVersion = 1;
  assert.throws(() => validateProjectComparisonSuite(suite), /v2|版本/);
  delete expected.xlsx.images[0].contentSha256;
  assert.equal(validateProjectComparisonSuite(suite).suiteVersion, 1);
  suite.suiteVersion = 99;
  assert.throws(() => validateProjectComparisonSuite(suite), /suiteVersion/);
});

test('T20: every MES dataset field can be imported into the designer without losing stable IDs', () => {
  const catalog = buildFieldCatalog(createDalipuDemoProject());
  const fields = catalog.fields.map(catalogDatasetField).filter(Boolean);
  assert.ok(fields.length > 100);
  validateFields(fields);
  assert.equal(fields.find(field => field.fieldId === 'hardness.q1.out.1').path, 'hardness.q1.out.n1');
  assert.equal(fields.find(field => field.fieldId === 'cert.printNo').collection, undefined);
});

test('T18/T19: imported XLSX layouts publish and generate from two differently mapped MES sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-projects-'));
  try {
    const { service, snapshots } = await createLocalReportingRuntime(directory);
    const installed = await installExampleTemplates(service);
    assert.equal(installed.length, 4);
    for (const item of installed) {
      const context = service.project(item.projectId);
      const result = await service.generate(item.projectId, {
        mode: 'preview', documentType: 'qualityCertificate', businessKey: context.request.businessKey,
        templateRef: { id: item.templateId, version: item.version },
        idempotencyKey: `sample:${item.templateId}`,
      });
      assert.ok(result.snapshot.pagePlan.totalPages >= 1);
      assert.ok(result.snapshot.viewResults.some(view => view.viewId === 'view.certificate-header'));
      assert.ok(result.snapshot.output.byteLength > 1000);
      const bytes = await snapshots.readFile(item.projectId, result.snapshot.generationId);
      assert.equal((await loadExcel(bytes)).worksheets.length, result.snapshot.pagePlan.totalPages);
      const repeated = await service.generate(item.projectId, {
        mode: 'preview', documentType: 'qualityCertificate', businessKey: context.request.businessKey,
        templateRef: { id: item.templateId, version: item.version },
        idempotencyKey: `sample:${item.templateId}`,
      });
      assert.equal(repeated.snapshot.generationId, result.snapshot.generationId);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T31: customer data selects a published template through the same pipeline in both projects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-customer-route-'));
  try {
    const { service } = await createLocalReportingRuntime(directory);
    const installed = await installExampleTemplates(service);
    for (const [projectId, customer] of [['dalipu-demo', '演示客户甲'], ['general-mes-demo', '演示客户乙']]) {
      const options = installed.filter(item => item.projectId === projectId).slice(0, 2);
      assert.equal(options.length, 2);
      await service.setTemplateMatchRule(projectId, options[0].templateId, options[0].version, {
        documentType: 'qualityCertificate', conditions: { customer: '不匹配客户' }, priority: 20,
      });
      await service.setTemplateMatchRule(projectId, options[1].templateId, options[1].version, {
        documentType: 'qualityCertificate', conditions: { customer }, priority: 20,
      });
      const context = service.project(projectId), collect = context.adapter.collect.bind(context.adapter);
      let collectionCount = 0;
      context.adapter.collect = async request => { collectionCount++; return collect(request); };
      const result = await service.generate(projectId, { mode: 'preview', documentType: 'qualityCertificate',
        businessKey: context.request.businessKey, autoMatch: true, idempotencyKey: `t31-customer-${projectId}` });
      assert.equal(result.snapshot.templateRef.packageId, options[1].templateId);
      assert.equal(result.snapshot.templateMatch.facts.customer.value, customer);
      assert.equal(result.snapshot.templateMatch.rule.conditions.customer, customer);
      assert.equal(collectionCount, 1);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T32.1: only eligible rules require facts; missing, long and conflicting required facts fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-match-scope-'));
  try {
    const { service } = await createLocalReportingRuntime(directory);
    const installed = (await installExampleTemplates(service)).filter(item => item.projectId === 'dalipu-demo');
    const context = service.project('dalipu-demo'), collect = context.adapter.collect.bind(context.adapter);
    context.project.templateMatchFields.unused = { label: 'unused', datasetId: 'certificate.header', fieldId: 'cert.purchaser' };
    let calls = 0, customer = '演示客户甲', duplicate = false;
    context.adapter.collect = async request => {
      calls++;
      const data = await collect(request), header = data.datasets.find(item => item.datasetId === 'certificate.header');
      header.records[0].values['cert.purchaser'] = null;
      header.records[0].values['cert.customer'] = customer;
      if (duplicate) header.records.push({ ...structuredClone(header.records[0]), recordId: 'same-customer-second-record' });
      return data;
    };
    const rule = { documentType: 'qualityCertificate', conditions: { customer: '演示客户甲' }, priority: 10 };
    await service.setTemplateMatchRule('dalipu-demo', installed[0].templateId, 1, rule);
    const inspect = () => service.inspectTemplateMatches('dalipu-demo', rule.documentType, context.request.businessKey);
    assert.equal((await inspect()).winner.templateId, installed[0].templateId, 'unused nullable mapping must not block customer matching');
    assert.equal(calls, 1);
    duplicate = true;
    assert.equal((await inspect()).matchFacts.customer.recordCount, 2);
    duplicate = false;
    for (const invalid of [null, '', ' '.repeat(3), 'x'.repeat(201)]) {
      customer = invalid;
      await assert.rejects(inspect(), error => error.code === 'VALUE_TYPE_ERROR');
    }
    context.adapter.collect = async request => {
      const data = await collect(request), header = data.datasets.find(item => item.datasetId === 'certificate.header');
      header.records.push({ ...structuredClone(header.records[0]), recordId: 'conflicting',
        values: { ...header.records[0].values, 'cert.customer': '另一个客户' } });
      return data;
    };
    await assert.rejects(inspect(), error => error.code === 'AMBIGUOUS_SCOPE');
    await service.templates.setDisabled('dalipu-demo', installed[0].templateId, true);
    context.adapter.collect = async () => { throw new Error('ineligible candidates must not collect'); };
    const disabled = await inspect();
    assert.equal(disabled.candidates[0].disabled, true);
    assert.deepEqual(disabled.candidates[0].pendingFields, ['customer']);
    assert.deepEqual(disabled.candidates[0].mismatchedFields, []);
    assert.equal(disabled.matchFacts, undefined);
    await service.templates.setDisabled('dalipu-demo', installed[0].templateId, false);
    await service.setTemplateMatchRule('dalipu-demo', installed[0].templateId, 1,
      { ...rule, conditions: { productPart: 'C', customer: '演示客户甲' } });
    assert.equal((await inspect()).matchFacts, undefined, 'known parameter mismatch excludes source dependencies');
    await service.setTemplateMatchRule('dalipu-demo', installed[1].templateId, 1,
      { ...rule, conditions: {}, priority: 1 });
    await service.setTemplateMatchRule('dalipu-demo', installed[0].templateId, 1, rule);
    context.adapter.collect = async request => {
      const data = await collect(request);
      data.datasets.find(item => item.datasetId === 'certificate.header').records = [];
      return data;
    };
    await assert.rejects(inspect(), error => error.code === 'DATA_NOT_FOUND', 'required facts cannot silently fall back');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T32.2: generation and inspection keep captured rules across collection waits; subsequent requests see edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-captured-match-'));
  try {
    const { service } = await createLocalReportingRuntime(directory);
    const installed = (await installExampleTemplates(service)).filter(item => item.projectId === 'dalipu-demo');
    const [a,b] = installed, context = service.project(a.projectId), original = context.adapter.collect.bind(context.adapter);
    const rule = { documentType: 'qualityCertificate', conditions: { customer: '演示客户甲' }, priority: 10 };
    const reset = async () => {
      await service.setTemplateMatchRule(a.projectId, a.templateId, 1, rule);
      await service.setTemplateMatchRule(b.projectId, b.templateId, 1, { ...rule, conditions: {}, priority: 1 });
    };
    let calls = 0;
    context.adapter.collect = async request => {
      calls++;
      await service.setTemplateMatchRule(a.projectId, a.templateId, 1, { ...rule, conditions: { customer: '已变更' } });
      await service.setTemplateMatchRule(b.projectId, b.templateId, 1, { ...rule, priority: 20 });
      return original(request);
    };
    await reset();
    const first = await service.generate(a.projectId, { ...context.request, mode: 'preview', autoMatch: true, idempotencyKey: 'before-edit' });
    assert.equal(first.snapshot.templateRef.packageId, a.templateId);
    assert.deepEqual(first.snapshot.templateMatch.rule, { conditions: rule.conditions, priority: 10 });
    assert.equal(calls, 1);
    const second = await service.generate(a.projectId, { ...context.request, mode: 'preview', autoMatch: true, idempotencyKey: 'after-edit' });
    assert.equal(second.snapshot.templateRef.packageId, b.templateId);
    await reset();
    assert.equal((await service.inspectTemplateMatches(a.projectId, rule.documentType, context.request.businessKey)).winner.templateId, a.templateId);
    assert.equal((await service.inspectTemplateMatches(a.projectId, rule.documentType, context.request.businessKey)).winner.templateId, b.templateId);
    await reset();
    let published = false;
    context.adapter.collect = async request => {
      if (!published) {
        published = true;
        const version = await service.publishTemplate(a.projectId, a.templateId);
        assert.equal(version.version, 2);
        await service.setTemplateMatchRule(a.projectId, a.templateId, 2, rule);
      }
      return original(request);
    };
    const beforePublication = await service.generate(a.projectId, { ...context.request, mode: 'preview', autoMatch: true, idempotencyKey: 'before-publication' });
    assert.equal(beforePublication.snapshot.templateRef.revision, 1);
    const afterPublication = await service.generate(a.projectId, { ...context.request, mode: 'preview', autoMatch: true, idempotencyKey: 'after-publication' });
    assert.equal(afterPublication.snapshot.templateRef.revision, 2);
    await reset();
    context.adapter.collect = async request => { await service.templates.setDisabled(a.projectId, a.templateId, true); return original(request); };
    await assert.rejects(service.generate(a.projectId, { ...context.request, mode: 'preview', autoMatch: true, idempotencyKey: 'disabled-in-flight' }),
      error => error.code === 'DATA_NOT_FOUND');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T32.5/T33.2: both projects preserve and compare customer match facts, rules, signoff actor and bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-match-history-'));
  try {
    const { service, snapshots } = await createLocalReportingRuntime(directory);
    const installed = await installExampleTemplates(service);
    for (const projectId of ['dalipu-demo', 'general-mes-demo']) {
      const [a,b] = installed.filter(item => item.projectId === projectId), context = service.project(projectId);
      const original = context.adapter.collect.bind(context.adapter);
      let customer = '客户 A', calls = 0;
      context.adapter.collect = async request => {
        calls++; const data = await original(request);
        data.datasets.find(item => item.datasetId === 'certificate.header').records[0].values['cert.customer'] = customer;
        return data;
      };
      for (const [template, value] of [[a, '客户 A'], [b, '客户 B']])
        await service.setTemplateMatchRule(projectId, template.templateId, template.version,
          { documentType: context.request.documentType, conditions: { customer: value }, priority: 10 });
      const generate = key => service.generate(projectId, { ...context.request, mode: 'preview', autoMatch: true, idempotencyKey: key });
      const first = await generate('customer-a'), firstId = first.snapshot.generationId;
      const bytes = await snapshots.readFile(projectId, firstId);
      customer = '客户 B';
      const second = await generate('customer-b');
      assert.equal(first.snapshot.templateRef.packageId, a.templateId);
      assert.equal(second.snapshot.templateRef.packageId, b.templateId);
      assert.equal(calls, 2);
      await service.setTemplateMatchRule(projectId, a.templateId, a.version,
        { documentType: context.request.documentType, conditions: { customer: '已修改规则' }, priority: 100 });
      context.adapter.collect = async () => { throw new Error('issued previews and reprints must not collect again'); };
      const issued = await service.issueGeneration(projectId, firstId, 'employee:test-32');
      const matchExpectation = { generationId: firstId, templateMatch: structuredClone(first.snapshot.templateMatch),
        signoff: { actorId: 'employee:test-32' } };
      const traceComparison = compareGenerationOutput('t33-trace-' + projectId, matchExpectation, projectId,
        context.request.businessKey, issued.snapshot, bytes, await loadExcel(bytes), sha256(bytes), { signoff: issued.signoff });
      assert.equal(traceComparison.passed, true, JSON.stringify(traceComparison.issues));
      const wrongTrace = structuredClone(matchExpectation);
      wrongTrace.templateMatch.rule.priority++;
      wrongTrace.templateMatch.facts.customer.recordCount++;
      wrongTrace.signoff.actorId = 'spoofed-client';
      const wrongTraceResult = compareGenerationOutput('t33-wrong-trace-' + projectId, wrongTrace, projectId,
        context.request.businessKey, issued.snapshot, bytes, await loadExcel(bytes), sha256(bytes), { signoff: issued.signoff });
      assert.deepEqual(new Set(wrongTraceResult.issues.map(issue => issue.code)),
        new Set(['MATCH_PRIORITY_MISMATCH', 'MATCH_FACT_MISMATCH', 'SIGNOFF_ACTOR_MISMATCH']));
      const reprint = await service.reprint(projectId, firstId);
      assert.equal(reprint.snapshot.templateMatch.facts.customer.value, '客户 A');
      assert.equal(reprint.snapshot.templateMatch.facts.customer.recordCount, 1);
      assert.equal(reprint.snapshot.templateMatch.rule.conditions.customer, '客户 A');
      assert.equal(reprint.snapshot.templateMatch.rule.priority, 10);
      assert.deepEqual(await snapshots.readFile(projectId, firstId), bytes);
      const history = await service.listGenerations(projectId, { page: 1, pageSize: 10 });
      assert.equal(history.items.find(item => item.generationId === firstId).templateMatch.facts.customer.value, '客户 A');
      const legacy = structuredClone(first); legacy.snapshot.generationId = 'gen-legacy-t32';
      legacy.idempotencyKey = 'legacy-t32'; delete legacy.snapshot.templateMatch;
      await snapshots.commit(legacy, bytes);
      assert.equal((await service.reprint(projectId, 'gen-legacy-t32')).snapshot.templateMatch, undefined);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T18: declarative read-only project registration uses the existing HTTP adapter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-register-'));
  const source = createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(body.businessKey, dalipuSingle.businessKey);
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(dalipuSingle));
  });
  try {
    source.listen(0, '127.0.0.1'); await once(source, 'listening');
    const project = createDalipuDemoProject();
    const adapter = createExampleAdapterDefinition(project);
    const base = createQualityDataViews();
    const file = join(directory, 'projects.json');
    await writeFile(file, JSON.stringify([{ project, adapter, views: [...base, ...createPrintViews(base)],
      source: { endpoint: `http://127.0.0.1:${source.address().port}/collect` } }]));
    // Registration itself has no project-name branch; the source mapping is declarative.
    const registrations = await loadProjectRegistrations(file);
    assert.equal(registrations.size, 1);
    const context = registrations.get(project.projectId);
    assert.ok(context);
    const bundle = await context.adapter.collect({ documentType: 'qualityCertificate', businessKey: dalipuSingle.businessKey });
    assert.equal(bundle.projectId, project.projectId);
    assert.ok(bundle.datasets.some(dataset => dataset.datasetId === 'material.lines'));
  } finally { source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('T18: a source with no hardness records produces a single main page and no conditional appendix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-single-'));
  try {
    const { service } = await createLocalReportingRuntime(directory);
    const context = service.project('dalipu-demo');
    const source = structuredClone(dalipuSingle);
    source.datasets.find(dataset => dataset.datasetId === 'hardness_points').records = [];
    context.adapter = new InMemoryProjectAdapter(context.project,
      toRuntimeAdapterConfig(createExampleAdapterDefinition(context.project)), [source]);
    const template = (await installExampleTemplates(service)).find(item => item.templateId === 'dalipu-certificate-v1');
    const result = await service.generate('dalipu-demo', { mode: 'preview', documentType: 'qualityCertificate',
      businessKey: source.businessKey, templateRef: { id: template.templateId, version: template.version },
      idempotencyKey: 'single:no-hardness' });
    assert.equal(result.snapshot.pagePlan.totalPages, 1);
    assert.equal(result.snapshot.pagePlan.pages[0].pageType, 'main');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T18: a large Dalipu source keeps material/chemistry/mechanics/inspection ordered through multiple pages and hardness appendix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-bulk-'));
  try {
    const { service } = await createLocalReportingRuntime(directory);
    const context = service.project('dalipu-demo');
    context.adapter = new InMemoryProjectAdapter(context.project,
      toRuntimeAdapterConfig(createExampleAdapterDefinition(context.project)), [dalipuBulk]);
    const installed = await installExampleTemplates(service);
    const template = installed.find(item => item.templateId === 'dalipu-certificate-v1');
    const result = await service.generate('dalipu-demo', {
      mode: 'preview', documentType: 'qualityCertificate', businessKey: dalipuBulk.businessKey,
      templateRef: { id: template.templateId, version: template.version }, idempotencyKey: 'bulk:dalipu',
    });
    const { pagePlan, viewResults } = result.snapshot;
    assert.ok(pagePlan.totalPages > 2);
    assert.ok(pagePlan.pages.some(page => page.pageType === 'appendix'));
    const sourceViews = new Map(viewResults.map(view => [view.viewId, view]));
    for (const key of ['material', 'chemistry', 'tensile', 'inspection', 'hardness']) {
      const view = sourceViews.get(`view.certificate.${key}-print`);
      assert.ok(view.records.length > 0, key);
      const allocated = pagePlan.pages.flatMap(page => page.allocations.filter(part => part.viewId === view.viewId).flatMap(part => part.recordIds));
      assert.deepEqual(allocated, view.records.map(record => record.recordId), key);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
