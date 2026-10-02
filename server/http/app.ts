import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ReportingService } from '../services/generate.ts';

export interface RequestAccess { projectIds: string[] }
export type ReportingAuthorizer = (request: IncomingMessage) => Promise<RequestAccess> | RequestAccess;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function bodyJson(request: IncomingMessage, limitBytes = 60 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limitBytes) throw Object.assign(new Error(`请求体超过 ${limitBytes} 字节限制`), { code: 'RESOURCE_LIMIT_EXCEEDED' });
    chunks.push(bytes);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求体必须是有效 JSON'), { code: 'CONTRACT_INVALID' }); }
}

function codeOf(error: any): string { return typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR'; }
function statusOf(code: string): number {
  if (code === 'DATA_NOT_FOUND') return 404;
  if (code === 'REVISION_CONFLICT' || code === 'DUPLICATE_KEY' || code === 'TEMPLATE_MATCH_AMBIGUOUS') return 409;
  if (code === 'RESOURCE_LIMIT_EXCEEDED') return 413;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'CONTRACT_INVALID') return 400;
  if (code === 'INTERNAL_ERROR') return 500;
  return 422;
}

function safeError(error: any): { code: string; message: string; stage?: string; context?: unknown } {
  const code = codeOf(error);
  if (code === 'INTERNAL_ERROR') return { code, message: '服务处理失败，请联系系统管理员' };
  return { code, message: error.message || '请求无法处理', ...(error.stage ? { stage: error.stage } : {}), ...(error.context ? { context: error.context } : {}) };
}

function pageFiles(projection: any, pageNumber: number): unknown {
  const sheets = projection.pages.filter((page: any) => page.pageNumber === pageNumber);
  if (!sheets.length) return undefined;
  return { pageNumber, totalPages: projection.pagePlan.totalPages,
    diagnostics: projection.pagePlan.pages[pageNumber - 1]?.diagnostics ?? [], sheets, resources: projection.resources ?? [] };
}
function snapshotInfo(snapshot: any): unknown {
  const { data: _data, viewResults: _viewResults, ...summary } = snapshot;
  const pagePlan = snapshot.pagePlan ? { ...snapshot.pagePlan,
    pages: snapshot.pagePlan.pages.map((page: any) => ({ pageNumber: page.pageNumber, pageType: page.pageType,
      pageDefinitionId: page.pageDefinitionId, worksheetIds: page.worksheetIds, diagnostics: page.diagnostics })) } : undefined;
  return { ...summary, pagePlan };
}

function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : `${version}.1`;
}

