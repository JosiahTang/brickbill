import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import dalipuSample from './fixtures/reporting/dalipu/source.json' with { type: 'json' };
import dalipuBulk from './fixtures/reporting/dalipu/multipage.json' with { type: 'json' };
import generalMesSample from './fixtures/reporting/general-mes/source.json' with { type: 'json' };
import { createLocalReportingRuntime } from '../server/runtime.ts';
import { installExampleTemplates } from '../examples/projects/install.ts';
import { InMemoryProjectAdapter } from '../src/core/adapters/project-adapter.ts';
import { createExampleAdapterDefinition, toRuntimeAdapterConfig } from '../src/core/adapters/example-projects.ts';
import { loadExcel } from '../src/export/importExcel.ts';
import { compareGenerationOutput } from '../src/core/reporting/output-comparison.ts';
import { sha256, LocalSnapshotRepository } from '../server/repositories/local.ts';
import { imageWorkbook } from './fixtures/image-workbook.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'scripts/project-onboarding.mjs');
const execFileAsync = promisify(execFile);

async function runCli(args, sourceToken = 'synthetic-test-token', cwd = root) {
  const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MES_SOURCE_TOKEN: sourceToken },
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function writeAcceptanceFixture(directory, acceptanceVersion, projectId, sourceKind, values, suffix) {
  const evidence = [];
  for (const [kind, value] of Object.entries(values)) {
    const evidenceFile = `${suffix}-${kind}.json`;
    const evidencePath = join(directory, evidenceFile);
    await writeFile(evidencePath, JSON.stringify(value));
    evidence.push({ kind, path: evidenceFile,
      sha256: createHash('sha256').update(await readFile(evidencePath)).digest('hex') });
  }
  const manifestFile = join(directory, `${suffix}.json`);
  const reportFile = join(directory, `${suffix}-report.json`);
  await writeFile(manifestFile, JSON.stringify({ acceptanceVersion, acceptanceId: suffix, projectId, sourceKind, evidence }));
  return { manifestFile, reportFile, manifest: JSON.parse(await readFile(manifestFile, 'utf8')) };
}

