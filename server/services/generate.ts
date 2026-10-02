import { randomUUID } from 'node:crypto';
import { ReportingError } from '../../src/core/contracts/errors.ts';
import { validateContract } from '../../src/core/contracts/validate.ts';
import type { DataViewDefinition, DataViewResult, GenerationSnapshot, ProjectDefinition, Scalar, TemplatePackage } from '../../src/core/contracts/types.ts';
import { DataViewEngine } from '../../src/core/views/engine.ts';
import { FunctionRegistry } from '../../src/core/functions/registry.ts';
import { planPages } from '../../src/core/pagination/index.ts';
import { projectPagePlan, type ProjectedDocumentPages } from '../../src/core/render/page.ts';
import { exportPagedXlsx } from '../../src/export/pagedExcel.ts';
import { exportFixedPdf } from '../pdf/index.ts';
import type { LocalResourceRepository, LocalSnapshotRepository, LocalTemplateRepository, LocalViewRepository, StoredGeneration, StoredPdfArtifact } from '../repositories/local.ts';
import { sha256 } from '../repositories/local.ts';

function error(code: ConstructorParameters<typeof ReportingError>[0]['code'], stage: ConstructorParameters<typeof ReportingError>[0]['stage'], message: string,
  context?: ConstructorParameters<typeof ReportingError>[0]['context']): never {
  throw new ReportingError({ code, stage, message, context });
}

export interface RuntimeProject {
  project: ProjectDefinition;
  catalog: { projectId: string; catalogVersion: string; fields: unknown[] };
  views: DataViewDefinition[];
  functions: FunctionRegistry;
  adapter: { projectId: string; version: string; collect(request: { documentType: string; businessKey: Record<string, string>; signal?: AbortSignal }): Promise<any> };
  request?: { documentType: string; businessKey: Record<string, string> };
}

export interface GenerationRequest {
  mode: 'preview' | 'issue'; documentType: string; businessKey: Record<string, string>;
  templateRef?: { id: string; version?: number }; autoMatch?: boolean;
  pageDefinitionId?: string; idempotencyKey: string; parameters?: Record<string, Scalar>;
}

export class ReportingService {
  readonly projects: Map<string, RuntimeProject>;
  readonly templates: LocalTemplateRepository;
  readonly views: LocalViewRepository;
  readonly snapshots: LocalSnapshotRepository;
  readonly resources: LocalResourceRepository;
  private readonly inFlight = new Map<string, { requestHash: string; promise: Promise<StoredGeneration> }>();

  constructor(options: { projects: Map<string, RuntimeProject>; templates: LocalTemplateRepository; views: LocalViewRepository;
    snapshots: LocalSnapshotRepository; resources: LocalResourceRepository }) {
    this.projects = options.projects; this.templates = options.templates; this.views = options.views;
    this.snapshots = options.snapshots; this.resources = options.resources;
  }

  project(projectId: string): RuntimeProject {
    const context = this.projects.get(projectId);
    if (!context) error('DATA_NOT_FOUND', 'collect', `项目不存在或当前身份无权访问：${projectId}`, { projectId });
    return context;
  }

  private checkTemplateQuotas(template: TemplatePackage): void {
    const maxWorksheets = 50, maxPageDefinitions = 100, maxTemplateCells = 1_000_000;
    const maxSourceWorkbookBytes = 20 * 1024 * 1024, maxResourcesBytes = 20 * 1024 * 1024;
    if (template.worksheets.length > maxWorksheets || (template.pageDefinitions?.length ?? 0) > maxPageDefinitions)
      error('RESOURCE_LIMIT_EXCEEDED', 'contract', `模板最多支持 ${maxWorksheets} 个工作表和 ${maxPageDefinitions} 个页面定义`, { projectId: template.projectId, templateId: template.packageId });
    const cellCount = template.worksheets.reduce((sum, sheet) => sum + Object.keys(sheet.document.cells).length, 0);
    if (cellCount > maxTemplateCells) error('RESOURCE_LIMIT_EXCEEDED', 'contract', `模板单元格超过 ${maxTemplateCells} 个限制`, { projectId: template.projectId, templateId: template.packageId });
    if ((template.sourceWorkbook?.base64.length ?? 0) > Math.ceil(maxSourceWorkbookBytes * 4 / 3) + 8)
      error('RESOURCE_LIMIT_EXCEEDED', 'contract', '原始 Excel 文件超过 20 MiB 限制', { projectId: template.projectId, templateId: template.packageId });
    const resourcesBytes = (template.resources ?? []).reduce((sum, resource) => sum + Buffer.from(resource.base64, 'base64').byteLength, 0);
    if (resourcesBytes > maxResourcesBytes) error('RESOURCE_LIMIT_EXCEEDED', 'contract', '模板图片资源总量超过 20 MiB 限制', { projectId: template.projectId, templateId: template.packageId });
  }

