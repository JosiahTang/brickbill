import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createPinia, setActivePinia } from 'pinia';
import ExcelJS from 'exceljs';
import { createLocalReportingRuntime } from '../server/runtime.ts';
import { createReportingHttpServer } from '../server/http/app.ts';
import { installExampleTemplates } from '../examples/projects/install.ts';
import { buildExampleTemplate } from '../examples/projects/quality-templates.ts';
import { dalipuTemplates } from '../examples/projects/dalipu/index.ts';
import { generalMesTemplates } from '../examples/projects/general-mes/index.ts';
import { stepScope, parseScalar } from '../src/core/designer/configuration.ts';
import { createReportingDemoContext } from '../src/core/adapters/demo-context.ts';
import { useDesignerStore } from '../src/stores/designer.ts';
import { exportTemplatePackage } from '../src/export/excel.ts';
import { importTemplatePackage } from '../src/export/importExcel.ts';

const seal = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=';
const view = (viewId, sourceDatasetId, steps, outputFields) => ({ contractVersion: 2, viewId, label: viewId, version: '0.1.0', sourceDatasetId, steps, outputFields });

test('T29 field choices follow transformed datasets and preserve numeric/boolean parameter types', () => {
  const context = createReportingDemoContext().dalipu;
  const metadata = { project: context.project, catalog: context.catalog, views: context.views, functions: context.functions.list() };
  const result = stepScope(metadata, 'material.lines', [
    { op: 'project', fields: [{ sourceFieldId: 'material.pieces', outputFieldId: 'qa.pieces' }] },
    { op: 'group', by: [], aggregations: [{ operation: 'sum', fieldId: 'qa.pieces', outputFieldId: 'qa.total' }] },
  ]);
  assert.deepEqual(result.fields.map(field => field.fieldId), ['qa.total']);
  assert.equal(result.fields[0].type, 'number');
  const fn = metadata.functions[0];
  const functionScope = stepScope(metadata, 'quality.hardness-results', [{ op: 'applyFunction', functionId: fn.functionId, version: fn.version, parameters: { approvedOnly: true } }]);
  assert.equal(functionScope.datasetId, 'quality.hardness-by-sample');
  assert.equal(functionScope.fields.find(field => field.fieldId === 'hardness.q1.out.average').type, 'number');
  assert.equal(parseScalar('false', 'boolean'), false);
  assert.equal(parseScalar('19.5', 'number'), 19.5);
  assert.throws(() => parseScalar('', 'number'));
  assert.throws(() => parseScalar('2026-02-30', 'date'));
});

