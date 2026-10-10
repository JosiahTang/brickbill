import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InMemoryProjectAdapter } from '../src/core/adapters/project-adapter.ts';
import {
  createDalipuDemoProject,
  createExampleAdapterDefinition,
  createQualityDataViews,
  createSecondDemoProject,
} from '../src/core/adapters/example-projects.ts';
import { createPrintViews } from '../examples/projects/quality-views.ts';
import { loadProjectRegistrations, readProjectRegistrationFile } from '../server/project-registration.ts';
import { DataViewEngine } from '../src/core/views/engine.ts';
import { compareProjectResults, validateProjectComparisonSuite } from '../src/core/reporting/comparison.ts';
import { compareGenerationOutput } from '../src/core/reporting/output-comparison.ts';
import { LocalSnapshotRepository, sha256 } from '../server/repositories/local.ts';
import { loadExcel } from '../src/export/importExcel.ts';

const usage = `项目接入命令：
  npm run project:init -- --example dalipu --output config/projects.json
  npm run project:validate -- --config config/projects.json [--sample tests/fixtures/reporting/dalipu/source.json]
  npm run project:probe -- --config config/projects.json --project dalipu-demo --request-file samples/request.json --output output/project-probe.json
  npm run project:compare -- --mode offline --config config/projects.json --suite tests/fixtures/project-comparison/dalipu-synthetic.json --output output/compare.json
  npm run project:compare -- --mode snapshot --data-dir var/brickbill-reporting --suite acceptance/customer-a/output.json --output output/customer-a-output.json

project:init 支持示例：dalipu、general-mes。生成文件只含声明式配置和示例映射。`;

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!key.startsWith('--')) throw new Error(`不认识的参数：${key}`);
    const name = key.slice(2);
    if (!name || Object.hasOwn(options, name)) throw new Error(`重复或无效的参数：${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${key} 缺少值`);
    options[name] = value;
    index++;
  }
  return options;
}

function requireOptions(options, names) {
  for (const name of names) if (!options[name]) throw new Error(`缺少参数 --${name}`);
}

async function writeJson(fileName, value, { exclusive = false } = {}) {
  const target = resolve(fileName);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, exclusive ? { flag: 'wx' } : undefined);
  return target;
}

function makeExampleRegistration(example) {
  const project = example === 'dalipu' ? createDalipuDemoProject() : createSecondDemoProject();
  const baseViews = createQualityDataViews();
  return {
    project,
    adapter: createExampleAdapterDefinition(project),
    views: [...baseViews, ...createPrintViews(baseViews)],
    source: {
      endpoint: 'https://mes.example.invalid/api/reporting/source',
      timeoutMs: 15000,
      maxResponseBytes: 10485760,
      bearerTokenEnv: 'MES_SOURCE_TOKEN',
    },
  };
}

async function init(args) {
  const options = parseOptions(args);
  requireOptions(options, ['example', 'output']);
  if (!['dalipu', 'general-mes'].includes(options.example))
    throw new Error('--example 仅支持 dalipu 或 general-mes');
  const registration = makeExampleRegistration(options.example);
  const output = await writeJson(options.output, [registration], { exclusive: true });
  console.log(JSON.stringify({ created: output, projectId: registration.project.projectId, views: registration.views.length }, null, 2));
}

async function readJson(fileName, label) {
  try { return JSON.parse(await readFile(resolve(fileName), 'utf8')); }
  catch (error) { throw new Error(`${label}读取失败：${error instanceof Error ? error.message : String(error)}`); }
}

function summarizeProject(runtime) {
  const datasets = runtime.project.datasets.map(dataset => ({
    datasetId: dataset.datasetId,
    fieldCount: dataset.fields.length,
    required: dataset.required,
    grain: dataset.grain,
  }));
  return {
    projectId: runtime.project.projectId,
    displayName: runtime.project.displayName,
    documentTypes: runtime.project.documentTypes,
    fieldCount: runtime.catalog.fields.length,
    datasets,
    views: runtime.views.map(view => ({ viewId: view.viewId, outputFieldCount: view.outputFields.length })),
  };
}