  async listProjects(): Promise<unknown[]> {
    return [...this.projects.values()].map(({ project }) => ({ projectId: project.projectId, displayName: project.displayName,
      documentTypes: project.documentTypes, businessKey: project.businessKey, projectVersion: project.projectVersion }));
  }

  async listViews(projectId: string): Promise<DataViewDefinition[]> {
    const context = this.project(projectId), latest = new Map(context.views.map(view => [view.viewId, view]));
    for (const record of await this.views.listPublished(projectId)) latest.set(record.itemId, record.value);
    return [...latest.values()].sort((a, b) => a.viewId.localeCompare(b.viewId));
  }

  private async resolveLatestViews(projectId: string, rootIds?: string[]): Promise<{ definitions: DataViewDefinition[]; roots: string[] }> {
    const available = new Map((await this.listViews(projectId)).map(view => [view.viewId, view]));
    const roots = rootIds?.length ? [...new Set(rootIds)] : [...available.keys()];
    const pending = [...roots], selected = new Map<string, DataViewDefinition>();
    while (pending.length) {
      const viewId = pending.shift()!; if (selected.has(viewId)) continue;
      const definition = available.get(viewId);
      if (!definition) error('RULE_VERSION_NOT_FOUND', 'view', `未发布数据视图：${viewId}`, { projectId, viewId });
      selected.set(viewId, definition);
      for (const child of definition.children ?? []) pending.push(child.viewId);
    }
    return { definitions: [...selected.values()], roots };
  }

  async previewViews(projectId: string, request: { documentType: string; businessKey: Record<string, string>; viewIds?: string[] }): Promise<{ catalogVersion: string; views: DataViewResult[] }> {
    const context = this.project(projectId);
    const data = await context.adapter.collect({ documentType: request.documentType, businessKey: request.businessKey });
    const { definitions, roots } = await this.resolveLatestViews(projectId, request.viewIds);
    const engine = new DataViewEngine({ project: context.project, catalog: context.catalog.fields as any[], views: definitions, functions: context.functions });
    return { catalogVersion: context.catalog.catalogVersion, views: engine.executeAll(data, roots) };
  }

  async saveTemplateDraft(projectId: string, templateId: string, template: TemplatePackage, expectedRevision: number) {
    this.project(projectId);
    if (template.projectId !== projectId || template.packageId !== templateId)
      error('CONTRACT_INVALID', 'contract', '模板包项目或模板标识与请求路径不一致', { projectId, templateId });
    validateContract<TemplatePackage>('templatePackage', template);
    this.checkTemplateQuotas(template);
    const existing = await this.templates.getDraft(projectId, templateId);
    const current = structuredClone(template);
    current.status = 'draft';
    if (existing && expectedRevision === 0) error('REVISION_CONFLICT', 'contract', '模板草稿已存在，请使用最新修订号', { projectId, templateId });
    for (const resource of current.resources ?? []) await this.resources.put(projectId, resource.resourceId, resource.mediaType, resource.base64);
    return this.templates.saveDraft(current, expectedRevision);
  }

