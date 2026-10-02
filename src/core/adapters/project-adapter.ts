import { ReportingError } from '../contracts/errors.ts';
import { validateContract } from '../contracts/validate.ts';
import type {
  DataFieldDefinition, DatasetBundle, ProjectDefinition, Scalar, ValueType,
  ProjectAdapterDefinition, ProjectSourceEnvelope, SourceRecordEnvelope,
} from '../contracts/types.ts';
import { validateDatasetBundleAgainstProject } from '../catalog/catalog.ts';
import { validateProjectSemantics } from '../contracts/validate.ts';

export type RawSourceRecord = SourceRecordEnvelope;

export interface SourceFieldMapping {
  fieldId: string;
  sourceColumn: string;
  type: ValueType;
  nullable: boolean;
  unit?: string;
  /** Optional explicit source-code map, such as Y/N to boolean. */
  valueMap?: Record<string, Scalar>;
}

export interface DatasetSourceMapping {
  datasetId: string;
  sourceName: string;
  keyFieldIds: string[];
  fields: SourceFieldMapping[];
}

export interface ProjectAdapterConfig {
  contractVersion: 2;
  projectId: string;
  adapterId: string;
  version: string;
  datasets: DatasetSourceMapping[];
  maxRecords?: number;
}

export interface CollectRequest {
  documentType: string;
  businessKey: Record<string, string>;
  signal?: AbortSignal;
}

export interface ProjectAdapter {
  readonly projectId: string;
  readonly adapterId: string;
  readonly version: string;
  collect(request: CollectRequest): Promise<DatasetBundle>;
}

export interface HttpProjectSourceConfig {
  endpoint: string;
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function fail(code: ConstructorParameters<typeof ReportingError>[0]['code'], stage: ConstructorParameters<typeof ReportingError>[0]['stage'],
  message: string, context?: ConstructorParameters<typeof ReportingError>[0]['context'], retryable?: boolean): never {
  throw new ReportingError({ code, stage, message, ...(context ? { context } : {}), ...(retryable !== undefined ? { retryable } : {}) });
}

export function encodeCompositeKey(values: Scalar[]): string {
  if (!values.length || values.some(value => value == null || value === ''))
    fail('VALUE_TYPE_ERROR', 'collect', '复合键不能为空');
  // Length-prefix components so values containing a separator cannot collide.
  return values.map(value => {
    const part = `${typeof value}:${String(value)}`;
    return `${part.length}:${part}`;
  }).join('|');
}

function validateBusinessKey(project: ProjectDefinition, request: CollectRequest): void {
  if (!project.documentTypes.includes(request.documentType))
    fail('CONTRACT_INVALID', 'collect', `项目不支持单据类型 ${request.documentType}`, { projectId: project.projectId });
  for (const [key, definition] of Object.entries(project.businessKey)) {
    const value = request.businessKey[key];
    if (definition.required && !value?.trim()) fail('VALUE_TYPE_ERROR', 'collect', `业务单号参数 ${definition.label} 不能为空`, { projectId: project.projectId, fieldId: key });
    if (value !== undefined && (typeof value !== 'string' || value.length > 200))
      fail('VALUE_TYPE_ERROR', 'collect', `业务单号参数 ${definition.label} 无效`, { projectId: project.projectId, fieldId: key });
  }
  for (const key of Object.keys(request.businessKey)) if (!Object.hasOwn(project.businessKey, key))
    fail('CONTRACT_INVALID', 'collect', `项目未登记业务单号参数 ${key}`, { projectId: project.projectId, fieldId: key });
}

function convertValue(raw: unknown, mapping: SourceFieldMapping, definition: DataFieldDefinition,
  context: { projectId: string; datasetId: string; recordId?: string }): Scalar {
  const error = (message: string): never => fail('VALUE_TYPE_ERROR', 'collect', message,
    { ...context, fieldId: mapping.fieldId, sourcePath: mapping.sourceColumn });
  if (raw === undefined || raw === null || raw === '') {
    if (mapping.nullable) return null;
    return error(`必填源字段 ${mapping.sourceColumn} 为空`);
  }
  if (mapping.valueMap) {
    const key = String(raw).trim();
    if (Object.hasOwn(mapping.valueMap, key)) raw = mapping.valueMap[key];
    else return error(`源字段 ${mapping.sourceColumn} 的值 ${key} 未配置映射`);
  }
  if (mapping.type !== definition.type || mapping.nullable !== definition.nullable)
    return error(`映射字段 ${mapping.fieldId} 的类型定义与项目字段目录不一致`);

  if (mapping.type === 'number') {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim())) {
      const value = Number(raw.trim()); if (Number.isFinite(value)) return value;
    }
    return error(`源字段 ${mapping.sourceColumn} 不是有效数字`);
  }
  if (mapping.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      const value = raw.trim().toUpperCase();
      if (['1', 'Y', 'YES', 'TRUE'].includes(value)) return true;
      if (['0', 'N', 'NO', 'FALSE'].includes(value)) return false;
    }
    return error(`源字段 ${mapping.sourceColumn} 不是有效布尔值`);
  }
  if (mapping.type === 'date') {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim()))
      return error(`源字段 ${mapping.sourceColumn} 必须转换为 YYYY-MM-DD 日期`);
    const value = raw.trim();
    if (Number.isNaN(Date.parse(value)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
      return error(`源字段 ${mapping.sourceColumn} 日期不存在`);
    return value;
  }
  if (typeof raw !== 'string') return error(`源字段 ${mapping.sourceColumn} 应为文本`);
  return raw;
}

