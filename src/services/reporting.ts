import type { FieldCatalog, DataViewDefinition, TemplatePackage } from '../core/contracts/types.ts';
import type { ProjectedSheetPage } from '../core/render/page.ts';

export interface ReportingProject {
  projectId: string; displayName: string; documentTypes: string[];
  businessKey: Record<string, { label: string; type: string; required: boolean }>;
  projectVersion: string;
}
export interface ApiErrorPayload { code: string; message: string; stage?: string; context?: Record<string, unknown> }
export class ReportingApiError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;
  constructor(payload: ApiErrorPayload) { super(payload.message); this.name = 'ReportingApiError'; this.code = payload.code; this.context = payload.context; }
}
export interface GenerationReply {
  generationId: string; projectId: string; mode: 'preview' | 'issue'; status: string; pageCount: number;
  fileUrl: string; pdfUrl?: string; snapshot: { pagePlan: unknown; [key: string]: unknown };
}
export interface GenerationPageReply { pageNumber: number; totalPages: number; diagnostics: unknown[]; sheets: ProjectedSheetPage[]; resources: NonNullable<TemplatePackage['resources']> }
const defaultBase = import.meta.env.VITE_REPORTING_API_URL || 'http://127.0.0.1:5174/api';

export class ReportingClient {
  readonly baseUrl: string;
  readonly token: string;
  constructor(baseUrl = defaultBase, token = '') { this.baseUrl = baseUrl.replace(/\/$/, ''); this.token = token; }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...init.headers,
    } });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new ReportingApiError(body?.error ?? { code: 'HTTP_ERROR', message: `服务请求失败 (${response.status})` });
    }
    return await response.json() as T;
  }
  getProjects(): Promise<ReportingProject[]> { return this.request('/projects'); }
  getCatalog(projectId: string): Promise<FieldCatalog> { return this.request(`/projects/${encodeURIComponent(projectId)}/catalog`); }
  getViews(projectId: string): Promise<DataViewDefinition[]> { return this.request(`/projects/${encodeURIComponent(projectId)}/views`); }
  getViewDraft(projectId: string, viewId: string) {
    return this.request<{ revision: number; value: DataViewDefinition }>(`/projects/${encodeURIComponent(projectId)}/views/${encodeURIComponent(viewId)}/draft`);
  }
  saveViewDraft(projectId: string, definition: DataViewDefinition, expectedRevision: number) {
    return this.request<{ revision: number; value: DataViewDefinition }>(`/projects/${encodeURIComponent(projectId)}/views/${encodeURIComponent(definition.viewId)}/draft`, {
      method: 'PUT', body: JSON.stringify({ definition, expectedRevision }),
    });
  }
  publishView(projectId: string, viewId: string, version?: string) {
    return this.request<{ version: string; value: DataViewDefinition }>(`/projects/${encodeURIComponent(projectId)}/views/${encodeURIComponent(viewId)}/publish`, {
      method: 'POST', body: JSON.stringify(version ? { version } : {}),
    });
  }
  previewViews(projectId: string, request: { documentType: string; businessKey: Record<string, string>; viewIds?: string[] }) {
    return this.request<{ catalogVersion: string; views: unknown[] }>(`/projects/${encodeURIComponent(projectId)}/views/preview`, { method: 'POST', body: JSON.stringify(request) });
  }
  saveTemplateDraft(projectId: string, template: TemplatePackage, expectedRevision: number) {
    return this.request<{ revision: number; value: TemplatePackage }>(`/projects/${encodeURIComponent(projectId)}/templates/${encodeURIComponent(template.packageId)}/draft`, {
      method: 'PUT', body: JSON.stringify({ expectedRevision, template }),
    });
  }
  getTemplateDraft(projectId: string, templateId: string) {
    return this.request<{ revision: number; value: TemplatePackage }>(`/projects/${encodeURIComponent(projectId)}/templates/${encodeURIComponent(templateId)}/draft`);
  }
  getTemplateVersions(projectId: string, templateId: string) {
    return this.request<Array<{ itemId: string; version: number; publishedAt: string }>>(`/projects/${encodeURIComponent(projectId)}/templates/${encodeURIComponent(templateId)}/versions`);
  }
  publishTemplate(projectId: string, templateId: string) {
    return this.request<{ version: number; value: TemplatePackage }>(`/projects/${encodeURIComponent(projectId)}/templates/${encodeURIComponent(templateId)}/publish`, { method: 'POST', body: '{}' });
  }
  setTemplateMatchRule(projectId: string, templateId: string, version: number,
    rule: { documentType: string; conditions: Record<string, string>; priority: number }) {
    return this.request(`/projects/${encodeURIComponent(projectId)}/templates/${encodeURIComponent(templateId)}/versions/${version}/match-rule`, {
      method: 'PUT', body: JSON.stringify(rule),
    });
  }
  generate(projectId: string, request: { mode: 'preview' | 'issue'; documentType: string; businessKey: Record<string, string>;
    templateRef?: { id: string; version: number }; autoMatch?: boolean; pageDefinitionId?: string; idempotencyKey: string; parameters?: Record<string, string | number | boolean | null> }) {
    return this.request<GenerationReply>(`/projects/${encodeURIComponent(projectId)}/generations`, { method: 'POST', body: JSON.stringify(request) });
  }
  getGeneration(projectId: string, generationId: string): Promise<GenerationReply> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}`);
  }
  getPage(projectId: string, generationId: string, page: number): Promise<GenerationPageReply> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/pages/${page}`);
  }
  async getFile(projectId: string, generationId: string): Promise<Blob> {
    const response = await fetch(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/file`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new ReportingApiError(body?.error ?? { code: 'HTTP_ERROR', message: `文件下载失败 (${response.status})` });
    }
    return response.blob();
  }
  async getPdf(projectId: string, generationId: string): Promise<Blob> {
    const response = await fetch(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/file.pdf`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new ReportingApiError(body?.error ?? { code: 'HTTP_ERROR', message: `PDF 下载失败 (${response.status})` });
    }
    return response.blob();
  }
  reprint(projectId: string, generationId: string) {
    return this.request<{ generationId: string; fileUrl: string; reusedSnapshot: boolean }>(
      `/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/reprint`, { method: 'POST', body: '{}' });
  }
}
