import { randomUUID, createHash } from 'node:crypto';
import { requireSmokeGenerationId } from './compose-smoke-result.mjs';
import { verifyGenerationDependencies } from './deployment-dependencies.mjs';
import { buildExampleTemplate } from '../examples/projects/quality-templates.ts';
import { dalipuTemplates } from '../examples/projects/dalipu/index.ts';

const baseUrl = (process.env.BRICKBILL_SMOKE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const token = process.env.BRICKBILL_SMOKE_TOKEN;
if (!token) throw new Error('BRICKBILL_SMOKE_TOKEN 未设置');

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new Error(`${path}: HTTP ${response.status}, ${body?.error?.code ?? 'unknown'}: ${body?.error?.message ?? ''}`);
  }
  return response;
}
async function json(path, method, body) {
  return (await request(path, { method, body: JSON.stringify(body) })).json();
}
async function pdfEvidence(root) {
  const pdf = new Uint8Array(await (await request(`${root}/file.pdf`)).arrayBuffer());
  if (Buffer.from(pdf.subarray(0, 5)).toString('ascii') !== '%PDF-') throw new Error('PDF 文件签名错误');
  return { pdfAvailable: true, pdfSha256: createHash('sha256').update(pdf).digest('hex'),
    pdfByteLength: pdf.byteLength };
}
async function verifyGeneration(projectId, generationId) {
  const root = `/api/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}`;
  const generation = await (await request(root)).json();
  if (generation.status !== 'complete' || generation.pageCount < 1) throw new Error('生成状态或页数异常');
  const dependencies = await verifyGenerationDependencies(projectId, generation.snapshot, async path =>
    (await request(path)).json());
  const original = new Uint8Array(await (await request(`${root}/file`)).arrayBuffer());
  if (Buffer.from(original.subarray(0, 2)).toString('ascii') !== 'PK') throw new Error('XLSX 文件签名错误');
  const actualHash = createHash('sha256').update(original).digest('hex');
  if (actualHash !== generation.snapshot.output.sha256) throw new Error('XLSX 快照哈希不一致');
  let originalPdf;
  if (process.env.BRICKBILL_SMOKE_EXPECT_PDF === '1') {
    if (!generation.pdfUrl) throw new Error('PDF 项目开关或渲染环境未生效');
    originalPdf = await pdfEvidence(root);
  }
  const reprint = await json(`${root}/reprint`, 'POST', {});
  if (!reprint.reusedSnapshot) throw new Error('重印没有复用快照');
  const repeated = new Uint8Array(await (await request(`${root}/file`)).arrayBuffer());
  if (!Buffer.from(repeated).equals(Buffer.from(original))) throw new Error('重印文件发生变化');
  if (originalPdf) {
    const repeatedPdf = await pdfEvidence(root);
    if (originalPdf.pdfSha256 !== repeatedPdf.pdfSha256 || originalPdf.pdfByteLength !== repeatedPdf.pdfByteLength)
      throw new Error('重印 PDF 文件摘要或字节数发生变化');
  }
  return { projectId, generationId, pageCount: generation.pageCount, sha256: actualHash,
    dependencySha256: dependencies.sha256, dependencyCount: dependencies.viewCount + dependencies.functionCount + dependencies.resourceCount,
    pdfAvailable: !!originalPdf, ...originalPdf };
}

const health = await (await request('/api/health')).json();
if (health.status !== 'ok') throw new Error('后台健康检查未通过');
const projects = await (await request('/api/projects')).json();
const projectId = process.env.BRICKBILL_SMOKE_PROJECT ?? 'dalipu-demo';
if (!projects.some(project => project.projectId === projectId)) throw new Error(`身份无权访问项目 ${projectId}`);

let generationId = process.env.BRICKBILL_SMOKE_GENERATION_ID;
if (!generationId && process.env.BRICKBILL_SMOKE_CREATE_DEMO === '1') {
  if (projectId !== 'dalipu-demo') throw new Error('自动创建合成模板只支持 dalipu-demo');
  const spec = dalipuTemplates[0];
  const templateRoot = `/api/projects/${encodeURIComponent(projectId)}/templates/${encodeURIComponent(spec.templateId)}`;
  const versions = await (await request(`${templateRoot}/versions`)).json();
  let version = versions.at(-1)?.version;
  if (!version) {
    const template = await buildExampleTemplate(spec);
    let revision = 0;
    const draftResponse = await fetch(`${baseUrl}${templateRoot}/draft`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (draftResponse.ok) revision = (await draftResponse.json()).revision;
    else if (draftResponse.status !== 404) throw new Error(`草稿读取失败：HTTP ${draftResponse.status}`);
    await json(`${templateRoot}/draft`, 'PUT', { template, expectedRevision: revision });
    version = (await json(`${templateRoot}/publish`, 'POST', {})).version;
  }
  const generation = await json(`/api/projects/${projectId}/generations`, 'POST', {
    mode: 'preview', documentType: 'qualityCertificate',
    businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' },
    templateRef: { id: spec.templateId, version }, idempotencyKey: `deployment-smoke-${randomUUID()}`,
  });
  generationId = generation.generationId;
}
const result = generationId ? await verifyGeneration(projectId, generationId)
  : { status: 'healthy', projects: projects.map(project => project.projectId) };
requireSmokeGenerationId(generationId, process.env.BRICKBILL_SMOKE_REQUIRE_GENERATION === '1');
console.log(JSON.stringify(result));