function stableRequestKey(request: CollectRequest): string {
  const businessKey = Object.fromEntries(Object.entries(request.businessKey).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ documentType: request.documentType, businessKey });
}

export abstract class MappedProjectAdapter implements ProjectAdapter {
  readonly projectId: string;
  readonly adapterId: string;
  readonly version: string;
  protected readonly project: ProjectDefinition;
  protected readonly config: ProjectAdapterConfig;
  protected readonly mappingByDataset: Map<string, DatasetSourceMapping>;
  protected readonly maxRecords: number;

  constructor(
    project: ProjectDefinition,
    config: ProjectAdapterConfig,
  ) {
    this.project = project;
    this.config = config;
    const normalizedConfig: ProjectAdapterDefinition = { ...config, maxRecords: config.maxRecords ?? 50000 };
    validateContract<ProjectAdapterDefinition>('projectAdapter', normalizedConfig);
    validateProjectSemantics(project);
    if (config.projectId !== project.projectId || config.adapterId !== project.adapterId || config.version !== project.adapterVersion)
      fail('CONTRACT_INVALID', 'collect', '适配器配置与项目版本不一致', { projectId: project.projectId });
    this.projectId = project.projectId; this.adapterId = config.adapterId; this.version = config.version;
    this.maxRecords = normalizedConfig.maxRecords;
    if (!Number.isInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > 500000)
      fail('CONTRACT_INVALID', 'collect', '适配器记录上限必须为 1 至 500000');
    this.mappingByDataset = new Map();
    const datasetDefs = new Map(project.datasets.map(dataset => [dataset.datasetId, dataset]));
    for (const mapping of config.datasets) {
      const definition = datasetDefs.get(mapping.datasetId);
      if (!definition) fail('CONTRACT_INVALID', 'collect', `未定义数据集 ${mapping.datasetId}`);
      if (this.mappingByDataset.has(mapping.datasetId)) fail('DUPLICATE_KEY', 'collect', `重复映射数据集 ${mapping.datasetId}`);
      if (!mapping.sourceName.trim() || !mapping.keyFieldIds.length) fail('CONTRACT_INVALID', 'collect', `数据集 ${mapping.datasetId} 缺少源名称或主键映射`);
      const configuredFields = new Map(mapping.fields.map(field => [field.fieldId, field]));
      if (configuredFields.size !== mapping.fields.length) fail('DUPLICATE_KEY', 'collect', `数据集 ${mapping.datasetId} 存在重复字段映射`);
      for (const field of definition.fields) {
        const item = configuredFields.get(field.fieldId);
        if (!item) {
          if (!field.nullable || definition.primaryKey.includes(field.fieldId)) fail('CONTRACT_INVALID', 'collect', `必填字段 ${field.fieldId} 缺少源映射`, { datasetId: definition.datasetId, fieldId: field.fieldId });
          continue;
        }
        if (item.type !== field.type || item.nullable !== field.nullable)
          fail('CONTRACT_INVALID', 'collect', `字段 ${field.fieldId} 映射类型不匹配`, { datasetId: definition.datasetId, fieldId: field.fieldId });
      }
      for (const fieldId of configuredFields.keys()) if (!definition.fields.some(field => field.fieldId === fieldId))
        fail('CONTRACT_INVALID', 'collect', `映射指向未定义字段 ${fieldId}`, { datasetId: definition.datasetId, fieldId });
      const mapKeys = new Set(mapping.keyFieldIds);
      if (mapKeys.size !== mapping.keyFieldIds.length || definition.primaryKey.some(fieldId => !mapKeys.has(fieldId)))
        fail('CONTRACT_INVALID', 'collect', `源键映射必须包含数据集 ${definition.datasetId} 的完整复合主键`, { datasetId: definition.datasetId });
      this.mappingByDataset.set(mapping.datasetId, mapping);
    }
    for (const dataset of project.datasets) if (dataset.required && !this.mappingByDataset.has(dataset.datasetId))
      fail('CONTRACT_INVALID', 'collect', `必需数据集 ${dataset.datasetId} 缺少适配映射`, { datasetId: dataset.datasetId });
  }

