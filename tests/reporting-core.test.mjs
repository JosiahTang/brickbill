import test from 'node:test';
import assert from 'node:assert/strict';
import dalipuSource from './fixtures/reporting/dalipu/source.json' with { type: 'json' };
import dalipuMultipageSource from './fixtures/reporting/dalipu/multipage.json' with { type: 'json' };
import { createDemoDocument } from '../src/domain/demo.ts';
import { migrateV02Template } from '../src/core/contracts/migrate.ts';
import { validateContract, validateProjectSemantics } from '../src/core/contracts/validate.ts';
import { addControlledField } from '../src/core/catalog/catalog.ts';
import { DataViewEngine } from '../src/core/views/engine.ts';
import { createReportingDemoContext } from '../src/core/adapters/demo-context.ts';
import { createDalipuDemoProject, createExampleAdapterDefinition, toRuntimeAdapterConfig } from '../src/core/adapters/example-projects.ts';
import { InMemoryProjectAdapter, encodeCompositeKey } from '../src/core/adapters/project-adapter.ts';

test('v0.2 migration retains cell layout and stores workbook bytes once at package level', () => {
  const legacy = createDemoDocument();
  legacy.excelSource = { fileName: 'quality.xlsx', sheetName: '质保书', base64: 'UEsDBA==', warnings: [] };

  const migrated = migrateV02Template({ document: legacy }, { projectId: 'dalipu-demo' });
  assert.equal(migrated.worksheets.length, 1);
  assert.equal(migrated.worksheets[0].bindingMode, 'legacy-path');
  assert.deepEqual(migrated.worksheets[0].document.cells, legacy.cells);
  assert.deepEqual(migrated.worksheets[0].document.merges, legacy.merges);
  assert.equal(migrated.sourceWorkbook.base64, 'UEsDBA==');
  assert.equal(migrated.worksheets[0].document.excelSource.base64, '');
  assert.throws(() => migrateV02Template({ ...legacy, schemaVersion: 3 }, { projectId: 'dalipu-demo' }),
    error => error.code === 'CONTRACT_VERSION_UNSUPPORTED');
});

test('versioned project contracts reject unsupported versions and unresolved relationship keys', () => {
  const { project } = createReportingDemoContext().dalipu;
  assert.throws(() => validateContract('project', { ...project, contractVersion: 3 }),
    error => error.code === 'CONTRACT_INVALID');
  const invalidProject = structuredClone(project);
  invalidProject.relationships[0].childForeignKey = ['contract.missingKey'];
  assert.throws(() => validateProjectSemantics(invalidProject), error => error.code === 'CONTRACT_INVALID');
});

test('Dalipu and generic MES map to equivalent multipurpose views without flattening detail sets', async () => {
  const demos = createReportingDemoContext();
  const allBundles = [];
  for (const context of [demos.dalipu, demos.generalMes]) {
    const bundle = await context.adapter.collect(context.request);
    allBundles.push(bundle);
    const bundleBeforeViews = structuredClone(bundle);
    const engine = new DataViewEngine({ project: context.project, catalog: context.catalog.fields,
      views: context.views, functions: context.functions });
    const header = engine.execute('view.certificate-header', bundle);
    const first = header.records[0];

    assert.equal(header.outputRecordCount, 1);
    assert.ok(first.sourceRecordIds.length > 0);
    assert.equal(first.values['contract.standard'], context === demos.dalipu ? 'API 5CT' : 'EN 10216-2');
    assert.equal(first.children.materials.length, 2);
    assert.equal(first.children.chemistry.length, 3);
    assert.equal(first.children.tensile.length, 3);
    assert.equal(first.children.hardness.length, 2);
    assert.equal(first.children.inspections.length, context === demos.dalipu ? 3 : 2);
    assert.ok(first.children.chemistry.every(row => row.sourceRecordIds.length > 0));

    const hardness = engine.execute('view.hardness-by-sample', bundle);
    assert.equal(hardness.outputRecordCount, 2);
    const expectedAverage = context === demos.dalipu ? 19.2 : 19.95;
    assert.ok(Math.abs(hardness.records[0].values['hardness.q1.out.average'] - expectedAverage) < 0.0001);
    assert.deepEqual(bundle, bundleBeforeViews);

    const hardnessInputs = bundle.datasets.find(item => item.datasetId === 'quality.hardness-results').records;
    assert.throws(() => context.functions.resolve('hardness-by-sample', '9.9.9'),
      error => error.code === 'RULE_VERSION_NOT_FOUND');
    assert.throws(() => context.functions.execute('hardness-by-sample', '1.0.0',
      [...hardnessInputs, { ...structuredClone(hardnessInputs[0]), recordId: 'duplicate-source-row' }],
      { approvedOnly: true }), error => error.code === 'VALUE_TYPE_ERROR');
  }
  assert.notEqual(allBundles[0].projectId, allBundles[1].projectId);
  assert.equal(allBundles[0].datasets.find(item => item.datasetId === 'material.lines').records.length, 2);
  assert.equal(allBundles[0].datasets.find(item => item.datasetId === 'quality.chemistry-results').records.length, 3);
});

test('the large synthetic certificate keeps unequal detail collections available for page planning', async () => {
  const context = createReportingDemoContext().dalipu;
  const adapter = new InMemoryProjectAdapter(context.project,
    toRuntimeAdapterConfig(createExampleAdapterDefinition(context.project)), [dalipuMultipageSource]);
  const bundle = await adapter.collect({ documentType: 'qualityCertificate',
    businessKey: { printNo: 'DEMO-CERT-BULK-001', productPart: 'T' } });
  const engine = new DataViewEngine({ project: context.project, catalog: context.catalog.fields,
    views: context.views, functions: context.functions });
  const result = engine.execute('view.certificate-header', bundle).records[0];

  assert.equal(result.children.materials.length, 42);
  assert.equal(result.children.chemistry.length, 84);
  assert.equal(result.children.tensile.length, 42);
  assert.equal(result.children.hardness.length, 24);
  assert.equal(result.children.inspections.length, 21);
  assert.ok(result.children.hardness.every(sample => sample.sourceRecordIds.length >= 1));
});

test('field catalog accepts controlled additions and rejects duplicate business keys from a source', async () => {
  const demos = createReportingDemoContext();
  const context = demos.dalipu;
  const catalog = addControlledField(context.catalog, {
    fieldId: 'certificate.watermark', label: '质保书水印', type: 'text', nullable: false, grain: 'certificate',
    source: { kind: 'constant', value: 'QUALITY COPY' },
  });
  assert.equal(catalog.fields.at(-1).fieldId, 'certificate.watermark');
  assert.throws(() => addControlledField(catalog, catalog.fields[0]), error => error.code === 'CONTRACT_INVALID');

  const invalid = structuredClone(dalipuSource);
  const materialRows = invalid.datasets.find(dataset => dataset.datasetId === 'material_lines').records;
  materialRows.push(structuredClone(materialRows[0]));
  const project = createDalipuDemoProject();
  const adapter = new InMemoryProjectAdapter(project,
    toRuntimeAdapterConfig(createExampleAdapterDefinition(project)), [invalid]);
  await assert.rejects(adapter.collect(context.request), error => error.code === 'DUPLICATE_KEY');
});

test('composite key encoding distinguishes values containing separators', () => {
  assert.notEqual(encodeCompositeKey(['a|b', 'c']), encodeCompositeKey(['a', 'b|c']));
});