  async saveViewDraft(projectId: string, viewId: string, definition: DataViewDefinition, expectedRevision: number) {
    const context = this.project(projectId);
    if (definition.viewId !== viewId) error('CONTRACT_INVALID', 'contract', '视图标识与请求路径不一致', { projectId, viewId });
    validateContract<DataViewDefinition>('dataView', definition);
    const definitions = (await this.listViews(projectId)).filter(view => view.viewId !== viewId).concat(definition);
    new DataViewEngine({ project: context.project, catalog: context.catalog.fields as any[], views: definitions, functions: context.functions });
    return this.views.saveDraft(projectId, definition, expectedRevision);
  }

  async publishView(projectId: string, viewId: string, version?: string) {
    const context = this.project(projectId);
    const draft = await this.views.getDraft(projectId, viewId);
    if (!draft) error('DATA_NOT_FOUND', 'view', `视图草稿不存在：${viewId}`, { projectId, viewId });
    const definition = structuredClone(draft.value);
    if (version) definition.version = version;
    validateContract<DataViewDefinition>('dataView', definition);
    new DataViewEngine({ project: context.project, catalog: context.catalog.fields as any[],
      views: (await this.listViews(projectId)).filter(view => view.viewId !== viewId).concat(definition), functions: context.functions });
    return this.views.publish(projectId, definition);
  }

  async publishTemplate(projectId: string, templateId: string) {
    this.project(projectId);
    const draft = await this.templates.getDraft(projectId, templateId);
    if (!draft) error('DATA_NOT_FOUND', 'contract', `模板草稿不存在：${templateId}`, { projectId, templateId });
    const template = structuredClone(draft.value);
    this.checkTemplateQuotas(template);
    const availableViews = await this.listViews(projectId);
    const referenced = new Set(template.viewRefs.map(ref => ref.viewId));
    for (const page of template.pageDefinitions ?? []) for (const region of page.regions)
      if (region.viewId) referenced.add(region.viewId);
    for (const worksheet of template.worksheets) for (const cell of Object.values(worksheet.document.cells)) if (cell.binding) {
      const field = worksheet.document.fields?.find(item => item.fieldId === cell.binding!.fieldId || item.path === cell.binding!.path || item.fieldId === cell.binding!.path);
      if (field?.sourceKind === 'view' && field.viewId) referenced.add(field.viewId);
      if (field?.sourceKind === 'dataset') {
        const sourceFieldId = field.sourceFieldId ?? field.fieldId;
        const candidates = availableViews.filter(view => view.outputFields.includes(sourceFieldId));
        if (candidates.length > 1) error('AMBIGUOUS_SCOPE', 'contract', `字段 ${field.label} 出现在多个数据视图，请改为绑定明确的数据视图`, { projectId, fieldId: sourceFieldId });
        if (candidates.length === 1) referenced.add(candidates[0].viewId);
      }
    }
    const viewRefs: Array<{ viewId: string; version: string }> = [];
    const resolvedViews = new Map<string, DataViewDefinition>();
    const pending = [...referenced];
    while (pending.length) {
      const viewId = pending.shift()!;
      if (resolvedViews.has(viewId)) continue;
      const explicit = template.viewRefs.find(ref => ref.viewId === viewId);
      const published = explicit
        ? await this.views.getPublished(projectId, viewId, explicit.version)
        : await this.views.latest(projectId, viewId);
      if (!published) error('RULE_VERSION_NOT_FOUND', 'contract', `视图尚未发布：${viewId}`, { projectId, viewId });
      viewRefs.push({ viewId, version: published.version }); resolvedViews.set(viewId, published.value);
      for (const child of published.value.children ?? []) pending.push(child.viewId);
    }
    const functionRefs = new Map<string, { functionId: string; version: string }>();
    for (const definition of resolvedViews.values()) for (const step of definition.steps) if (step.op === 'applyFunction') {
      const registered = this.project(projectId).functions.resolve(step.functionId, step.version);
      functionRefs.set(`${step.functionId}@${step.version}`, { functionId: step.functionId, version: step.version });
      if (!registered.definition.deterministic) error('RULE_VERSION_NOT_FOUND', 'rule', `函数必须是确定性版本：${step.functionId}@${step.version}`);
    }
    template.viewRefs = viewRefs;
    template.functionRefs = [...functionRefs.values()].sort((a, b) => a.functionId.localeCompare(b.functionId));
    validateContract<TemplatePackage>('templatePackage', template);
    const { validateTemplatePackage } = await import('../../src/core/templates/package.ts');
    validateTemplatePackage(template);
    return this.templates.publish(projectId, templateId, template);
  }