  protected abstract readSource(request: CollectRequest): Promise<ProjectSourceEnvelope>;

  async collect(request: CollectRequest): Promise<DatasetBundle> {
    validateBusinessKey(this.project, request);
    let envelope: ProjectSourceEnvelope;
    try { envelope = await this.readSource(request); }
    catch (error) {
      if (error instanceof ReportingError) throw error;
      const timedOut = error instanceof Error && (error.name === 'AbortError' || /timeout/i.test(error.name));
      fail(timedOut ? 'SOURCE_TIMEOUT' : 'SOURCE_UNAVAILABLE', 'collect',
        timedOut ? '等待项目数据源超时' : '项目数据源不可用', { projectId: this.projectId }, true);
    }
    validateContract<ProjectSourceEnvelope>('sourceEnvelope', envelope);
    if (envelope.contractVersion !== 2 || envelope.projectId !== this.projectId || envelope.documentType !== request.documentType)
      fail('SOURCE_RESPONSE_INVALID', 'collect', '数据源响应的项目或单据类型与请求不一致', { projectId: this.projectId });
    if (stableRequestKey({ documentType: envelope.documentType, businessKey: envelope.businessKey }) !== stableRequestKey(request))
      fail('SOURCE_RESPONSE_INVALID', 'collect', '数据源响应业务单号与请求不一致', { projectId: this.projectId });
    if (!Array.isArray(envelope.datasets) || !envelope.sourceVersion || !Number.isFinite(Date.parse(envelope.collectedAt)))
      fail('SOURCE_RESPONSE_INVALID', 'collect', '数据源响应缺少数据集、源版本或采集时间', { projectId: this.projectId });

    const rawByName = new Map<string, RawSourceRecord[]>();
    const knownSourceNames = new Set([...this.mappingByDataset.values()].map(mapping => mapping.sourceName));
    for (const dataset of envelope.datasets) {
      if (rawByName.has(dataset.datasetId)) fail('DUPLICATE_KEY', 'collect', `数据源重复返回集合 ${dataset.datasetId}`, { projectId: this.projectId, datasetId: dataset.datasetId });
      if (!knownSourceNames.has(dataset.datasetId)) fail('SOURCE_RESPONSE_INVALID', 'collect', `数据源返回了未配置的数据集 ${dataset.datasetId}`, { projectId: this.projectId, datasetId: dataset.datasetId });
      rawByName.set(dataset.datasetId, dataset.records);
    }
    const total = envelope.datasets.reduce((count, dataset) => count + (Array.isArray(dataset.records) ? dataset.records.length : 0), 0);
    if (total > this.maxRecords) fail('RESOURCE_LIMIT_EXCEEDED', 'collect', `数据源返回超过 ${this.maxRecords} 条记录`, { projectId: this.projectId });

    const datasets = this.project.datasets.map(definition => {
      const mapping = this.mappingByDataset.get(definition.datasetId);
      const rawRecords = mapping ? rawByName.get(mapping.sourceName) : undefined;
      if (mapping && !rawRecords && definition.required) fail('DATA_NOT_FOUND', 'collect', `未返回数据集 ${mapping.sourceName}`, { projectId: this.projectId, datasetId: definition.datasetId });
      if (rawRecords !== undefined && !Array.isArray(rawRecords)) fail('SOURCE_RESPONSE_INVALID', 'collect', `数据集 ${mapping!.sourceName} 不是记录数组`, { projectId: this.projectId, datasetId: definition.datasetId });
      const records = (rawRecords ?? []).map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('SOURCE_RESPONSE_INVALID', 'collect', `数据集 ${mapping!.sourceName} 第 ${index + 1} 条不是对象`, { projectId: this.projectId, datasetId: definition.datasetId });
        const values: Record<string, Scalar> = {};
        for (const item of mapping?.fields ?? []) {
          const fieldDef = definition.fields.find(field => field.fieldId === item.fieldId)!;
          const value = Object.hasOwn(raw, item.sourceColumn) ? raw[item.sourceColumn] : undefined;
          values[item.fieldId] = convertValue(value, item, fieldDef, { projectId: this.projectId, datasetId: definition.datasetId });
        }
        const recordId = encodeCompositeKey(definition.primaryKey.map(fieldId => values[fieldId]));
        return { recordId, values, sourceRecordIds: [`${mapping!.sourceName}:${recordId}`] };
      });
      return { datasetId: definition.datasetId, records };
    });
    const bundle: DatasetBundle = {
      contractVersion: 2, projectId: this.projectId, documentType: request.documentType,
      businessKey: request.businessKey, sourceVersion: envelope.sourceVersion,
      collectedAt: new Date(envelope.collectedAt).toISOString(), datasets,
    };
    validateDatasetBundleAgainstProject(bundle, this.project);
    return bundle;
  }
}

