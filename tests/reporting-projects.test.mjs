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