test('T29 authenticated draft trial uses unsaved rules, caps rows/children, plans unsaved pages and leaves published state untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t29-'));
  const runtime = await createLocalReportingRuntime(directory);
  const server = createReportingHttpServer(runtime.service, request => ({ projectIds: request.headers.authorization === 'Bearer mes' ? ['general-mes-demo'] : ['dalipu-demo'] }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const post = (projectId, body) => fetch(`${origin}/projects/${projectId}/views/preview`, { method: 'POST', headers: { authorization: projectId === 'general-mes-demo' ? 'Bearer mes' : 'Bearer dalipu', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const projectId of ['dalipu-demo', 'general-mes-demo']) {
      const token = projectId === 'general-mes-demo' ? 'mes' : 'dalipu';
      const metadataResponse = await fetch(`${origin}/projects/${projectId}/designer-metadata`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(metadataResponse.status, 200);
      const metadata = await metadataResponse.json();
      assert.equal(metadata.project.projectId, projectId); assert.ok(metadata.project.datasets.length >= 8); assert.equal(metadata.functions[0].functionId, 'hardness-by-sample');
      const context = runtime.service.project(projectId), originalViews = await runtime.service.listViews(projectId);
      const original = originalViews.find(item => item.viewId === 'view.material.lines');
      const changed = structuredClone(original); changed.version = '9.9.9';
      changed.steps.unshift({ op: 'filter', fieldId: 'material.pieces', operator: 'gt', value: projectId === 'dalipu-demo' ? 5 : 3 });
      const definitions = [changed,
        view('qa.group', 'material.lines', [{ op: 'group', by: [], aggregations: [{ operation: 'sum', fieldId: 'material.pieces', outputFieldId: 'qa.total' }] }], ['qa.total']),
        view('qa.pivot', 'material.lines', [{ op: 'pivot', by: [], columnFieldId: 'material.heatNo', valueFieldId: 'material.pieces', columns: {
          h1: { value: projectId === 'dalipu-demo' ? '2512865' : 'G25101', outputFieldId: 'qa.heat' },
          h2: { value: projectId === 'dalipu-demo' ? '2512867' : 'G25102', outputFieldId: 'qa.heat2' },
        }, duplicatePolicy: 'sum' }], ['qa.heat','qa.heat2']),
        view('qa.lookup', 'certificate.header', [{ op: 'lookup', relationshipId: 'header-contract', fields: [{ childFieldId: 'contract.orderNo', outputFieldId: 'qa.contract' }] }], ['qa.contract']),
        view('qa.children', 'certificate.header', [], ['cert.printNo','cert.partFlag']),
      ];
      const relation = metadata.project.relationships.find(item => item.relationshipId === 'header-materials');
      definitions.at(-1).children = [{ relationshipId: relation.relationshipId, viewId: 'view.material.lines', as: 'materials', parentFieldIds: relation.parentKey, childFieldIds: relation.childForeignKey }];
      const response = await post(projectId, { ...context.request, definitions, limit: 1 });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      const actual = result.views.find(item => item.viewId === changed.viewId);
      assert.equal(result.mode, 'draft'); assert.equal(actual.viewVersion, '9.9.9');
      assert.equal(actual.outputRecordCount, 1); assert.ok(actual.records[0].sourceRecordIds.length);
      assert.equal(result.views.find(item => item.viewId === 'qa.group').records[0].values['qa.total'], projectId === 'dalipu-demo' ? 11 : 7);
      assert.equal(result.views.find(item => item.viewId === 'qa.pivot').records[0].values['qa.heat'], projectId === 'dalipu-demo' ? 5 : 3);
      assert.ok(result.views.find(item => item.viewId === 'qa.lookup').records[0].values['qa.contract']);
      assert.equal(result.views.find(item => item.viewId === 'qa.children').records[0].children.materials.length, 1);
      assert.deepEqual(await runtime.service.listViews(projectId), originalViews);
      assert.equal((await runtime.snapshots.list(projectId)).length, 0);
      assert.equal(await runtime.views.getDraft(projectId, changed.viewId), undefined);

      const spec = (projectId === 'dalipu-demo' ? dalipuTemplates : generalMesTemplates)[0];
      const template = await buildExampleTemplate(spec);
      const trial = await post(projectId, { ...context.request, definitions: [], template, limit: 1 });
      assert.equal(trial.status, 200, await trial.clone().text());
      const pagePlan = (await trial.json()).pagePlan;
      assert.ok(pagePlan.totalPages >= 2); assert.equal(pagePlan.pages.at(-1).pageType, 'appendix');
      template.pageDefinitions[0].regions.find(item => item.kind === 'detail').capacityRows = 999;
      const invalidPage = await post(projectId, { ...context.request, definitions: [], template });
      assert.equal(invalidPage.status, 422); assert.ok((await invalidPage.json()).error.context.regionId);
      const bad = structuredClone(changed); bad.steps[0].fieldId = 'unknown.field';
      const badResult = await post(projectId, { ...context.request, definitions: [bad] });
      assert.equal(badResult.status, 422); const issue = (await badResult.json()).error;
      assert.equal(issue.context.viewId, changed.viewId); assert.equal(issue.context.stepIndex, 0);
      assert.equal((await post(projectId, { ...context.request, limit: 201 })).status, 400);
      assert.equal((await post(projectId, { ...context.request, template: { projectId } })).status, 400);
      assert.equal((await post(projectId, { ...context.request, definitions: [changed, changed] })).status, 409);
      const unknownFunction = view('qa.bad-function', 'quality.hardness-results', [{ op: 'applyFunction', functionId: 'unknown.function', version: '1.0.0', parameters: {} }], ['hardness.value']);
      const unknownResult = await post(projectId, { ...context.request, definitions: [unknownFunction] });
      assert.equal(unknownResult.status, 422); const functionIssue = (await unknownResult.json()).error;
      assert.equal(functionIssue.context.viewId, 'qa.bad-function'); assert.equal(functionIssue.context.stepIndex, 0);
    }
    assert.equal((await fetch(`${origin}/projects/general-mes-demo/designer-metadata`)).status, 403);
    const context = runtime.service.project('dalipu-demo');
    const bulk = await runtime.service.previewViews('dalipu-demo', { ...context.request, businessKey: { printNo: 'DEMO-CERT-BULK-001', productPart: 'T' }, viewIds: ['view.material.lines'], limit: 1, offset: 1 });
    assert.equal(bulk.views[0].records.length, 1); assert.equal(bulk.views[0].outputRecordCount, 42); assert.equal(bulk.views[0].truncated, true);
  } finally { server.close(); await once(server, 'close'); await rm(directory, { recursive: true, force: true }); }
});

test('T29 resources and positioning survive save/reopen and use the existing preview/export pipeline in both projects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t29-images-'));
  try {
    const { service, snapshots, resources } = await createLocalReportingRuntime(directory);
    await installExampleTemplates(service);
    for (const spec of [dalipuTemplates[0], generalMesTemplates[0]]) {
      setActivePinia(createPinia()); const store = useDesignerStore();
      const template = await buildExampleTemplate(spec); template.projectId = 'unassigned'; store.loadTemplatePackage(template);
      store.associateProject(spec.projectId, '1.0.0'); assert.equal(store.templatePackage.projectId, spec.projectId);
      assert.throws(() => store.associateProject(spec.projectId === 'dalipu-demo' ? 'general-mes-demo' : 'dalipu-demo', '1.0.0'), /其他项目/);
      store.saveResources([{ resourceId: 'qa.seal', mediaType: 'image/png', base64: seal }]);
      const main = JSON.parse(JSON.stringify(store.templatePackage.pageDefinitions[0]));
      main.imagePlacements = [{ imageId: 'qa.seal.position', resourceId: 'qa.seal', worksheetId: main.worksheetIds[0], rect: { r: 0, c: 14, rows: 2, cols: 2 }, repeatOn: 'first' }];
      store.savePageDefinition(main); assert.throws(() => store.saveResources([]), /仍被页面引用/);
      const saved = store.packageSnapshot();
      const reopened = await importTemplatePackage(await exportTemplatePackage(saved), 'configured.xlsx');
      assert.deepEqual(reopened.resources, saved.resources); assert.deepEqual(reopened.pageDefinitions, saved.pageDefinitions);
      const existingDraft = await service.templates.getDraft(spec.projectId, spec.templateId);
      await service.saveTemplateDraft(spec.projectId, spec.templateId, reopened, existingDraft.revision);
      const published = await service.publishTemplate(spec.projectId, spec.templateId);
      const record = await service.generate(spec.projectId, { ...service.project(spec.projectId).request, mode: 'preview', templateRef: { id: spec.templateId, version: published.version }, idempotencyKey: `qa-t29:${spec.projectId}` });
      assert.equal((await resources.get(spec.projectId, 'qa.seal')).base64, seal);
      assert.equal(record.projection.pages[0].imagePlacements[0].rect.c, 14);
      assert.equal(record.projection.pages.slice(1).flatMap(page => page.imagePlacements).length, 0);
      const bytes = await snapshots.readFile(spec.projectId, record.snapshot.generationId);
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
      assert.equal(workbook.worksheets[0].getImages().length, 1);
      assert.equal(workbook.worksheets[0].getImages()[0].range.tl.nativeCol, 14);
      assert.equal(workbook.worksheets.slice(1).flatMap(sheet => sheet.getImages()).length, 0);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