async function checkSample(registration, runtime, sampleFile) {
  const source = await readJson(sampleFile, '采集样本');
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('采集样本必须是 ProjectSourceEnvelope JSON 对象');
  if (source.projectId !== runtime.project.projectId) throw new Error(`样本项目 ${source.projectId} 与配置项目 ${runtime.project.projectId} 不一致`);
  const adapter = new InMemoryProjectAdapter(runtime.project, registration.adapter, [source]);
  const bundle = await adapter.collect({ documentType: source.documentType, businessKey: source.businessKey });
  const engine = new DataViewEngine({ project: runtime.project, catalog: runtime.catalog.fields,
    views: runtime.views, functions: runtime.functions });
  const results = engine.executeAll(bundle, runtime.views.map(view => view.viewId));
  return {
    sourceVersion: bundle.sourceVersion,
    datasetRecordCounts: bundle.datasets.map(dataset => ({ datasetId: dataset.datasetId, recordCount: dataset.records.length })),
    viewRecordCounts: results.map(view => ({ viewId: view.viewId, recordCount: view.outputRecordCount })),
  };
}

async function validate(args) {
  const options = parseOptions(args);
  requireOptions(options, ['config']);
  const registrations = await readProjectRegistrationFile(resolve(options.config));
  const runtimes = await loadProjectRegistrations(resolve(options.config), { requireSecrets: false });
  const projects = [...runtimes.values()].map(summarizeProject);
  let sample;
  if (options.sample) {
    const source = await readJson(options.sample, '采集样本');
    const registration = registrations.find(item => item.project.projectId === source?.projectId);
    if (!registration) throw new Error(`项目注册文件中没有样本所属项目 ${source?.projectId ?? '(缺少 projectId)'}`);
    const runtime = runtimes.get(registration.project.projectId);
    sample = { projectId: registration.project.projectId, ...(await checkSample(registration, runtime, options.sample)) };
  }
  console.log(JSON.stringify({ command: 'project:validate', valid: true, projects, ...(sample ? { sample } : {}) }, null, 2));
}

function diagnosticError(error) {
  const context = error?.context;
  const safeContext = context && Object.fromEntries(['projectId', 'datasetId', 'fieldId', 'viewId']
    .filter(key => typeof context[key] === 'string').map(key => [key, context[key]]));
  const tokenMissing = error instanceof Error
    ? error.message.match(/Missing project source token environment variable ([A-Z_][A-Z0-9_]*)/)
    : undefined;
  const safeMessages = {
    SOURCE_TIMEOUT: '等待项目数据源响应超时',
    SOURCE_UNAVAILABLE: '项目数据源不可用或返回失败状态',
    SOURCE_RESPONSE_INVALID: '项目数据源响应不符合约定',
    DATA_NOT_FOUND: '未找到请求业务数据或必需数据集',
    GENERATION_NOT_FOUND: '指定的生成快照不存在',
    GENERATION_FILE_MISSING: '生成快照对应的 XLSX 文件缺失',
    VALUE_TYPE_ERROR: '源字段值或业务键未通过类型校验',
    FIELD_NOT_FOUND: '数据视图引用了未登记的字段',
    CONTRACT_INVALID: '项目配置或接口契约未通过校验',
    RELATION_CARDINALITY_ERROR: '数据集关联基数未通过校验',
    DUPLICATE_KEY: '数据中存在重复记录键',
    RESOURCE_LIMIT_EXCEEDED: '数据源响应超过配置上限',
  };
  return {
    code: typeof error?.code === 'string' ? error.code : 'PROJECT_PROBE_FAILED',
    ...(typeof error?.stage === 'string' ? { stage: error.stage } : {}),
    message: tokenMissing ? `缺少令牌环境变量 ${tokenMissing[1]}`
      : safeMessages[error?.code] ?? '项目接入探测失败，请检查本机命令行错误和数据源配置。',
    ...(safeContext && Object.keys(safeContext).length ? { context: safeContext } : {}),
  };
}

