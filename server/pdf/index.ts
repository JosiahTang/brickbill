import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReportingError } from '../../src/core/contracts/errors.ts';
import type { TemplatePackage } from '../../src/core/contracts/types.ts';
import type { ProjectedDocumentPages } from '../../src/core/render/page.ts';
import { base64ToBytes, loadExcel } from '../../src/export/importExcel.ts';

export const PDF_MIME = 'application/pdf';
const RENDERER_VERSION = '4.4.9';
const RENDER_SCRIPT = fileURLToPath(new URL('./render.py', import.meta.url));

export interface PdfRuntimeOptions {
  pythonPath?: string;
  fallbackFont?: string;
  fontMap?: Record<string, string>;
  reportlabVersion?: string;
  minScale?: number;
  timeoutMs?: number;
}
export interface PdfOutput {
  bytes: Uint8Array;
  fileName: string;
  mediaType: typeof PDF_MIME;
  renderer: { name: 'ReportLab'; version: string; fontPaths: string[]; pageCount: number; scales: number[] };
}
function invalid(message: string, context?: Record<string, unknown>): never {
  throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'export', message, context });
}
function runtimeOptions(override: PdfRuntimeOptions): Required<PdfRuntimeOptions> {
  let envMap: Record<string, string> = {};
  if (process.env.REPORTING_PDF_FONT_MAP_JSON) {
    try { envMap = JSON.parse(process.env.REPORTING_PDF_FONT_MAP_JSON); }
    catch { invalid('REPORTING_PDF_FONT_MAP_JSON 必须是字体名到字体文件路径的 JSON 对象'); }
  }
  const result = {
    pythonPath: override.pythonPath ?? process.env.REPORTING_PDF_PYTHON ?? '',
    fallbackFont: override.fallbackFont ?? process.env.REPORTING_PDF_FALLBACK_FONT ?? '',
    fontMap: override.fontMap ?? envMap,
    reportlabVersion: override.reportlabVersion ?? process.env.REPORTING_PDF_REPORTLAB_VERSION ?? RENDERER_VERSION,
    minScale: override.minScale ?? Number(process.env.REPORTING_PDF_MIN_SCALE ?? 0.85),
    timeoutMs: override.timeoutMs ?? Number(process.env.REPORTING_PDF_TIMEOUT_MS ?? 90_000),
  };
  if (!result.pythonPath || !result.fallbackFont) invalid('PDF 渲染环境未配置：需要 REPORTING_PDF_PYTHON 和 REPORTING_PDF_FALLBACK_FONT');
  if (typeof result.fontMap !== 'object' || !result.fontMap || Array.isArray(result.fontMap)
    || Object.entries(result.fontMap).some(([key, value]) => !key || typeof value !== 'string' || !value))
    invalid('PDF 字体映射必须是字体名到文件路径的对象');
  if (!Number.isFinite(result.minScale) || result.minScale <= 0 || result.minScale > 1)
    invalid('PDF 最小缩放比例必须大于 0 且不超过 1');
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 1000 || result.timeoutMs > 300_000)
    invalid('PDF 渲染超时必须为 1000–300000 毫秒');
  return result;
}

async function sourceImages(template: TemplatePackage): Promise<Record<string, Array<{ imageId: string; rect: { r: number; c: number; rows: number; cols: number }; base64: string }>>> {
  if (!template.sourceWorkbook?.base64) return {};
  const workbook = await loadExcel(base64ToBytes(template.sourceWorkbook.base64));
  const result: Record<string, Array<{ imageId: string; rect: { r: number; c: number; rows: number; cols: number }; base64: string }>> = {};
  for (const worksheet of template.worksheets) {
    const sourceName = worksheet.document.excelSource?.sheetName ?? worksheet.name;
    const sheet = workbook.getWorksheet(sourceName);
    if (!sheet) continue;
    result[worksheet.worksheetId] = [];
    for (const image of sheet.getImages()) {
      const original = workbook.getImage(Number(image.imageId));
      const base64 = original.base64 ?? (original.buffer ? Buffer.from(original.buffer).toString('base64') : undefined);
      if (!base64) invalid(`原始 Excel 图片 ${image.imageId} 无法用于 PDF，请改为模板图片资源`, { worksheetId: worksheet.worksheetId });
      const tl = image.range.tl, br = image.range.br;
      if (!br) invalid(`原始 Excel 图片 ${image.imageId} 缺少右下角位置`, { worksheetId: worksheet.worksheetId });
      result[worksheet.worksheetId].push({ imageId: String(image.imageId), base64,
        rect: { r: tl.row, c: tl.col, rows: br.row - tl.row, cols: br.col - tl.col } });
    }
  }
  return result;
}