test('T44.5: actual comparison CLI persists v2 image results and v1 remains uncredited for content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-image-cli-'));
  try {
    const bytes = await imageWorkbook(), workbook = await loadExcel(bytes), dataDirectory = join(directory, 'data');
    const snapshots = new LocalSnapshotRepository(dataDirectory), digest = sha256(workbook.getImage(0).buffer);
    const snapshot = { generationId: 'image.cli', projectId: 'image.project', businessKey: {},
      templateRef: { packageId: 'images', revision: 1 }, data: { documentType: 'certificate' },
      output: { sha256: sha256(bytes), byteLength: bytes.byteLength }, pagePlan: { totalPages: 0, pages: [] }, viewResults: [] };
    await snapshots.commit({ snapshot, projection: {}, mode: 'preview', createdAt: new Date().toISOString(), idempotencyKey: 'images', requestHash: 'images' }, bytes);
    const suite = { suiteVersion: 2, suiteId: 'images', projectId: snapshot.projectId, baseline: { sourceKind: 'synthetic', referenceId: 'T44-generated-fixture' },
      cases: [{ caseId: 'images', documentType: 'certificate', businessKey: {}, assertions: [], generation: { generationId: snapshot.generationId,
        xlsx: { images: [{ sheet: workbook.worksheets[0].name, count: 2, contentSha256: [digest, digest] }] } } }] };
    const file = join(directory, 'suite.json'), reportFile = join(directory, 'report.json');
    const args = ['compare', '--mode', 'snapshot', '--data-dir', dataDirectory, '--suite', file, '--output', reportFile];
    await writeFile(file, JSON.stringify(suite)); await runCli(args, '');
    let report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(report.status, 'passed'); assert.equal(report.suiteVersion, 2);
    assert.deepEqual(report.imageContentChecks, { requested: 2, checked: 2, passed: 2 });
    suite.cases[0].generation.xlsx.images[0].contentSha256[1] = '0'.repeat(64);
    await writeFile(file, JSON.stringify(suite));
    await assert.rejects(() => runCli(args, ''), error => error.code === 1);
    report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.imageContentChecks, { requested: 2, checked: 2, passed: 1 });
    assert.equal(report.cases[0].comparison.issues[0].code, 'IMAGE_CONTENT_MISMATCH');
    suite.suiteVersion = 1; delete suite.cases[0].generation.xlsx.images[0].contentSha256;
    await writeFile(file, JSON.stringify(suite)); await runCli(args, '');
    report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(report.suiteVersion, 1);
    assert.deepEqual(report.imageContentChecks, { requested: 0, checked: 0, passed: 0 });
    assert.deepEqual(await snapshots.readFile(snapshot.projectId, snapshot.generationId), bytes);
    // v2 content assertions cannot be accepted by a data-only comparison mode.
    suite.suiteVersion = 2; suite.cases[0].generation.xlsx.images[0].contentSha256 = [digest, digest];
    await writeFile(file, JSON.stringify(suite));
    await assert.rejects(() => runCli(['compare', '--mode', 'offline', '--config', file, '--suite', file, '--output', reportFile], ''), error => error.code === 1);
    report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(report.status, 'failed'); assert.equal(report.error.code, 'CONTRACT_INVALID');
    assert.equal(report.imageContentChecks.checked, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T25/T26: project setup, validation, probing and offline/online business comparison', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-project-onboarding-'));
  const source = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    source.lastRequest = {
      method: request.method,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(dalipuSample));
  });
  try {
    const configFile = join(directory, 'projects.json');
    const requestFile = join(directory, 'request.json');
    const reportFile = join(directory, 'project-probe.json');
    const genericConfigFile = join(directory, 'general-mes-projects.json');
    await runCli(['init', '--example', 'general-mes', '--output', genericConfigFile]);
    const genericValidation = JSON.parse(await runCli(['validate', '--config', genericConfigFile,
      '--sample', resolve(root, 'tests/fixtures/reporting/general-mes/source.json')], ''));
    assert.equal(genericValidation.valid, true);
    assert.equal(genericValidation.projects[0].projectId, generalMesSample.projectId);
    assert.ok(genericValidation.sample.viewRecordCounts.find(item => item.viewId === 'view.certificate-header').recordCount > 0);
    const genericCompareFile = join(directory, 'general-mes-comparison.json');
    const genericCompare = JSON.parse(await runCli(['compare', '--mode', 'offline', '--config', genericConfigFile,
      '--suite', resolve(root, 'tests/fixtures/project-comparison/general-mes-synthetic.json'), '--output', genericCompareFile], ''));
    assert.equal(genericCompare.status, 'passed');
    assert.equal(genericCompare.passedCount, 1);

    await runCli(['init', '--example', 'dalipu', '--output', configFile]);
    const registrations = JSON.parse(await readFile(configFile, 'utf8'));
    await assert.rejects(runCli(['init', '--example', 'dalipu', '--output', configFile]), error => error.message.includes('EEXIST'));
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), registrations);
    source.listen(0, '127.0.0.1');
    await once(source, 'listening');
    registrations[0].source.endpoint = `http://127.0.0.1:${source.address().port}/api/collect`;
    await writeFile(configFile, JSON.stringify(registrations, null, 2));

    const validation = JSON.parse(await runCli(['validate', '--config', configFile,
      '--sample', resolve(root, 'tests/fixtures/reporting/dalipu/source.json')], ''));
    assert.equal(validation.valid, true);
    assert.equal(validation.projects[0].projectId, dalipuSample.projectId);
    assert.ok(validation.sample.datasetRecordCounts.find(item => item.datasetId === 'material.lines').recordCount > 0);
    assert.ok(validation.sample.viewRecordCounts.find(item => item.viewId === 'view.certificate-header').recordCount > 0);
    const comparisonFile = join(directory, 'dalipu-comparison.json');
    const comparison = JSON.parse(await runCli(['compare', '--mode', 'offline', '--config', configFile,
      '--suite', resolve(root, 'tests/fixtures/project-comparison/dalipu-synthetic.json'), '--output', comparisonFile], ''));
    assert.equal(comparison.status, 'passed');
    assert.equal(comparison.passedCount, 1);
    const comparisonReport = JSON.parse(await readFile(comparisonFile, 'utf8'));
    const repeatComparisonFile = join(directory, 'dalipu-repeat-comparison.json');
    await runCli(['compare', '--mode', 'offline', '--config', configFile,
      '--suite', resolve(root, 'tests/fixtures/project-comparison/dalipu-synthetic.json'), '--output', repeatComparisonFile], '');
    const repeatedComparisonReport = JSON.parse(await readFile(repeatComparisonFile, 'utf8'));
    assert.deepEqual(repeatedComparisonReport.cases[0].comparison, comparisonReport.cases[0].comparison);
    const onlineCompareFile = join(directory, 'dalipu-online-comparison.json');
    const onlineComparison = JSON.parse(await runCli(['compare', '--mode', 'online', '--config', configFile,
      '--suite', resolve(root, 'tests/fixtures/project-comparison/dalipu-synthetic.json'), '--output', onlineCompareFile]));
    assert.equal(onlineComparison.status, 'passed');
    assert.equal(JSON.parse(await readFile(onlineCompareFile, 'utf8')).mode, 'online');
    const tolerantSuite = JSON.parse(await readFile(resolve(root, 'tests/fixtures/project-comparison/dalipu-synthetic.json'), 'utf8'));
    tolerantSuite.cases[0].sourceSnapshot = resolve(root, 'tests/fixtures/reporting/dalipu/source.json');
    const materialAssertion = tolerantSuite.cases[0].assertions.find(assertion => assertion.targetId === 'material.lines');
    materialAssertion.records[0].values['material.length'] = 58.3805;
    materialAssertion.numericTolerance = 0.001;
    const tolerantSuiteFile = join(directory, 'tolerant-suite.json');
    await writeFile(tolerantSuiteFile, JSON.stringify(tolerantSuite));
    const tolerantReport = JSON.parse(await runCli(['compare', '--mode', 'offline', '--config', configFile,
      '--suite', tolerantSuiteFile, '--output', join(directory, 'tolerant-report.json')], ''));
    assert.equal(tolerantReport.status, 'passed');
    const wrongOrderSuite = JSON.parse(await readFile(resolve(root, 'tests/fixtures/project-comparison/dalipu-synthetic.json'), 'utf8'));
    wrongOrderSuite.cases[0].sourceSnapshot = resolve(root, 'tests/fixtures/reporting/dalipu/source.json');
    wrongOrderSuite.cases[0].assertions.find(assertion => assertion.targetId === 'material.lines').expectedOrder.reverse();
    const wrongOrderSuiteFile = join(directory, 'wrong-order-suite.json');
    const wrongOrderReportFile = join(directory, 'wrong-order-report.json');
    await writeFile(wrongOrderSuiteFile, JSON.stringify(wrongOrderSuite));
    await assert.rejects(runCli(['compare', '--mode', 'offline', '--config', configFile,
      '--suite', wrongOrderSuiteFile, '--output', wrongOrderReportFile], ''), error => error.code === 1);
    const wrongOrderReport = JSON.parse(await readFile(wrongOrderReportFile, 'utf8'));
    assert.ok(wrongOrderReport.cases[0].comparison.issues.some(issue =>
      issue.code === 'ORDER_MISMATCH' && issue.targetId === 'material.lines'));
    const extraSnapshot = structuredClone(dalipuSample);
    const extraMaterial = extraSnapshot.datasets.find(dataset => dataset.datasetId === 'material_lines').records[1];
    extraSnapshot.datasets.find(dataset => dataset.datasetId === 'material_lines').records.push({
      ...extraMaterial, lineId: 'LINE-03', HEAT_NO: '2512868', SAMPLE_LOT_NO: '25706101', MAT_NUM: 9,
      TOTAL_LEN: 105.76, weight: 6.357,
    });
    const extraSnapshotFile = join(directory, 'extra-material-snapshot.json');
    await writeFile(extraSnapshotFile, JSON.stringify(extraSnapshot));
    const extraSuite = JSON.parse(await readFile(resolve(root, 'tests/fixtures/project-comparison/dalipu-synthetic.json'), 'utf8'));
    extraSuite.cases[0].sourceSnapshot = extraSnapshotFile;
    const extraSuiteFile = join(directory, 'extra-material-suite.json');
    const extraReportFile = join(directory, 'extra-material-report.json');
    await writeFile(extraSuiteFile, JSON.stringify(extraSuite));
    await assert.rejects(runCli(['compare', '--mode', 'offline', '--config', configFile,
      '--suite', extraSuiteFile, '--output', extraReportFile], ''), error => error.code === 1);
    const extraReport = JSON.parse(await readFile(extraReportFile, 'utf8'));
    assert.ok(extraReport.cases[0].comparison.issues.some(issue =>
      issue.code === 'UNEXPECTED_RECORD' && issue.recordKey['material.lineId'] === 'LINE-03'));
    const wrongSuite = JSON.parse(await readFile(resolve(root, 'tests/fixtures/project-comparison/dalipu-synthetic.json'), 'utf8'));
    wrongSuite.cases[0].sourceSnapshot = resolve(root, 'tests/fixtures/reporting/dalipu/source.json');
    wrongSuite.cases[0].assertions.find(assertion => assertion.targetId === 'material.lines').records[0].values['material.weight'] = 99;
    const wrongSuiteFile = join(directory, 'wrong-suite.json');
    const wrongReportFile = join(directory, 'wrong-comparison.json');
    await writeFile(wrongSuiteFile, JSON.stringify(wrongSuite));
    await assert.rejects(runCli(['compare', '--mode', 'offline', '--config', configFile,
      '--suite', wrongSuiteFile, '--output', wrongReportFile], ''), error => error.code === 1 && error.message.includes('用例失败'));
    const wrongReport = JSON.parse(await readFile(wrongReportFile, 'utf8'));
    assert.equal(wrongReport.status, 'failed');
    assert.ok(wrongReport.cases[0].comparison.issues.some(issue =>
      issue.code === 'VALUE_MISMATCH' && issue.fieldId === 'material.weight' && issue.actual === 3.531));

    await writeFile(requestFile, JSON.stringify({ documentType: dalipuSample.documentType, businessKey: dalipuSample.businessKey }));
    const probe = JSON.parse(await runCli(['probe', '--config', configFile, '--project', dalipuSample.projectId,
      '--request-file', requestFile, '--output', reportFile]));
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(probe.status, 'succeeded');
    assert.equal(report.status, 'succeeded');
    assert.equal(report.source.sourceVersion, dalipuSample.sourceVersion);
    assert.deepEqual(report.versions, { project: '1.0.0', adapter: '1.0.0', catalog: '1.0.0' });
    assert.ok(report.datasets.find(item => item.datasetId === 'material.lines').recordCount > 0);
    assert.ok(report.views.find(item => item.viewId === 'view.certificate-header').recordCount > 0);
    assert.deepEqual(source.lastRequest, {
      method: 'POST', authorization: 'Bearer synthetic-test-token',
      body: { projectId: dalipuSample.projectId, documentType: dalipuSample.documentType, businessKey: dalipuSample.businessKey },
    });
    assert.equal(JSON.stringify(report).includes(dalipuSample.businessKey.printNo), false);

    const failedReportFile = join(directory, 'failed-probe.json');
    await assert.rejects(runCli(['probe', '--config', configFile, '--project', dalipuSample.projectId,
      '--request-file', requestFile, '--output', failedReportFile], ''), error => error.message.includes('缺少令牌环境变量'));
    const failedReport = JSON.parse(await readFile(failedReportFile, 'utf8'));
    assert.equal(failedReport.status, 'failed');
    assert.equal(failedReport.error.message, '缺少令牌环境变量 MES_SOURCE_TOKEN');
    assert.equal(JSON.stringify(failedReport).includes('synthetic-test-token'), false);

    const requiredFieldId = registrations[0].project.datasets.find(dataset => dataset.datasetId === 'certificate.header')
      .fields.find(field => !field.nullable).fieldId;
    registrations[0].adapter.datasets.find(dataset => dataset.datasetId === 'certificate.header').fields =
      registrations[0].adapter.datasets.find(dataset => dataset.datasetId === 'certificate.header').fields
        .filter(field => field.fieldId !== requiredFieldId);
    await writeFile(configFile, JSON.stringify(registrations, null, 2));
    await assert.rejects(runCli(['validate', '--config', configFile]), error =>
      error.code === 1 && error.message.includes('缺少源映射'));
  } finally {
    source.closeAllConnections();
    if (source.listening) await new Promise(resolveClose => source.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

test('T27: snapshot comparison validates immutable template output, pagination and XLSX business baselines', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-output-comparison-'));
  try {
    const { service, snapshots } = await createLocalReportingRuntime(join(directory, 'data'));
    const installed = await installExampleTemplates(service);
    const dalipuTemplates = installed.filter(item => item.projectId === 'dalipu-demo');
    const generalTemplate = installed.find(item => item.templateId === 'general-mes-customer-v1');
    const dalipu = service.project('dalipu-demo');
    const singleSource = structuredClone(dalipuSample);
    singleSource.datasets.find(dataset => dataset.datasetId === 'hardness_points').records = [];
    dalipu.adapter = new InMemoryProjectAdapter(dalipu.project,
      toRuntimeAdapterConfig(createExampleAdapterDefinition(dalipu.project)), [singleSource]);
    const certificateTemplate = dalipuTemplates.find(item => item.templateId === 'dalipu-certificate-v1');
    const single = await service.generate('dalipu-demo', {
      mode: 'preview', documentType: dalipuSample.documentType, businessKey: dalipuSample.businessKey,
      templateRef: { id: certificateTemplate.templateId, version: certificateTemplate.version },
      idempotencyKey: 't27:dalipu-single',
    });
    assert.equal(single.snapshot.pagePlan.totalPages, 1);
    assert.equal(single.snapshot.pagePlan.pages[0].pageType, 'main');

    dalipu.adapter = new InMemoryProjectAdapter(dalipu.project,
      toRuntimeAdapterConfig(createExampleAdapterDefinition(dalipu.project)), [dalipuBulk]);
    const multi = await service.generate('dalipu-demo', {
      mode: 'preview', documentType: dalipuBulk.documentType, businessKey: dalipuBulk.businessKey,
      templateRef: { id: certificateTemplate.templateId, version: certificateTemplate.version },
      idempotencyKey: 't27:dalipu-multipage',
    });
    assert.ok(multi.snapshot.pagePlan.totalPages > 2);
    assert.ok(multi.snapshot.pagePlan.pages.some(page => page.pageType === 'appendix'));

    const general = service.project('general-mes-demo');
    const generalGenerated = await service.generate('general-mes-demo', {
      mode: 'preview', documentType: general.request.documentType, businessKey: general.request.businessKey,
      templateRef: { id: generalTemplate.templateId, version: generalTemplate.version },
      idempotencyKey: 't27:general-mes-customer',
    });

    const singleSuite = {
      suiteVersion: 1,
      suiteId: 't27-dalipu-output-baseline',
      projectId: 'dalipu-demo',
      cases: [{
        caseId: 'single-page-certificate', documentType: 'qualityCertificate',
        businessKey: dalipuSample.businessKey, assertions: [{
          scope: 'dataset', targetId: 'material.lines', expectedCount: 2, keyFields: ['material.lineId'],
          records: [
            { key: { 'material.lineId': 'LINE-01' }, values: { 'material.heatNo': '2512865', 'material.pieces': 5 } },
            { key: { 'material.lineId': 'LINE-02' }, values: { 'material.heatNo': '2512867', 'material.pieces': 6 } },
          ],
          expectedOrder: [{ 'material.lineId': 'LINE-01' }, { 'material.lineId': 'LINE-02' }],
        }],
        generation: {
          generationId: single.snapshot.generationId,
          templateRef: { packageId: 'dalipu-certificate-v1', revision: certificateTemplate.version },
          pageCount: 1, pageTypes: ['main'],
          pages: [{ pageNumber: 1, pageType: 'main', allocations: [{
            regionId: 'region.material', viewId: 'view.certificate.material-print', keyFields: ['material.lineId'],
            recordKeys: [{ 'material.lineId': 'LINE-01' }, { 'material.lineId': 'LINE-02' }],
          }] }],
          xlsx: {
            worksheets: ['质保书_001'],
            cells: [{ sheet: '质保书_001', address: 'A1', value: '达力普质保书示例', type: 'string' }],
            merges: [{ sheet: '质保书_001', ranges: ['A1:P2', 'C4:D4', 'G4:H4', 'K4:L4',
              'C5:H5', 'K5:P5', 'A8:P8', 'A15:P15', 'A24:P24', 'A33:P33', 'A43:P43'] }],
            images: [{ sheet: '质保书_001', count: 0, anchors: [] }],
            pageSetup: [{ sheet: '质保书_001', orientation: 'landscape', paperSize: 8, printArea: 'A1:P44' }],
          },
        },
      }],
    };
    const singleSuiteFile = join(directory, 'dalipu-output-suite.json');
    const singleReportFile = join(directory, 'dalipu-output-report.json');
    await writeFile(singleSuiteFile, JSON.stringify(singleSuite, null, 2));
    const storedSingleBefore = await snapshots.get('dalipu-demo', single.snapshot.generationId);
    const singleResult = JSON.parse(await runCli(['compare', '--mode', 'snapshot', '--data-dir', join(directory, 'data'),
      '--suite', singleSuiteFile, '--output', singleReportFile], ''));
    assert.equal(singleResult.status, 'passed');
    const singleReport = JSON.parse(await readFile(singleReportFile, 'utf8'));
    assert.equal(singleReport.mode, 'snapshot');
    assert.equal(singleReport.cases.length, 1);
    assert.ok(singleReport.cases.every(item => item.passed));
    assert.equal(singleReport.cases[0].comparison.issueCount, 0);
    assert.equal(singleReport.cases[0].comparison.dataComparison.assertions[0].actualCount, 2,
      'snapshot mode evaluates the existing dataset assertion against the stored source snapshot');
    const storedSingleBytes = await snapshots.readFile('dalipu-demo', single.snapshot.generationId);
    assert.deepEqual(await snapshots.get('dalipu-demo', single.snapshot.generationId), storedSingleBefore);

    const multiSuite = JSON.parse(await readFile(resolve(root, 'tests/fixtures/project-comparison/dalipu-multipage-output-synthetic.json'), 'utf8'));
    multiSuite.cases[0].generation.generationId = multi.snapshot.generationId;
    const multiSuiteFile = join(directory, 'dalipu-multipage-output-suite.json');
    const multiReportFile = join(directory, 'dalipu-multipage-output-report.json');
    await writeFile(multiSuiteFile, JSON.stringify(multiSuite, null, 2));
    const multiResult = JSON.parse(await runCli(['compare', '--mode', 'snapshot', '--data-dir', join(directory, 'data'),
      '--suite', multiSuiteFile, '--output', multiReportFile], ''));
    assert.equal(multiResult.status, 'passed');
    const multiReport = JSON.parse(await readFile(multiReportFile, 'utf8'));
    assert.equal(multiReport.cases[0].pageCount, 16);
    assert.deepEqual(multiReport.cases[0].pageTypes, [...Array(14).fill('main'), 'appendix', 'appendix']);

    const generalSuiteFile = join(directory, 'general-mes-output-suite.json');
    const generalReportFile = join(directory, 'general-mes-output-report.json');
    await writeFile(generalSuiteFile, JSON.stringify({
      suiteVersion: 1, suiteId: 't27-general-mes-customer-output', projectId: 'general-mes-demo',
      cases: [{
        caseId: 'general-mes-customer-layout', documentType: 'qualityCertificate',
        businessKey: general.request.businessKey, assertions: [],
        generation: {
          generationId: generalGenerated.snapshot.generationId,
          templateRef: { packageId: generalTemplate.templateId, revision: generalTemplate.version },
          pageCount: 2, pageTypes: ['main', 'appendix'],
          xlsx: { worksheets: ['客户版质保书_001', '硬度检验附页_002'], cells: [{
            sheet: '客户版质保书_001', address: 'A1', value: 'MES 客户版质保书示例', type: 'string',
          }] },
        },
      }],
    }, null, 2));
    const generalResult = JSON.parse(await runCli(['compare', '--mode', 'snapshot', '--data-dir', join(directory, 'data'),
      '--suite', generalSuiteFile, '--output', generalReportFile], ''));
    assert.equal(generalResult.status, 'passed');

    const duplicatedSnapshot = structuredClone(multi.snapshot);
    const materialView = duplicatedSnapshot.viewResults.find(view => view.viewId === 'view.certificate.material-print');
    const materialById = new Map(materialView.records.map(record => [record.recordId, record]));
    const materialPages = duplicatedSnapshot.pagePlan.pages.map(page => ({
      page, allocation: page.allocations.find(item => item.regionId === 'region.material'),
    })).filter(item => item.allocation?.recordIds.length);
    assert.ok(materialPages.length > 1);
    materialPages[1].allocation.recordIds.push(materialPages[0].allocation.recordIds[0]);
    const duplicatePagesExpectation = {
      generationId: multi.snapshot.generationId,
      templateRef: { packageId: 'dalipu-certificate-v1', revision: certificateTemplate.version },
      pageCount: duplicatedSnapshot.pagePlan.totalPages,
      pages: duplicatedSnapshot.pagePlan.pages.map(page => {
        const allocation = page.allocations.find(item => item.regionId === 'region.material');
        return {
          pageNumber: page.pageNumber, pageType: page.pageType,
          allocations: allocation ? [{
            regionId: allocation.regionId, viewId: allocation.viewId, keyFields: ['material.lineId'],
            recordKeys: allocation.recordIds.map(recordId => ({ 'material.lineId': materialById.get(recordId).values['material.lineId'] })),
          }] : [],
        };
      }),
    };
    const bulkBytes = await snapshots.readFile('dalipu-demo', multi.snapshot.generationId);
    const duplicateReport = compareGenerationOutput('duplicate-across-pages', duplicatePagesExpectation, 'dalipu-demo',
      dalipuBulk.businessKey, duplicatedSnapshot, bulkBytes, await loadExcel(bulkBytes), sha256(bulkBytes));
    assert.ok(duplicateReport.issues.some(issue => issue.code === 'DUPLICATE_RECORD_ACROSS_PAGES'));

    const badCases = [
      { caseId: 'wrong-snapshot-data', change: testCase => { testCase.assertions[0].records[0].values['material.heatNo'] = 'WRONG'; }, code: 'VALUE_MISMATCH' },
      { caseId: 'wrong-document-type', change: testCase => { testCase.documentType = 'wrongDocument'; }, code: 'DOCUMENT_TYPE_MISMATCH' },
      { caseId: 'wrong-template-version', change: generation => { generation.templateRef.revision++; }, code: 'TEMPLATE_VERSION_MISMATCH' },
      { caseId: 'wrong-page-count', change: generation => { delete generation.pages; delete generation.pageTypes; generation.pageCount++; }, code: 'PAGE_COUNT_MISMATCH' },
      { caseId: 'wrong-cell-binding', change: generation => { generation.xlsx.cells[0].value = '错误字段'; }, code: 'CELL_VALUE_MISMATCH' },
      { caseId: 'wrong-detail-order', change: generation => { generation.pages[0].allocations[0].recordKeys.reverse(); }, code: 'REGION_RECORD_KEYS_MISMATCH' },
    ];
    const invalidSuite = structuredClone(singleSuite);
    invalidSuite.cases = badCases.map(({ caseId, change }) => {
      const testCase = structuredClone(singleSuite.cases[0]);
      testCase.caseId = caseId;
      if (caseId === 'wrong-snapshot-data' || caseId === 'wrong-document-type') change(testCase);
      else change(testCase.generation);
      return testCase;
    });
    invalidSuite.cases.push({
      ...structuredClone(singleSuite.cases[0]), caseId: 'missing-generation-file',
      generation: { ...structuredClone(singleSuite.cases[0].generation), generationId: 'gen-missing-t27-artifact' },
    });
    const invalidSuiteFile = join(directory, 'invalid-output-suite.json');
    const invalidReportFile = join(directory, 'invalid-output-report.json');
    await writeFile(invalidSuiteFile, JSON.stringify(invalidSuite, null, 2));
    let invalidRunError;
    try {
      await runCli(['compare', '--mode', 'snapshot', '--data-dir', join(directory, 'data'),
        '--suite', invalidSuiteFile, '--output', invalidReportFile], '');
    } catch (error) { invalidRunError = error; }
    assert.equal(invalidRunError?.code, 1, invalidRunError?.stderr ?? invalidRunError?.message);
    const invalidReport = JSON.parse(await readFile(invalidReportFile, 'utf8').catch(() => {
      throw new Error(`快照对照未生成报告：${invalidRunError?.stderr ?? invalidRunError?.message}`);
    }));
    assert.equal(invalidReport.status, 'failed');
    for (const expected of badCases) assert.ok(invalidReport.cases.find(item => item.caseId === expected.caseId)
      .comparison.issues.some(issue => issue.code === expected.code), expected.caseId);
    assert.equal(invalidReport.cases.find(item => item.caseId === 'missing-generation-file').error.code, 'GENERATION_NOT_FOUND');

    const missingXlsxSuiteFile = join(directory, 'missing-xlsx-suite.json');
    const missingXlsxReportFile = join(directory, 'missing-xlsx-report.json');
    const missingXlsxSuite = structuredClone(singleSuite);
    missingXlsxSuite.cases = [structuredClone(singleSuite.cases[0])];
    missingXlsxSuite.cases[0].caseId = 'missing-xlsx-artifact';
    const snapshotDirectory = snapshots.path('dalipu-demo', single.snapshot.generationId);
    await rm(join(snapshotDirectory, 'output.xlsx'));
    await writeFile(missingXlsxSuiteFile, JSON.stringify(missingXlsxSuite, null, 2));
    let missingXlsxError;
    try {
      await runCli(['compare', '--mode', 'snapshot', '--data-dir', join(directory, 'data'),
        '--suite', missingXlsxSuiteFile, '--output', missingXlsxReportFile], '');
    } catch (error) { missingXlsxError = error; }
    assert.equal(missingXlsxError?.code, 1);
    const missingXlsxReport = JSON.parse(await readFile(missingXlsxReportFile, 'utf8'));
    assert.equal(missingXlsxReport.cases[0].error.code, 'GENERATION_FILE_MISSING');

    // Corrupting only the stored metadata proves the comparer checks the actual persisted bytes.
    const snapshot = structuredClone(single.snapshot);
    snapshot.output.sha256 = '0'.repeat(64);
    const workbook = await loadExcel(storedSingleBytes);
    const integrity = compareGenerationOutput('hash-check', singleSuite.cases[0].generation, 'dalipu-demo',
      dalipuSample.businessKey, snapshot, storedSingleBytes, workbook, sha256(storedSingleBytes));
    assert.ok(integrity.issues.some(issue => issue.code === 'OUTPUT_HASH_MISMATCH'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('T33.1: offline comparison can require a deterministic business rejection without accepting operational failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t33-expected-error-'));
  try {
    const configFile = join(directory, 'projects.json');
    await runCli(['init', '--example', 'dalipu', '--output', configFile]);
    const source = structuredClone(dalipuSample);
    source.datasets.find(dataset => dataset.datasetId === 'material_lines').records[0].TOTAL_LEN = 'not-a-number';
    await writeFile(join(directory, 'invalid-source.json'), JSON.stringify(source));
    const suite = { suiteVersion: 1, suiteId: 't33-expected-data-error', projectId: 'dalipu-demo', cases: [{
      caseId: 'invalid-material-length', documentType: 'qualityCertificate', businessKey: dalipuSample.businessKey,
      sourceSnapshot: 'invalid-source.json', assertions: [],
      expectedError: { code: 'VALUE_TYPE_ERROR', stage: 'collect', context: { datasetId: 'material.lines', fieldId: 'material.length' } },
    }] };
    const suiteFile = join(directory, 'suite.json'), reportFile = join(directory, 'report.json');
    await writeFile(suiteFile, JSON.stringify(suite));
    const result = JSON.parse(await runCli(['compare', '--mode', 'offline', '--config', configFile,
      '--suite', suiteFile, '--output', reportFile], ''));
    assert.equal(result.status, 'passed');
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(report.cases[0].expectedErrorMatched, true);
    assert.equal(report.cases[0].actualError.code, 'VALUE_TYPE_ERROR');
    suite.cases[0].expectedError.code = 'DATA_NOT_FOUND';
    await writeFile(suiteFile, JSON.stringify(suite));
    await assert.rejects(runCli(['compare', '--mode', 'offline', '--config', configFile, '--suite', suiteFile, '--output', reportFile], ''), error => error.code === 1);
    const mismatch = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(mismatch.cases[0].error.code, 'EXPECTED_ERROR_MISMATCH');
    suite.cases[0].expectedError.code = 'DATA_NOT_FOUND';
    await writeFile(join(directory, 'invalid-source.json'), JSON.stringify(dalipuSample));
    await writeFile(suiteFile, JSON.stringify(suite));
    await assert.rejects(runCli(['compare', '--mode', 'offline', '--config', configFile, '--suite', suiteFile, '--output', reportFile], ''), error => error.code === 1);
    const missingError = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(missingError.cases[0].error.code, 'EXPECTED_ERROR_NOT_RAISED');
    suite.cases[0].expectedError.code = 'SOURCE_UNAVAILABLE';
    await writeFile(suiteFile, JSON.stringify(suite));
    await assert.rejects(runCli(['compare', '--mode', 'offline', '--config', configFile, '--suite', suiteFile, '--output', reportFile], ''),
      error => error.code === 1 && /expectedError/.test(error.stderr));
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('T33.5/T34.1: acceptance report handles synthetic, incomplete and clean/dirty worktrees correctly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t33-acceptance-'));
  const gitDirectory = join(directory, 'clean-worktree');
  await mkdir(gitDirectory);
  try {
    const git = async (...args) => execFileAsync('git', args, { cwd: gitDirectory, encoding: 'utf8' });
    await git('init', '--quiet');
    await writeFile(join(gitDirectory, 'baseline.txt'), 'committed baseline');
    await git('add', 'baseline.txt');
    await git('-c', 'user.name=Brickbill Test', '-c', 'user.email=brickbill-test@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '-m', 'acceptance fixture');
    const projectId = 'dalipu-demo';
    const evidenceValues = {
      validate: { valid: true, projects: [{ projectId }] },
      probe: { status: 'succeeded', projectId },
      comparison: { status: 'passed', projectId, cases: [{ passed: true }] },
      deployment: { status: 'passed', projectId, restartSnapshotReused: true, sha256: 'a'.repeat(64) },
      identity: { status: 'passed', projectId, actorId: 'employee:test', authorizedProjectIds: [projectId],
        unauthorizedProjectDenied: true, clientActorSpoofRejected: true },
      print: { status: 'approved', projectId, reviewedBy: 'synthetic reviewer', approvedAt: '2026-10-20T00:00:00Z',
        artifacts: ['synthetic-print-placeholder.pdf'] },
    };
    await writeFile(join(directory, 'synthetic-print-placeholder.pdf'), 'synthetic placeholder');
    const evidence = [];
    for (const [kind, value] of Object.entries(evidenceValues)) {
      const evidenceFile = kind + '.json'; await writeFile(join(directory, evidenceFile), JSON.stringify(value));
      evidence.push({ kind, path: evidenceFile });
    }
    const manifest = { acceptanceVersion: 1, acceptanceId: 't33-synthetic', projectId, sourceKind: 'synthetic', evidence };
    const manifestFile = join(directory, 'acceptance.json'), reportFile = join(directory, 'acceptance-report.json');
    await writeFile(manifestFile, JSON.stringify(manifest));
    const result = JSON.parse(await runCli(['acceptance', '--manifest', manifestFile, '--output', reportFile], '', gitDirectory));
    assert.equal(result.status, 'simulation-only');
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(report.passedCount, 6);
    assert.equal(report.workspaceDirty, false, 'clean worktrees are valid acceptance contexts');
    assert.match(report.codeRevision, /^[0-9a-f]{7,40}$/i);
    await writeFile(join(gitDirectory, 'baseline.txt'), 'modified after commit');
    manifest.sourceKind = 'customer';
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(runCli(['acceptance', '--manifest', manifestFile, '--output', reportFile], '', gitDirectory), error => error.code === 1);
    const unapprovedBaseline = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(unapprovedBaseline.workspaceDirty, true, 'dirty worktrees remain reported accurately');
    assert.equal(unapprovedBaseline.status, 'failed');
    assert.equal(unapprovedBaseline.evidence.find(item => item.kind === 'comparison').status, 'failed');
    manifest.sourceKind = 'synthetic';
    manifest.evidence = manifest.evidence.filter(item => item.kind !== 'probe');
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(runCli(['acceptance', '--manifest', manifestFile, '--output', reportFile], '', gitDirectory), error => error.code === 1);
    const pending = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(pending.status, 'pending');
    assert.equal(pending.pendingCount, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T34.2: acceptance malformed evidence and unknown kinds produce a complete failed report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t34-acceptance-shape-'));
  try {
    const projectId = 'dalipu-demo';
    await writeFile(join(directory, 'synthetic-print.xlsx'), 'synthetic');
    const validValues = {
      validate: { valid: true, projects: [{ projectId }] },
      probe: { status: 'succeeded', projectId },
      comparison: { status: 'passed', projectId, cases: [{ passed: true }] },
      deployment: { status: 'passed', projectId, restartSnapshotReused: true, sha256: 'a'.repeat(64) },
      identity: { status: 'passed', projectId, actorId: 'employee:test', authorizedProjectIds: [projectId],
        unauthorizedProjectDenied: true, clientActorSpoofRejected: true },
      print: { status: 'approved', projectId, reviewedBy: 'synthetic reviewer', approvedAt: '2026-10-21T00:00:00Z',
        artifacts: ['synthetic-print.xlsx'] },
    };
    const cases = [
      { id: 'null-probe', kind: 'probe', value: null, expectedCode: 'EVIDENCE_SHAPE_INVALID' },
      { id: 'null-comparison-case', kind: 'comparison', value: { status: 'passed', projectId, cases: [null] },
        expectedCode: 'EVIDENCE_SHAPE_INVALID' },
      { id: 'unknown-kind', kind: 'future-check', value: { status: 'passed' }, expectedCode: 'EVIDENCE_KIND_UNKNOWN' },
      { id: 'duplicate-kind', kind: 'probe', duplicateKind: 'probe', expectedCode: 'EVIDENCE_DUPLICATE' },
      { id: 'invalid-version', kind: 'probe', version: 3, expectedCode: 'MANIFEST_INVALID', reportKind: 'manifest' },
      { id: 'missing-approval', kind: 'comparison', sourceKind: 'customer', expectedCode: 'EVIDENCE_CHECK_FAILED' },
    ];
    for (const scenario of cases) {
      const values = { ...validValues };
      if (Object.hasOwn(scenario, 'value')) values[scenario.kind] = scenario.value;
      const evidence = [];
      for (const [kind, value] of Object.entries(values)) {
        const evidenceFile = `${scenario.id}-${kind}.json`;
        await writeFile(join(directory, evidenceFile), JSON.stringify(value));
        evidence.push({ kind, path: evidenceFile });
      }
      if (scenario.duplicateKind) evidence.push({ ...evidence.find(item => item.kind === scenario.duplicateKind) });
      const manifestFile = join(directory, `${scenario.id}.json`);
      const reportFile = join(directory, `${scenario.id}-report.json`);
      await writeFile(manifestFile, JSON.stringify({ acceptanceVersion: scenario.version ?? 1, acceptanceId: scenario.id,
        projectId, sourceKind: scenario.sourceKind ?? 'synthetic', evidence }));
      let runError;
      try { await runCli(['acceptance', '--manifest', manifestFile, '--output', reportFile]); }
      catch (error) { runError = error; }
      assert.equal(runError?.code, 1, `${scenario.id} must fail closed with a report`);
      const report = JSON.parse(await readFile(reportFile, 'utf8'));
      assert.equal(report.status, 'failed');
      assert.ok(report.evidence.some(item => item.kind === (scenario.reportKind ?? scenario.kind)
        && item.status === 'failed' && item.code === scenario.expectedCode), scenario.id);
      assert.ok(Array.isArray(report.evidence) && report.evidence.length >= 6, 'all evidence checks are reported');
    }
    const malformedManifestFile = join(directory, 'array-manifest.json');
    const malformedReportFile = join(directory, 'array-manifest-report.json');
    await writeFile(malformedManifestFile, '[]');
    await assert.rejects(runCli(['acceptance', '--manifest', malformedManifestFile, '--output', malformedReportFile]),
      error => error.code === 1);
    const malformedManifestReport = JSON.parse(await readFile(malformedReportFile, 'utf8'));
    assert.equal(malformedManifestReport.status, 'failed');
    assert.equal(malformedManifestReport.evidence[0].code, 'MANIFEST_INVALID');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T34.3: version 2 acceptance requires separate data and generated-output comparisons', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t34-acceptance-v2-'));
  try {
    const projectId = 'dalipu-demo';
    await writeFile(join(directory, 'approved-print.xlsx'), 'approved synthetic bytes');
    const baseline = { sourceKind: 'customer', referenceId: 'approved-bfr-v3',
      approvedBy: 'business-owner', approvedAt: '2026-10-21T00:00:00Z' };
    const outputCase = { caseId: 'page-and-xlsx', passed: true, generationId: 'gen-approved',
      templateRef: { packageId: 'certificate-a', revision: 3 }, pageCount: 3,
      output: { sha256: 'b'.repeat(64) }, comparison: { outputComparison: { passed: true } } };
    const values = {
      validate: { valid: true, projects: [{ projectId }] },
      probe: { status: 'succeeded', projectId },
      'data-comparison': { reportVersion: 1, command: 'project:compare', projectId, mode: 'offline',
        status: 'passed', baseline, cases: [{ caseId: 'data', passed: true }] },
      'output-comparison': { reportVersion: 1, command: 'project:compare', projectId, mode: 'snapshot',
        status: 'passed', baseline, cases: [outputCase] },
      deployment: { status: 'passed', projectId, generationId: 'gen-approved', pageCount: 3,
        restartSnapshotReused: true, sha256: 'c'.repeat(64), restoreSnapshotReused: true,
        restoreMethod: 'empty-directory', restoreTargetEmptyBeforeCopy: true, restoreGenerationId: 'gen-approved',
        restorePageCount: 3, restoreSha256: 'c'.repeat(64) },
      identity: { status: 'passed', projectId, actorId: 'employee:42', authorizedProjectIds: [projectId],
        unauthorizedProjectDenied: true, clientActorSpoofRejected: true },
      print: { status: 'approved', projectId, reviewedBy: 'customer-reviewer', approvedAt: '2026-10-21T00:00:00Z',
        artifacts: [{ path: 'approved-print.xlsx', sha256: createHash('sha256').update('approved synthetic bytes').digest('hex'),
          generationId: outputCase.generationId, templateRef: outputCase.templateRef,
          generationOutputSha256: outputCase.output.sha256 }] },
    };
    const writeManifest = async (acceptanceVersion, entries, suffix) => {
      const { manifestFile, reportFile } = await writeAcceptanceFixture(directory, acceptanceVersion,
        projectId, 'customer', entries, suffix);
      let runError;
      try { await runCli(['acceptance', '--manifest', manifestFile, '--output', reportFile]); }
      catch (error) { runError = error; }
      const report = JSON.parse(await readFile(reportFile, 'utf8'));
      return { runError, report };
    };

    const complete = await writeManifest(2, values, 'v2-complete');
    assert.equal(complete.runError, undefined);
    assert.equal(complete.report.reportVersion, 2);
    assert.equal(complete.report.status, 'passed');

    const restartOnly = { ...values, deployment: { ...values.deployment } };
    for (const field of ['restoreSnapshotReused', 'restoreMethod', 'restoreTargetEmptyBeforeCopy',
      'restoreGenerationId', 'restorePageCount', 'restoreSha256']) delete restartOnly.deployment[field];
    const restartReport = await writeManifest(2, restartOnly, 'v2-restart-only');
    assert.equal(restartReport.runError?.code, 1);
    assert.equal(restartReport.report.status, 'pending');
    assert.equal(restartReport.report.evidence.find(item => item.kind === 'deployment').status, 'pending');

    const missingOutput = { ...values };
    delete missingOutput['output-comparison'];
    const incomplete = await writeManifest(2, missingOutput, 'v2-missing-output');
    assert.equal(incomplete.runError?.code, 1);
    assert.equal(incomplete.report.status, 'pending');
    assert.equal(incomplete.report.evidence.find(item => item.kind === 'output-comparison').status, 'pending');

    const badOutput = { ...values, 'output-comparison': { ...values['output-comparison'], mode: 'offline' } };
    const mismatched = await writeManifest(2, badOutput, 'v2-wrong-output-mode');
    assert.equal(mismatched.runError?.code, 1);
    assert.equal(mismatched.report.status, 'failed');

    const legacy = { ...values, comparison: values['data-comparison'],
      print: { ...values.print, artifacts: ['approved-print.xlsx'] } };
    delete legacy['data-comparison'];
    delete legacy['output-comparison'];
    const compatible = await writeManifest(1, legacy, 'v1-customer-compatible');
    assert.equal(compatible.runError?.code, 1);
    assert.equal(compatible.report.reportVersion, 1);
    assert.equal(compatible.report.status, 'pending');
    assert.equal(compatible.report.evidence.find(item => item.kind === 'comparison').status, 'passed');
    assert.equal(compatible.report.evidence.find(item => item.kind === 'output-comparison').status, 'pending');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T34.4: version 2 pins evidence bytes and binds print approval to the compared generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t34-acceptance-provenance-'));
  try {
    const projectId = 'dalipu-demo';
    const printBytes = Buffer.from('approved spreadsheet print artifact');
    await writeFile(join(directory, 'approved-print.xlsx'), printBytes);
    const baseline = { sourceKind: 'customer', referenceId: 'approved-bfr-v3',
      approvedBy: 'business-owner', approvedAt: '2026-10-21T00:00:00Z' };
    const outputCase = { caseId: 'page-and-xlsx', passed: true, generationId: 'gen-approved',
      templateRef: { packageId: 'certificate-a', revision: 3 }, pageCount: 3,
      output: { sha256: 'b'.repeat(64) }, comparison: { outputComparison: { passed: true } } };
    const values = {
      validate: { valid: true, projects: [{ projectId }] },
      probe: { status: 'succeeded', projectId },
      'data-comparison': { status: 'passed', projectId, mode: 'offline', baseline,
        cases: [{ caseId: 'data', passed: true }] },
      'output-comparison': { status: 'passed', projectId, mode: 'snapshot', baseline, cases: [outputCase] },
      deployment: { status: 'passed', projectId, generationId: 'gen-approved', pageCount: 3,
        restartSnapshotReused: true, sha256: 'c'.repeat(64), restoreSnapshotReused: true,
        restoreMethod: 'empty-directory', restoreTargetEmptyBeforeCopy: true, restoreGenerationId: 'gen-approved',
        restorePageCount: 3, restoreSha256: 'c'.repeat(64) },
      identity: { status: 'passed', projectId, actorId: 'employee:42', authorizedProjectIds: [projectId],
        unauthorizedProjectDenied: true, clientActorSpoofRejected: true },
      print: { status: 'approved', projectId, reviewedBy: 'customer-reviewer', approvedAt: '2026-10-21T00:00:00Z',
        artifacts: [{ path: 'approved-print.xlsx', sha256: createHash('sha256').update(printBytes).digest('hex'),
          generationId: outputCase.generationId, templateRef: outputCase.templateRef,
          generationOutputSha256: outputCase.output.sha256 }] },
    };
    const runValues = async (entries, suffix) => {
      const { manifestFile, reportFile, manifest } = await writeAcceptanceFixture(directory, 2,
        projectId, 'customer', entries, suffix);
      let runError;
      try { await runCli(['acceptance', '--manifest', manifestFile, '--output', reportFile]); }
      catch (error) { runError = error; }
      return { runError, report: JSON.parse(await readFile(reportFile, 'utf8')), manifestFile, reportFile, manifest };
    };
    const approved = await runValues(values, 'v2-approval-bound');
    assert.equal(approved.runError, undefined);
    assert.equal(approved.report.status, 'passed');
    assert.match(approved.report.codeRevision, /^[0-9a-f]{7,40}$/i);
    assert.match(approved.report.evidence.find(item => item.kind === 'output-comparison').sha256, /^[0-9a-f]{64}$/i);

    approved.manifest.evidence.find(item => item.kind === 'validate').sha256 = '0'.repeat(64);
    await writeFile(approved.manifestFile, JSON.stringify(approved.manifest));
    let digestError;
    try { await runCli(['acceptance', '--manifest', approved.manifestFile, '--output', approved.reportFile]); }
    catch (error) { digestError = error; }
    assert.equal(digestError?.code, 1, 'changed evidence must fail its pinned digest');
    const digestReport = JSON.parse(await readFile(approved.reportFile, 'utf8'));
    assert.equal(digestReport.evidence.find(item => item.kind === 'validate').code, 'EVIDENCE_HASH_MISMATCH');

    const wrongApproval = structuredClone(values);
    wrongApproval.print.artifacts[0].generationId = 'gen-from-another-output';
    const mismatch = await runValues(wrongApproval, 'v2-wrong-print-generation');
    assert.equal(mismatch.runError?.code, 1);
    assert.equal(mismatch.report.status, 'failed');
    assert.equal(mismatch.report.evidence.find(item => item.kind === 'print').code, 'PRINT_APPROVAL_MISMATCH');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T36.4: project acceptance verifies the version 3 deployment backup archive before passing restore evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t35-acceptance-backup-'));
  try {
    const projectId = 'dalipu-demo';
    const archive = Buffer.from('synthetic backup bytes for acceptance regression only');
    await writeFile(join(directory, 'reporting-data.tgz'), archive);
    const values = {
      validate: { valid: true, projects: [{ projectId }] },
      probe: { status: 'succeeded', projectId },
      'data-comparison': { status: 'passed', projectId, mode: 'offline', cases: [{ caseId: 'data', passed: true }] },
      'output-comparison': { status: 'passed', projectId, mode: 'snapshot', cases: [{
        caseId: 'output', passed: true, generationId: 'gen-one', templateRef: { packageId: 'template-a', revision: 1 },
        pageCount: 1, output: { sha256: 'b'.repeat(64) }, comparison: { outputComparison: { passed: true } },
      }] },
      deployment: { deploymentEvidenceVersion: 3, status: 'passed', projectId, generationId: 'gen-one',
        pageCount: 1, sha256: 'b'.repeat(64), restartSnapshotReused: true, restoreSnapshotReused: true,
        restoreMethod: 'empty-volume', restoreTargetEmptyBeforeCopy: true, restoreGenerationId: 'gen-one',
        restorePageCount: 1, restoreSha256: 'b'.repeat(64), backupArchivePath: 'reporting-data.tgz',
        dependencySha256: 'c'.repeat(64), restoreDependencySha256: 'c'.repeat(64),
        dependencyCount: 0, restoreDependencyCount: 0,
        backupSha256: createHash('sha256').update(archive).digest('hex') },
    };
    const { manifestFile, reportFile } = await writeAcceptanceFixture(directory, 2, projectId, 'synthetic', values, 'backup-binding');
    let acceptanceError;
    try { await runCli(['acceptance', '--manifest', manifestFile, '--output', reportFile]); }
    catch (error) { acceptanceError = error; }
    const passedReport = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(acceptanceError?.code, 1, 'identity and print are intentionally absent from this partial fixture');
    assert.equal(passedReport.evidence.find(item => item.kind === 'deployment').status, 'passed');

    await writeFile(join(directory, 'reporting-data.tgz'), 'changed archive bytes');
    let mismatchError;
    try { await runCli(['acceptance', '--manifest', manifestFile, '--output', reportFile]); }
    catch (error) { mismatchError = error; }
    assert.equal(mismatchError?.code, 1);
    const failedReport = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(failedReport.evidence.find(item => item.kind === 'deployment').code, 'DEPLOYMENT_BACKUP_HASH_MISMATCH');
    assert.equal(failedReport.status, 'failed');

    await writeFile(join(directory, 'reporting-data.tgz'), archive);
    const legacyDeployment = { ...values, deployment: { ...values.deployment, deploymentEvidenceVersion: 2 } };
    delete legacyDeployment.deployment.dependencySha256;
    delete legacyDeployment.deployment.restoreDependencySha256;
    delete legacyDeployment.deployment.dependencyCount;
    delete legacyDeployment.deployment.restoreDependencyCount;
    const legacy = await writeAcceptanceFixture(directory, 2, projectId, 'synthetic', legacyDeployment, 'legacy-v2-backup');
    let legacyError;
    try { await runCli(['acceptance', '--manifest', legacy.manifestFile, '--output', legacy.reportFile]); }
    catch (error) { legacyError = error; }
    const legacyReport = JSON.parse(await readFile(legacy.reportFile, 'utf8'));
    assert.equal(legacyReport.evidence.find(item => item.kind === 'deployment').status, 'passed');
    assert.equal(legacyError?.code, 1, 'the partial fixture still lacks identity and print evidence');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T38.2: project acceptance CLI preserves unversioned v1 deployment evidence and validates declared versions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t38-acceptance-version-'));
  try {
    const projectId = 'dalipu-demo';
    const runDeployment = async (value, suffix) => {
      const { manifestFile, reportFile } = await writeAcceptanceFixture(directory, 1, projectId,
        'synthetic', { deployment: value }, suffix);
      let runError;
      try { await runCli(['acceptance', '--manifest', manifestFile, '--output', reportFile]); }
      catch (error) { runError = error; }
      const report = JSON.parse(await readFile(reportFile, 'utf8'));
      return { runError, deployment: report.evidence.find(item => item.kind === 'deployment') };
    };
    const base = { status: 'passed', projectId, sha256: 'a'.repeat(64), restartSnapshotReused: true };

    const historic = await runDeployment(base, 'v1-unversioned-deployment');
    assert.equal(historic.deployment.status, 'passed', 'historical v1 evidence without a version remains readable');
    assert.equal(historic.runError?.code, 1, 'the fixture intentionally omits unrelated acceptance evidence');

    const unknown = await runDeployment({ ...base, deploymentEvidenceVersion: 5 }, 'v1-unknown-deployment-version');
    assert.equal(unknown.deployment.code, 'DEPLOYMENT_EVIDENCE_VERSION_UNSUPPORTED');

    const dependencyMismatch = await runDeployment({ ...base, deploymentEvidenceVersion: 3,
      generationId: 'generation-1', pageCount: 1, backupArchivePath: 'backup.tgz', backupSha256: 'b'.repeat(64),
      restoreSnapshotReused: true, restoreMethod: 'empty-volume', restoreTargetEmptyBeforeCopy: true,
      restoreGenerationId: 'generation-1', restorePageCount: 1, restoreSha256: 'a'.repeat(64),
      dependencySha256: 'c'.repeat(64), restoreDependencySha256: 'd'.repeat(64),
      dependencyCount: 0, restoreDependencyCount: 0 }, 'v1-v3-dependency-mismatch');
    assert.equal(dependencyMismatch.deployment.code, 'DEPLOYMENT_DEPENDENCY_MISMATCH',
      'a declared v3 contract must be validated even in a v1 acceptance manifest');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T39.4: project acceptance verifies the backup bytes referenced by version 4 PDF restore evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t39-acceptance-pdf-'));
  try {
    const projectId = 'dalipu-demo';
    const archive = Buffer.from('version 4 PDF restore archive fixture');
    await writeFile(join(directory, 'reporting-data.tgz'), archive);
    const pdfSha256 = 'd'.repeat(64);
    const values = { deployment: { deploymentEvidenceVersion: 4, status: 'passed', projectId,
      generationId: 'gen-pdf', pageCount: 2, sha256: 'a'.repeat(64), restartSnapshotReused: true,
      restoreSnapshotReused: true, restoreMethod: 'empty-volume', restoreTargetEmptyBeforeCopy: true,
      restoreGenerationId: 'gen-pdf', restorePageCount: 2, restoreSha256: 'a'.repeat(64),
      backupArchivePath: 'reporting-data.tgz', backupSha256: createHash('sha256').update(archive).digest('hex'),
      dependencySha256: 'b'.repeat(64), restoreDependencySha256: 'b'.repeat(64),
      dependencyCount: 1, restoreDependencyCount: 1, pdfAvailable: true, pdfSha256, pdfByteLength: 2048,
      restorePdfAvailable: true, restorePdfSha256: pdfSha256, restorePdfByteLength: 2048 } };
    const { manifestFile, reportFile } = await writeAcceptanceFixture(directory, 2, projectId,
      'synthetic', values, 'v4-pdf-backup-binding');
    const runAcceptance = async () => {
      let runError;
      try { await runCli(['acceptance', '--manifest', manifestFile, '--output', reportFile]); }
      catch (error) { runError = error; }
      return { runError, report: JSON.parse(await readFile(reportFile, 'utf8')) };
    };

    const valid = await runAcceptance();
    assert.equal(valid.report.evidence.find(item => item.kind === 'deployment').status, 'passed');
    assert.equal(valid.runError?.code, 1, 'other acceptance evidence remains intentionally pending');

    await writeFile(join(directory, 'reporting-data.tgz'), 'modified restore archive bytes');
    const tampered = await runAcceptance();
    assert.equal(tampered.report.evidence.find(item => item.kind === 'deployment').code,
      'DEPLOYMENT_BACKUP_HASH_MISMATCH');
    assert.equal(tampered.report.status, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