  async disableTemplate(projectId: string, templateId: string): Promise<void> {
    this.project(projectId);
    if (!(await this.templates.listVersions(projectId, templateId)).length)
      error('DATA_NOT_FOUND', 'contract', `模板没有已发布版本：${templateId}`, { projectId, templateId });
    await this.templates.setDisabled(projectId, templateId, true);
  }

  async setTemplateMatchRule(projectId: string, templateId: string, version: number,
    rule: { documentType: string; conditions: Record<string, string>; priority: number }) {
    const project = this.project(projectId);
    if (!Number.isInteger(version) || !project.project.documentTypes.includes(rule.documentType))
      error('CONTRACT_INVALID', 'contract', '模板匹配规则必须引用有效发布版本和项目单据类型', { projectId, templateId });
    if (!Number.isInteger(rule.priority) || rule.priority < 0 || rule.priority > 1_000_000)
      error('CONTRACT_INVALID', 'contract', '模板匹配优先级必须是 0 至 1000000 的整数', { projectId, templateId });
    for (const [fieldId, value] of Object.entries(rule.conditions)) {
      if (!Object.hasOwn(project.project.businessKey, fieldId) || typeof value !== 'string' || value.length > 200)
        error('CONTRACT_INVALID', 'contract', `模板匹配条件不是已登记的业务参数：${fieldId}`, { projectId, templateId, fieldId });
    }
    if (await this.templates.isDisabled(projectId, templateId)) error('DATA_NOT_FOUND', 'contract', '不能为已停用模板登记匹配规则', { projectId, templateId });
    return this.templates.setMatchRule(projectId, templateId, version, rule);
  }

  async generation(projectId: string, generationId: string): Promise<StoredGeneration | undefined> {
    this.project(projectId); return this.snapshots.get(projectId, generationId);
  }

  async generate(projectId: string, request: GenerationRequest, signal?: AbortSignal): Promise<StoredGeneration> {
    const context = this.project(projectId);
    if (!request.idempotencyKey || request.idempotencyKey.length > 200)
      error('CONTRACT_INVALID', 'contract', '生成请求必须提供不超过 200 字符的幂等键', { projectId });
    if (request.autoMatch) {
      if (request.templateRef) error('CONTRACT_INVALID', 'contract', '自动匹配和明确模板版本不能同时指定', { projectId });
    } else if (!request.templateRef?.id || !Number.isInteger(request.templateRef.version))
      error('CONTRACT_INVALID', 'contract', '生成必须明确指定已发布模板 ID 和版本，或启用自动匹配', { projectId });
    if (!['preview', 'issue'].includes(request.mode) || !request.documentType || !request.businessKey || typeof request.businessKey !== 'object')
      error('CONTRACT_INVALID', 'contract', '生成请求需要有效的 mode、documentType 和 businessKey', { projectId });
    const lockKey = `${projectId}:${request.idempotencyKey}`;
    const requestHash = sha256(new TextEncoder().encode(JSON.stringify(this.canonical({ projectId,
      mode: request.mode, documentType: request.documentType, businessKey: request.businessKey,
      templateRef: request.templateRef, autoMatch: request.autoMatch ?? false,
      pageDefinitionId: request.pageDefinitionId, parameters: request.parameters ?? {} }))));
    const previous = await this.snapshots.findByIdempotency(projectId, request.idempotencyKey);
    if (previous) {
      if (previous.requestHash !== requestHash) error('REVISION_CONFLICT', 'contract', '幂等键已用于不同的生成参数', { projectId });
      return previous;
    }
    const inFlight = this.inFlight.get(lockKey);
    if (inFlight) {
      if (inFlight.requestHash !== requestHash) error('REVISION_CONFLICT', 'contract', '正在处理的幂等键已用于不同的生成参数', { projectId });
      return inFlight.promise;
    }
    const promise = this.generateOnce(context, request, requestHash, signal);
    const operation = { requestHash, promise };
    this.inFlight.set(lockKey, operation);
    try { return await promise; }
    finally { if (this.inFlight.get(lockKey) === operation) this.inFlight.delete(lockKey); }
  }

