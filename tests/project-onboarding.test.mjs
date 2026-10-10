import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { sha256 } from '../server/repositories/local.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'scripts/project-onboarding.mjs');
const execFileAsync = promisify(execFile);

async function runCli(args, sourceToken = 'synthetic-test-token') {
  const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MES_SOURCE_TOKEN: sourceToken },
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

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
            merges: [{ sheet: '质保书_001', ranges: ['A1:P2'] }],
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