async function probe(args) {
  const options = parseOptions(args);
  requireOptions(options, ['config', 'project', 'request-file', 'output']);
  const configFile = resolve(options.config);
  const request = await readJson(options['request-file'], '探测请求');
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || typeof request.documentType !== 'string' || !request.businessKey || typeof request.businessKey !== 'object'
    || Array.isArray(request.businessKey)) throw new Error('探测请求必须包含 documentType 和 businessKey 对象');
  const registrations = await readProjectRegistrationFile(configFile);
  const registration = registrations.find(item => item.project.projectId === options.project);
  if (!registration) throw new Error(`项目注册文件中不存在项目 ${options.project}`);
  const report = {
    reportVersion: 1,
    command: 'project:probe',
    status: 'failed',
    checkedAt: new Date().toISOString(),
    projectId: options.project,
    documentType: request.documentType,
    businessKeyFields: Object.keys(request.businessKey).sort(),
  };
  let failure;
  try {
    const projectMap = await loadProjectRegistrations(configFile, { projectId: options.project });
    const runtime = projectMap.get(options.project);
    const bundle = await runtime.adapter.collect({ documentType: request.documentType, businessKey: request.businessKey });
    const engine = new DataViewEngine({ project: runtime.project, catalog: runtime.catalog.fields,
      views: runtime.views, functions: runtime.functions });
    const views = engine.executeAll(bundle, runtime.views.map(view => view.viewId));
    report.status = 'succeeded';
    report.source = {
      endpointOrigin: new URL(registration.source.endpoint).origin,
      sourceVersion: bundle.sourceVersion,
      collectedAt: bundle.collectedAt,
    };
    report.versions = {
      project: runtime.project.projectVersion,
      adapter: runtime.adapter.version,
      catalog: runtime.catalog.catalogVersion,
    };
    report.datasets = bundle.datasets.map(dataset => ({ datasetId: dataset.datasetId, recordCount: dataset.records.length }));
    report.views = views.map(view => ({ viewId: view.viewId, recordCount: view.outputRecordCount, diagnostics: view.diagnostics }));
  } catch (error) {
    failure = error;
    report.error = diagnosticError(error);
  }
  const output = await writeJson(options.output, report);
  console.log(JSON.stringify({ status: report.status, output }));
  if (failure) throw new Error(`项目探测未通过（${report.error.code}）：${report.error.message}`);
}