function runRenderer(python: string, input: string, output: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [RENDER_SCRIPT, input, output], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' } });
    let stdout = '', stderr = '', finished = false;
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-64_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64_000); });
    child.on('error', error => { if (!finished) { finished = true; clearTimeout(timer); reject(error); } });
    child.on('close', code => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const line = stderr.trim().split(/\r?\n/).at(-1);
        let parsed: { code?: string; message?: string; context?: Record<string, unknown> } | undefined;
        try { parsed = line ? JSON.parse(line) : undefined; } catch { /* keep a safe summary below */ }
        reject(new ReportingError({ code: parsed?.code === 'LAYOUT_OVERFLOW' ? 'LAYOUT_OVERFLOW'
          : parsed?.code === 'FIELD_NOT_FOUND' ? 'FIELD_NOT_FOUND' : 'CONTRACT_INVALID', stage: 'export',
          message: parsed?.message ?? `PDF 渲染进程失败或超时（退出码 ${code ?? 'unknown'}）`,
          context: { ...parsed?.context, exitCode: code, renderer: 'ReportLab' } }));
      }
    });
  });
}

/** Render the same immutable fixed-page projection used by XLSX and browser preview. */
export async function exportFixedPdf(template: TemplatePackage, projection: ProjectedDocumentPages,
  override: PdfRuntimeOptions = {}): Promise<PdfOutput> {
  if (projection.pagePlan.templateId !== template.packageId || projection.pagePlan.templateVersion !== template.revision)
    throw new ReportingError({ code: 'REVISION_CONFLICT', stage: 'export', message: 'PDF 页面投影与模板版本不匹配' });
  if (!projection.pages.length || projection.pages.length !== projection.pagePlan.totalPages)
    invalid('PDF 页面投影不完整');
  const pageDefinitions = new Map((template.pageDefinitions ?? []).map(page => [page.pageDefinitionId, page]));
  for (const page of projection.pages) {
    const definition = pageDefinitions.get(page.pageDefinitionId);
    if (!definition || definition.paginationMode === 'flow')
      invalid(`PDF 仅开放已验收的固定版式页面：${page.pageDefinitionId}`, { pageNumber: page.pageNumber });
  }
  const options = runtimeOptions(override);
  const temporary = await mkdtemp(join(tmpdir(), 'brickbill-pdf-'));
  try {
    const input = join(temporary, 'projection.json'), output = join(temporary, 'output.pdf');
    await writeFile(input, JSON.stringify({ title: template.name, pages: projection.pages, resources: projection.resources,
      sourceImages: await sourceImages(template), fallbackFont: options.fallbackFont, fontMap: options.fontMap,
      reportlabVersion: options.reportlabVersion, minScale: options.minScale }), 'utf8');
    const processResult = await runRenderer(options.pythonPath, input, output, options.timeoutMs);
    let metadata: { pageCount: number; reportlabVersion: string; fontPaths: string[]; pages: Array<{ scale: number }> };
    try { metadata = JSON.parse(processResult.stdout.trim().split(/\r?\n/).at(-1) ?? ''); }
    catch { invalid('PDF 渲染器没有返回可核验的页数与字体信息'); }
    const bytes = new Uint8Array(await readFile(output));
    if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-' || bytes.byteLength < 1024
      || metadata!.pageCount !== projection.pages.length || metadata!.pages.length !== projection.pages.length)
      invalid('PDF 输出签名或物理页数与逐页投影不一致');
    return { bytes, fileName: `${template.name.replace(/[\\/:*?"<>|]/g, '_')}-${projection.pagePlan.totalPages}p.pdf`, mediaType: PDF_MIME,
      renderer: { name: 'ReportLab', version: metadata!.reportlabVersion, fontPaths: metadata!.fontPaths,
        pageCount: metadata!.pageCount, scales: metadata!.pages.map(page => page.scale) } };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