export class InMemoryProjectAdapter extends MappedProjectAdapter {
  private readonly sources = new Map<string, ProjectSourceEnvelope>();
  constructor(project: ProjectDefinition, config: ProjectAdapterConfig, samples: ProjectSourceEnvelope[]) {
    super(project, config);
    for (const sample of samples) {
      const key = stableRequestKey({ documentType: sample.documentType, businessKey: sample.businessKey });
      if (this.sources.has(key)) fail('DUPLICATE_KEY', 'collect', `模拟数据业务单号重复：${key}`, { projectId: project.projectId });
      this.sources.set(key, structuredClone(sample));
    }
  }
  protected async readSource(request: CollectRequest): Promise<ProjectSourceEnvelope> {
    const source = this.sources.get(stableRequestKey(request));
    if (!source) fail('DATA_NOT_FOUND', 'collect', '模拟数据中不存在此业务单号', { projectId: this.projectId });
    return structuredClone(source);
  }
}

export class HttpProjectAdapter extends MappedProjectAdapter {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly headersProvider?: HttpProjectSourceConfig['headers'];
  private readonly source: HttpProjectSourceConfig;

  constructor(project: ProjectDefinition, config: ProjectAdapterConfig, source: HttpProjectSourceConfig) {
    super(project, config);
    this.source = source;
    let endpoint: URL;
    try { endpoint = new URL(source.endpoint); } catch { fail('CONTRACT_INVALID', 'collect', '项目适配接口地址无效'); }
    if (!['http:', 'https:'].includes(endpoint!.protocol) || endpoint!.username || endpoint!.password)
      fail('CONTRACT_INVALID', 'collect', '项目适配接口只允许 HTTP(S) 地址，不允许在地址中写入凭据');
    this.fetcher = source.fetcher ?? fetch;
    this.timeoutMs = source.timeoutMs ?? 15000;
    this.maxResponseBytes = source.maxResponseBytes ?? 10 * 1024 * 1024;
    this.headersProvider = source.headers;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120000)
      fail('CONTRACT_INVALID', 'collect', 'HTTP 采集超时须在 100 到 120000 毫秒之间');
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1024 || this.maxResponseBytes > 100 * 1024 * 1024)
      fail('CONTRACT_INVALID', 'collect', 'HTTP 响应上限须在 1 KiB 至 100 MiB 之间');
  }

  protected async readSource(request: CollectRequest): Promise<ProjectSourceEnvelope> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('source timeout', 'AbortError')), this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    try {
      const headers = await this.headersProvider?.() ?? {};
      const response = await this.fetcher(this.source.endpoint, {
        method: 'POST', signal, headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify({ projectId: this.projectId, documentType: request.documentType, businessKey: request.businessKey }),
      });
      if (response.status === 404) fail('DATA_NOT_FOUND', 'collect', '项目数据源中不存在此业务单号', { projectId: this.projectId });
      if (!response.ok) fail('SOURCE_UNAVAILABLE', 'collect', `项目数据源返回 HTTP ${response.status}`, { projectId: this.projectId }, response.status >= 500);
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes)
        fail('RESOURCE_LIMIT_EXCEEDED', 'collect', `项目接口响应超过 ${this.maxResponseBytes} 字节`, { projectId: this.projectId });
      if (!response.body) fail('SOURCE_RESPONSE_INVALID', 'collect', '项目数据源没有返回 JSON 内容', { projectId: this.projectId });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let byteLength = 0, bodyText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > this.maxResponseBytes) {
          await reader.cancel();
          fail('RESOURCE_LIMIT_EXCEEDED', 'collect', `项目接口响应超过 ${this.maxResponseBytes} 字节`, { projectId: this.projectId });
        }
        bodyText += decoder.decode(value, { stream: true });
      }
      bodyText += decoder.decode();
      let value: unknown;
      try { value = JSON.parse(bodyText); }
      catch { fail('SOURCE_RESPONSE_INVALID', 'collect', '项目接口返回的 JSON 格式无效', { projectId: this.projectId }); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SOURCE_RESPONSE_INVALID', 'collect', '项目接口必须返回 JSON 对象', { projectId: this.projectId });
      return value as ProjectSourceEnvelope;
    } finally {
      clearTimeout(timer);
    }
  }
}