async function compare(args) {
  const options = parseOptions(args);
  requireOptions(options, ['mode', 'suite', 'output']);
  if (!['offline', 'online', 'snapshot'].includes(options.mode)) throw new Error('--mode 仅支持 offline、online 或 snapshot');
  if (options.mode === 'snapshot') requireOptions(options, ['data-dir']);
  else requireOptions(options, ['config']);
  const suiteFile = resolve(options.suite);
  const suite = validateProjectComparisonSuite(await readJson(suiteFile, '对照套件'));
  const report = {
    reportVersion: 1,
    command: 'project:compare',
    suiteId: suite.suiteId,
    projectId: suite.projectId,
    mode: options.mode,
    status: 'failed',
    checkedAt: new Date().toISOString(),
    cases: [],
  };
  try {
    if (options.mode === 'snapshot') {
      const snapshots = new LocalSnapshotRepository(resolve(options['data-dir']));
      for (const testCase of suite.cases) {
        const generation = testCase.generation;
        const caseReport = {
          caseId: testCase.caseId,
          generationId: generation?.generationId,
          businessKeyFields: Object.keys(testCase.businessKey).sort(),
        };
        try {
          if (!generation) throw Object.assign(new Error(`用例 ${testCase.caseId} 缺少 generation 输出断言`), { code: 'CONTRACT_INVALID' });
          const stored = await snapshots.get(suite.projectId, generation.generationId);
          if (!stored) throw Object.assign(new Error(`生成快照不存在：${generation.generationId}`), { code: 'GENERATION_NOT_FOUND' });
          const bytes = await snapshots.readFile(suite.projectId, generation.generationId);
          if (!bytes) throw Object.assign(new Error(`生成快照的 XLSX 文件不存在：${generation.generationId}`), { code: 'GENERATION_FILE_MISSING' });
          const workbook = await loadExcel(bytes);
          const outputComparison = compareGenerationOutput(testCase.caseId, generation, suite.projectId,
            testCase.businessKey, stored.snapshot, bytes, workbook, sha256(bytes));
          const dataComparison = testCase.assertions.length
            ? compareProjectResults(testCase.caseId, testCase.assertions, stored.snapshot.data, stored.snapshot.viewResults)
            : undefined;
          const consistencyIssues = stored.snapshot.data.documentType === testCase.documentType ? [] : [{
            caseId: testCase.caseId, scope: 'generation', targetId: generation.generationId,
            generationId: generation.generationId, code: 'DOCUMENT_TYPE_MISMATCH',
            message: '用例声明的单据类型与已保存快照不一致', expected: testCase.documentType,
            actual: stored.snapshot.data.documentType,
          }];
          const issues = [...(dataComparison?.issues ?? []), ...outputComparison.issues, ...consistencyIssues];
          const comparison = {
            passed: issues.length === 0,
            assertionCount: (dataComparison?.assertionCount ?? 0) + (generation.pages?.length ?? 0)
              + (generation.xlsx?.cells?.length ?? 0),
            issueCount: issues.length, issues, dataComparison, outputComparison,
          };
          Object.assign(caseReport, {
            passed: comparison.passed,
            templateRef: stored.snapshot.templateRef,
            pageCount: stored.snapshot.pagePlan?.totalPages,
            pageTypes: stored.snapshot.pagePlan?.pages.map(page => page.pageType),
            output: stored.snapshot.output,
            comparison,
          });
        } catch (error) {
          caseReport.passed = false;
          caseReport.error = diagnosticError(error);
        }
        report.cases.push(caseReport);
      }
    } else {
      const registrations = await readProjectRegistrationFile(resolve(options.config));
      const registration = registrations.find(item => item.project.projectId === suite.projectId);
      if (!registration) throw new Error(`项目注册文件中不存在对照项目 ${suite.projectId}`);
      const projectMap = await loadProjectRegistrations(resolve(options.config), {
        projectId: suite.projectId,
        requireSecrets: options.mode === 'online',
      });
      const runtime = projectMap.get(suite.projectId);
      report.versions = {
        project: runtime.project.projectVersion,
        adapter: runtime.adapter.version,
        catalog: runtime.catalog.catalogVersion,
      };
      const engine = new DataViewEngine({ project: runtime.project, catalog: runtime.catalog.fields,
        views: runtime.views, functions: runtime.functions });
      for (const testCase of suite.cases) {
        const caseReport = { caseId: testCase.caseId, businessKeyFields: Object.keys(testCase.businessKey).sort() };
        try {
          if (!testCase.assertions.length) throw Object.assign(new Error(`数据对照用例 ${testCase.caseId} 没有 assertions`), { code: 'CONTRACT_INVALID' });
          let adapter = runtime.adapter;
          if (options.mode === 'offline') {
            if (!testCase.sourceSnapshot) throw new Error(`离线用例 ${testCase.caseId} 必须配置 sourceSnapshot`);
            const sourcePath = resolve(dirname(suiteFile), testCase.sourceSnapshot);
            const sourceEnvelope = await readJson(sourcePath, `用例 ${testCase.caseId} 源快照`);
            adapter = new InMemoryProjectAdapter(runtime.project, registration.adapter, [sourceEnvelope]);
          }
          const bundle = await adapter.collect({ documentType: testCase.documentType, businessKey: testCase.businessKey });
          const views = engine.executeAll(bundle, runtime.views.map(view => view.viewId));
          const comparison = compareProjectResults(testCase.caseId, testCase.assertions, bundle, views);
          Object.assign(caseReport, {
            passed: comparison.passed,
            sourceVersion: bundle.sourceVersion,
            collectedAt: bundle.collectedAt,
            datasetRecordCounts: bundle.datasets.map(dataset => ({ datasetId: dataset.datasetId, recordCount: dataset.records.length })),
            viewRecordCounts: views.map(view => ({ viewId: view.viewId, recordCount: view.outputRecordCount })),
            comparison,
          });
        } catch (error) {
          caseReport.passed = false;
          caseReport.error = diagnosticError(error);
        }
        report.cases.push(caseReport);
      }
    }
    report.passedCount = report.cases.filter(item => item.passed).length;
    report.failedCount = report.cases.length - report.passedCount;
    report.status = report.failedCount === 0 ? 'passed' : 'failed';
  } catch (error) {
    report.error = diagnosticError(error);
    report.failedCount = suite.cases.length;
    report.passedCount = 0;
  }
  const output = await writeJson(options.output, report);
  console.log(JSON.stringify({ status: report.status, passedCount: report.passedCount, failedCount: report.failedCount, output }));
  if (report.status !== 'passed') throw new Error(`项目对照未通过：${report.failedCount} 个用例失败，详见 ${output}`);
}

export async function runProjectOnboarding(command, args = []) {
  if (command === 'init') return init(args);
  if (command === 'validate') return validate(args);
  if (command === 'probe') return probe(args);
  if (command === 'compare') return compare(args);
  if (command === '--help' || command === 'help' || !command) {
    console.log(usage);
    return;
  }
  throw new Error(`不支持的命令 ${command}\n\n${usage}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runProjectOnboarding(process.argv[2], process.argv.slice(3)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