/** HTTP adapter for the reusable reporting pipeline. Project access is checked before every project-scoped read or write. */
export function createReportingHttpServer(service: ReportingService, authorize: ReportingAuthorizer): Server {
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    const allowedOrigins = (process.env.REPORTING_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
      .split(',').map(value => value.trim()).filter(Boolean);
    if (!origin) response.setHeader('access-control-allow-origin', '*');
    else if (allowedOrigins.includes(origin)) response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'origin');
    response.setHeader('access-control-allow-methods', 'GET,POST,PUT,OPTIONS');
    response.setHeader('access-control-allow-headers', 'content-type,authorization,x-idempotency-key');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    try {
      const access = await authorize(request);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
      if (parts[0] !== 'api') { json(response, 404, { error: { code: 'DATA_NOT_FOUND', message: '接口不存在' } }); return; }
      if (parts.length === 2 && parts[1] === 'projects' && request.method === 'GET') {
        const all = await service.listProjects();
        json(response, 200, all.filter((project: any) => access.projectIds.includes(project.projectId))); return;
      }
      if (parts.length < 4 || parts[1] !== 'projects') { json(response, 404, { error: { code: 'DATA_NOT_FOUND', message: '接口不存在' } }); return; }
      const projectId = parts[2];
      if (!access.projectIds.includes(projectId)) throw Object.assign(new Error('当前身份无权访问该项目'), { code: 'FORBIDDEN' });
      const context = service.project(projectId);
      const resource = parts[3];

      if (resource === 'catalog' && parts.length === 4 && request.method === 'GET') {
        json(response, 200, context.catalog); return;
      }
      if (resource === 'views' && parts.length === 4 && request.method === 'GET') {
        json(response, 200, await service.listViews(projectId)); return;
      }
      if (resource === 'views' && parts.length === 5 && parts[4] === 'preview' && request.method === 'POST') {
        json(response, 200, await service.previewViews(projectId, await bodyJson(request))); return;
      }
      if (resource === 'views' && parts.length >= 5) {
        const viewId = parts[4];
        if (parts.length === 6 && parts[5] === 'draft' && request.method === 'PUT') {
          const body = await bodyJson(request); const result = await service.saveViewDraft(projectId, viewId, body.definition, body.expectedRevision);
          json(response, 200, result); return;
        }
        if (parts.length === 6 && parts[5] === 'draft' && request.method === 'GET') {
          const draft = await service.views.getDraft(projectId, viewId); if (!draft) throw Object.assign(new Error('视图草稿不存在'), { code: 'DATA_NOT_FOUND' });
          json(response, 200, draft); return;
        }
        if (parts.length === 6 && parts[5] === 'publish' && request.method === 'POST') {
          const requested = (await bodyJson(request)).version;
          let version = requested;
          if (!version) { const latest = await service.views.latest(projectId, viewId); if (latest) version = nextPatchVersion(latest.version); }
          json(response, 201, await service.publishView(projectId, viewId, version)); return;
        }
        if (parts.length === 7 && parts[5] === 'versions' && request.method === 'GET') {
          const published = await service.views.getPublished(projectId, viewId, parts[6]);
          if (!published) throw Object.assign(new Error('视图版本不存在'), { code: 'DATA_NOT_FOUND' });
          json(response, 200, published); return;
        }
      }

      if (resource === 'templates' && parts.length >= 5) {
        const templateId = parts[4];
        if (parts.length === 6 && parts[5] === 'draft' && request.method === 'PUT') {
          const body = await bodyJson(request); const result = await service.saveTemplateDraft(projectId, templateId, body.template, body.expectedRevision);
          json(response, 200, result); return;
        }
        if (parts.length === 6 && parts[5] === 'draft' && request.method === 'GET') {
          const draft = await service.templates.getDraft(projectId, templateId); if (!draft) throw Object.assign(new Error('模板草稿不存在'), { code: 'DATA_NOT_FOUND' });
          json(response, 200, draft); return;
        }
        if (parts.length === 6 && parts[5] === 'versions' && request.method === 'GET') {
          json(response, 200, await service.templates.listVersions(projectId, templateId)); return;
        }
        if (parts.length === 7 && parts[5] === 'versions' && request.method === 'GET') {
          const record = await service.templates.getVersion(projectId, templateId, Number(parts[6]));
          if (!record) throw Object.assign(new Error('模板发布版本不存在'), { code: 'DATA_NOT_FOUND' });
          json(response, 200, record); return;
        }
        if (parts.length === 6 && parts[5] === 'publish' && request.method === 'POST') {
          json(response, 201, await service.publishTemplate(projectId, templateId)); return;
        }
        if (parts.length === 6 && parts[5] === 'disable' && request.method === 'POST') {
          await service.disableTemplate(projectId, templateId); json(response, 200, { projectId, templateId, disabled: true }); return;
        }
        if (parts.length === 7 && parts[5] === 'resources' && request.method === 'PUT') {
          const body = await bodyJson(request);
          if (!(await service.templates.getDraft(projectId, templateId))) throw Object.assign(new Error('模板草稿不存在'), { code: 'DATA_NOT_FOUND' });
          json(response, 201, await service.resources.put(projectId, parts[6], body.mediaType, body.base64)); return;
        }
        if (parts.length === 7 && parts[5] === 'resources' && request.method === 'GET') {
          const value = await service.resources.get(projectId, parts[6]); if (!value) throw Object.assign(new Error('模板资源不存在'), { code: 'DATA_NOT_FOUND' });
          json(response, 200, value); return;
        }
        if (parts.length === 8 && parts[5] === 'versions' && parts[7] === 'match-rule' && request.method === 'PUT') {
          const version = Number(parts[6]);
          json(response, 200, await service.setTemplateMatchRule(projectId, templateId, version, await bodyJson(request))); return;
        }
        if (parts.length === 8 && parts[5] === 'versions' && parts[7] === 'match-rule' && request.method === 'GET') {
          const value = await service.templates.getMatchRule(projectId, templateId, Number(parts[6]));
          if (!value) throw Object.assign(new Error('模板自动匹配规则不存在'), { code: 'DATA_NOT_FOUND' });
          json(response, 200, value); return;
        }
      }

      if (resource === 'generations' && parts.length === 4 && request.method === 'POST') {
        const body = await bodyJson(request);
        if (!['preview', 'issue'].includes(body.mode) || typeof body.documentType !== 'string' || !body.businessKey || typeof body.businessKey !== 'object')
          throw Object.assign(new Error('生成请求需要指定 mode、documentType 和 businessKey'), { code: 'CONTRACT_INVALID' });
        const headerKey = request.headers['x-idempotency-key'];
        const generation = await service.generate(projectId, { ...body,
          idempotencyKey: body.idempotencyKey ?? (typeof headerKey === 'string' ? headerKey : undefined),
          pageDefinitionId: body.pageDefinitionId,
        });
        json(response, 201, { generationId: generation.snapshot.generationId, projectId, mode: generation.mode,
          status: 'complete', pageCount: generation.snapshot.pagePlan?.totalPages ?? 0, snapshot: snapshotInfo(generation.snapshot),
          fileUrl: `/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generation.snapshot.generationId)}/file`,
          ...(await service.pdfAvailable(projectId, generation) ? { pdfUrl: `/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generation.snapshot.generationId)}/file.pdf` } : {}) }); return;
      }
      if (resource === 'generations' && parts.length >= 5) {
        const generationId = parts[4];
        if (parts.length === 5 && request.method === 'GET') {
          const generation = await service.generation(projectId, generationId); if (!generation) throw Object.assign(new Error('生成记录不存在'), { code: 'DATA_NOT_FOUND' });
          json(response, 200, { generationId, projectId, mode: generation.mode, status: 'complete',
            pageCount: generation.snapshot.pagePlan?.totalPages ?? 0, snapshot: snapshotInfo(generation.snapshot),
            fileUrl: `/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/file`,
            ...(await service.pdfAvailable(projectId, generation) ? { pdfUrl: `/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/file.pdf` } : {}) }); return;
        }
        if (parts.length === 7 && parts[5] === 'pages' && request.method === 'GET') {
          const generation = await service.generation(projectId, generationId); if (!generation) throw Object.assign(new Error('生成记录不存在'), { code: 'DATA_NOT_FOUND' });
          const pageNumber = Number(parts[6]);
          const content = Number.isInteger(pageNumber) && pageNumber > 0 ? pageFiles(generation.projection as any, pageNumber) : undefined;
          if (!content) throw Object.assign(new Error(`页面不存在：${parts[6]}`), { code: 'DATA_NOT_FOUND' });
          json(response, 200, content); return;
        }
        if (parts.length === 6 && parts[5] === 'file' && request.method === 'GET') {
          const generation = await service.generation(projectId, generationId); const bytes = await service.snapshots.readFile(projectId, generationId);
          if (!generation || !bytes) throw Object.assign(new Error('生成文件不存在'), { code: 'DATA_NOT_FOUND' });
          const name = encodeURIComponent(generation.snapshot.output?.fileName ?? `${generationId}.xlsx`);
          response.writeHead(200, { 'content-type': generation.snapshot.output?.mediaType ?? 'application/octet-stream',
            'content-disposition': `attachment; filename*=UTF-8''${name}`, 'content-length': bytes.byteLength, 'cache-control': 'no-store' });
          response.end(Buffer.from(bytes)); return;
        }
        if (parts.length === 6 && parts[5] === 'file.pdf' && request.method === 'GET') {
          const artifact = await service.pdf(projectId, generationId);
          const name = encodeURIComponent(artifact.fileName);
          response.writeHead(200, { 'content-type': artifact.mediaType,
            'content-disposition': `attachment; filename*=UTF-8''${name}`, 'content-length': artifact.byteLength,
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          response.end(Buffer.from(artifact.bytes)); return;
        }
        if (parts.length === 6 && parts[5] === 'reprint' && request.method === 'POST') {
          const generation = await service.reprint(projectId, generationId);
          json(response, 200, { generationId, projectId, status: 'complete', pageCount: generation.snapshot.pagePlan?.totalPages ?? 0,
            fileUrl: `/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/file`, reusedSnapshot: true }); return;
        }
      }
      json(response, 404, { error: { code: 'DATA_NOT_FOUND', message: '接口不存在' } });
    } catch (error) {
      const responseError = safeError(error);
      json(response, statusOf(responseError.code), { error: responseError });
    }
  });
  return server;
}

export function loopbackAuthorizer(tokensJson = process.env.REPORTING_TOKENS_JSON, localProjectIds: string[] = []): ReportingAuthorizer {
  const configured = tokensJson ? JSON.parse(tokensJson) as Record<string, string[]> : undefined;
  return request => {
    if (configured) {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      return { projectIds: token ? configured[token] ?? [] : [] };
    }
    const address = request.socket.remoteAddress ?? '';
    const local = address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
    return { projectIds: local ? localProjectIds : [] };
  };
}