  private canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => this.canonical(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, this.canonical(item)]));
    return value;
  }

  private async generateOnce(context: RuntimeProject, request: GenerationRequest, requestHash: string, signal?: AbortSignal): Promise<StoredGeneration> {
    const projectId = context.project.projectId;
    const matched = request.autoMatch ? await this.templates.match(projectId, request.documentType, request.businessKey)
      : { templateId: request.templateRef!.id, version: request.templateRef!.version! };
    const templateId = matched.templateId, version = matched.version;
    if (await this.templates.isDisabled(projectId, templateId)) error('DATA_NOT_FOUND', 'contract', `模板已停用：${templateId}`, { projectId, templateId });
    const published = await this.templates.getVersion(projectId, templateId, version);
    if (!published || published.value.status !== 'published') error('RULE_VERSION_NOT_FOUND', 'contract', `模板发布版本不存在：${templateId}@${version}`, { projectId, templateId });
    const template = published.value;
    if (template.projectId !== projectId) error('CONTRACT_INVALID', 'contract', '模板不属于当前项目', { projectId, templateId });
    // Every required view/function is loaded from its pinned immutable version.
    const definitions: DataViewDefinition[] = [];
    for (const ref of template.viewRefs) {
      const view = await this.views.getPublished(projectId, ref.viewId, ref.version);
      if (!view) error('RULE_VERSION_NOT_FOUND', 'view', `固定视图版本不存在：${ref.viewId}@${ref.version}`, { projectId, viewId: ref.viewId });
      definitions.push(view.value);
    }
    const data = await context.adapter.collect({ documentType: request.documentType, businessKey: request.businessKey, signal });
    const engine = new DataViewEngine({ project: context.project, catalog: context.catalog.fields as any[], views: definitions, functions: context.functions });
    const viewResults = engine.executeAll(data, template.viewRefs.map(ref => ref.viewId));
    const pageDefinitionId = request.pageDefinitionId
      ?? template.pageDefinitions?.find(page => page.pageType === 'main')?.pageDefinitionId;
    if (!pageDefinitionId) error('CONTRACT_INVALID', 'contract', '模板没有可用于生成的主页面定义', { projectId, templateId });
    const pagePlan = planPages(template, pageDefinitionId, viewResults, { parameters: request.parameters });
    if (pagePlan.totalPages > 500) error('RESOURCE_LIMIT_EXCEEDED', 'layout', '单次生成最多支持 500 页', { projectId, templateId });
    const projection = projectPagePlan(template, pagePlan, viewResults, { parameters: request.parameters });
    const projectedCells = projection.pages.reduce((sum, page) => sum + Object.keys(page.document.cells).length, 0);
    if (projectedCells > 5_000_000) error('RESOURCE_LIMIT_EXCEEDED', 'render', '单次生成投影超过 500 万个单元格', { projectId, templateId });
    const output = await this.output(projectId, template, projection);
    const maxOutputBytes = Number(process.env.REPORTING_MAX_OUTPUT_BYTES ?? 50 * 1024 * 1024);
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024) error('CONTRACT_INVALID', 'contract', 'REPORTING_MAX_OUTPUT_BYTES 配置无效', { projectId });
    if (output.bytes.byteLength > maxOutputBytes) error('RESOURCE_LIMIT_EXCEEDED', 'export', `生成文件超过 ${maxOutputBytes} 字节限制`, { projectId, templateId });
    const snapshot: GenerationSnapshot = {
      contractVersion: 2, generationId: `gen-${randomUUID()}`, projectId, businessKey: structuredClone(request.businessKey),
      templateRef: { packageId: template.packageId, revision: template.revision }, catalogVersion: context.catalog.catalogVersion,
      viewRefs: structuredClone(template.viewRefs), functionRefs: structuredClone(template.functionRefs),
      collectedAt: data.collectedAt, sourceVersion: data.sourceVersion, data, viewResults,
      pagePlan: structuredClone(pagePlan), output: { fileName: output.fileName, mediaType: output.mediaType, sha256: sha256(output.bytes), byteLength: output.bytes.byteLength },
    };
    validateContract<GenerationSnapshot>('generationSnapshot', snapshot);
    const savedProjection = structuredClone(projection);
    delete savedProjection.sourceWorkbook;
    const stored: StoredGeneration = { snapshot, projection: savedProjection, mode: request.mode, idempotencyKey: request.idempotencyKey,
      requestHash, createdAt: new Date().toISOString() };
    await this.snapshots.commit(stored, output.bytes);
    return stored;
  }

  async output(projectId: string, template: TemplatePackage, projection: ProjectedDocumentPages) {
    this.project(projectId);
    return exportPagedXlsx(template, projection, `${template.name.replace(/[\\/:*?"<>|]/g, '_')}-${projection.pagePlan.totalPages}p.xlsx`);
  }

  private pdfProjectEnabled(projectId: string): boolean {
    return (process.env.REPORTING_PDF_ENABLED_PROJECTS ?? '').split(',').map(value => value.trim()).includes(projectId);
  }

  async pdfAvailable(projectId: string, record: StoredGeneration): Promise<boolean> {
    this.project(projectId);
    if (!this.pdfProjectEnabled(projectId)) return false;
    const ref = record.snapshot.templateRef;
    const published = await this.templates.getVersion(projectId, ref.packageId, ref.revision);
    if (!published) return false;
    const definitions = new Map((published.value.pageDefinitions ?? []).map(page => [page.pageDefinitionId, page]));
    const fixed = !!record.snapshot.pagePlan?.pages.length && record.snapshot.pagePlan.pages.every(page => {
      const definition = definitions.get(page.pageDefinitionId);
      return !!definition && definition.paginationMode !== 'flow';
    });
    if (!fixed) return false;
    if (await this.snapshots.readPdf(projectId, record.snapshot.generationId)) return true;
    return !!process.env.REPORTING_PDF_PYTHON && !!process.env.REPORTING_PDF_FALLBACK_FONT;
  }

  async pdf(projectId: string, generationId: string): Promise<StoredPdfArtifact> {
    const record = await this.generation(projectId, generationId);
    if (!record) error('DATA_NOT_FOUND', 'export', `生成快照不存在：${generationId}`, { projectId });
    if (!await this.pdfAvailable(projectId, record))
      error('CONTRACT_INVALID', 'export', '该项目或模板尚未开放固定版式 PDF 输出；请检查项目开关、渲染环境和分页模式', { projectId, templateId: record.snapshot.templateRef.packageId });
    const existing = await this.snapshots.readPdf(projectId, generationId);
    if (existing) return existing;
    const ref = record.snapshot.templateRef;
    const published = await this.templates.getVersion(projectId, ref.packageId, ref.revision);
    if (!published) error('RULE_VERSION_NOT_FOUND', 'export', `PDF 对应的已发布模板版本不存在：${ref.packageId}@${ref.revision}`);
    const rendered = await exportFixedPdf(published.value, record.projection as ProjectedDocumentPages);
    return this.snapshots.putPdf(projectId, generationId, rendered);
  }

  async reprint(projectId: string, generationId: string): Promise<StoredGeneration> {
    const record = await this.generation(projectId, generationId);
    if (!record) error('DATA_NOT_FOUND', 'export', `生成快照不存在：${generationId}`, { projectId });
    if (!(await this.snapshots.readFile(projectId, generationId))) error('DATA_NOT_FOUND', 'export', '快照对应的生成文件已丢失', { projectId });
    return record;
  }
}
