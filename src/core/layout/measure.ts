import { displayText, type TemplateDocument } from '../../domain/model.ts';
import { a1 } from '../../domain/operations.ts';
import type { PageDefinition, ReportingErrorShape } from '../contracts/types.ts';

export const CSS_PX_PER_MM = 96 / 25.4;
const PAGE_MM: Record<string, { width: number; height: number }> = {
  A4: { width: 210, height: 297 }, A3: { width: 297, height: 420 },
  Letter: { width: 215.9, height: 279.4 }, Legal: { width: 215.9, height: 355.6 },
};

export interface LayoutImagePlacement { imageId: string; worksheetId: string; rect: { r: number; c: number; rows: number; cols: number } }
export interface FontMeasurer {
  supportedFonts: string[];
  /** Return one-line text width in CSS pixels. */
  measureWidth(text: string, fontFamily: string, fontSizePx: number): number;
}
export interface LayoutMeasurementOptions {
  fonts?: FontMeasurer;
  images?: LayoutImagePlacement[];
  sampleValues?: Record<string, string>;
  minScale?: number;
  maxScale?: number;
}
export interface LayoutDiagnostic extends ReportingErrorShape { context: NonNullable<ReportingErrorShape['context']> }
export interface WorksheetLayoutMeasurement {
  worksheetId: string; widthMm: number; heightMm: number; printableWidthMm: number; printableHeightMm: number;
  scale: number; missingFonts: string[]; warnings: string[]; diagnostics: LayoutDiagnostic[];
}

function defaultWidth(text: string, fontSizePx: number): number {
  let width = 0;
  for (const char of text) width += /[\u2e80-\u9fff\uff00-\uffef]/u.test(char) ? fontSizePx : fontSizePx * 0.56;
  return width;
}
export function estimatedTextWidthPx(text: string, fontSizePt = 11): number {
  return Math.max(...text.split(/\r?\n/).map(line => defaultWidth(line, fontSizePt * 96 / 72)));
}
function textLines(text: string, widthPx: number, measure: (line: string) => number, wrap: boolean): number {
  return text.split(/\r?\n/).reduce((count, paragraph) => {
    if (!wrap || widthPx <= 0) return count + 1;
    if (!paragraph) return count + 1;
    let lines = 1, current = 0;
    for (const char of paragraph) {
      const charWidth = measure(char);
      if (current > 0 && current + charWidth > widthPx) { lines++; current = charWidth; }
      else current += charWidth;
    }
    return count + lines;
  }, 0);
}
/** Shared deterministic sizing for flow records and layout diagnostics. */
export function requiredTextHeightPx(text: string, widthPx: number, fontSizePt = 11, wrap = true): number {
  const fontSizePx = fontSizePt * 96 / 72;
  return textLines(text, Math.max(1, widthPx - 4), line => defaultWidth(line, fontSizePx), wrap) * fontSizePx * 1.2 + 4;
}
function pageSize(page: PageDefinition) {
  if (page.paperSize === 'custom') {
    if (!page.customPaperMm || page.customPaperMm.width <= 0 || page.customPaperMm.height <= 0)
      throw new Error(`页面 ${page.label} 的自定义纸张尺寸无效`);
    const { width, height } = page.customPaperMm;
    return page.orientation === 'portrait'
      ? { width: Math.min(width, height), height: Math.max(width, height) }
      : { width: Math.max(width, height), height: Math.min(width, height) };
  }
  const size = PAGE_MM[page.paperSize];
  return page.orientation === 'portrait' ? size : { width: size.height, height: size.width };
}

/** Measures physical sheet geometry and reports deterministic, cell-addressable overflow. */
export function measureTemplateLayout(document: TemplateDocument, page: PageDefinition,
  worksheetId: string, options: LayoutMeasurementOptions = {}): WorksheetLayoutMeasurement {
  const errors: LayoutDiagnostic[] = [];
  const report = (message: string, context: LayoutDiagnostic['context']) => errors.push({
    code: 'LAYOUT_OVERFLOW', message, stage: 'layout', context,
  });
  const printRect = page.printableRect ?? { r: 0, c: 0, rows: document.rows, cols: document.cols };
  if (printRect.r + printRect.rows > document.rows || printRect.c + printRect.cols > document.cols)
    report('打印区域超出工作表范围', { worksheetId });
  const widthPx = document.colWidthPx.slice(printRect.c, printRect.c + printRect.cols).reduce((sum, value) => sum + value, 0);
  const heightPx = document.rowHeightPx.slice(printRect.r, printRect.r + printRect.rows).reduce((sum, value) => sum + value, 0);
  const widthMm = widthPx / CSS_PX_PER_MM, heightMm = heightPx / CSS_PX_PER_MM;
  const size = pageSize(page);
  const printableWidthMm = size.width - page.marginsMm.left - page.marginsMm.right;
  const printableHeightMm = size.height - page.marginsMm.top - page.marginsMm.bottom;
  if (printableWidthMm <= 0 || printableHeightMm <= 0)
    report('页边距占用已超过纸张尺寸', { worksheetId });
  const scale = Math.min(1, printableWidthMm / widthMm, printableHeightMm / heightMm);
  const minScale = options.minScale ?? 0.85, maxScale = options.maxScale ?? 1;
  if (scale < minScale || scale > maxScale) report(`工作表实际缩放 ${scale.toFixed(3)} 超出允许范围 ${minScale}–${maxScale}`, { worksheetId });

  const builtInFonts = ['Arial', 'Calibri', 'Times New Roman', 'SimSun', '宋体', 'Microsoft YaHei', '微软雅黑'];
  const supported = new Set((options.fonts?.supportedFonts ?? builtInFonts).map(font => font.toLocaleLowerCase()));
  const missingFonts = new Set<string>();
  const merged = (r: number, c: number) => document.merges.find(item => r >= item.r && r < item.r + item.rows && c >= item.c && c < item.c + item.cols);
  for (const [key, cell] of Object.entries(document.cells)) {
    const [r, c] = key.split(':').map(Number);
    if (r < printRect.r || r >= printRect.r + printRect.rows || c < printRect.c || c >= printRect.c + printRect.cols) continue;
    const merge = merged(r, c);
    if (merge && (merge.r !== r || merge.c !== c)) continue;
    const text = cell.binding
      ? options.sampleValues?.[cell.binding.path] ?? displayText(cell, document.syntax)
      : cell.text ?? '';
    if (!text) continue;
    const family = cell.style?.fontFamily ?? 'Arial';
    const fontSizePx = (cell.style?.fontSizePt ?? 11) * 96 / 72;
    if (!supported.has(family.toLocaleLowerCase())) missingFonts.add(family);
    const textWidthPx = merge
      ? document.colWidthPx.slice(merge.c, merge.c + merge.cols).reduce((sum, value) => sum + value, 0)
      : document.colWidthPx[c] ?? 0;
    const lineHeightPx = fontSizePx * 1.2;
    const requiredPx = textLines(text, textWidthPx, line => options.fonts
      ? options.fonts.measureWidth(line, family, fontSizePx) : defaultWidth(line, fontSizePx), cell.style?.wrap !== false) * lineHeightPx;
    const availablePx = merge
      ? document.rowHeightPx.slice(merge.r, merge.r + merge.rows).reduce((sum, value) => sum + value, 0)
      : document.rowHeightPx[r] ?? 0;
    if (requiredPx > availablePx + 0.5) report(`单元格文字高度 ${requiredPx.toFixed(1)}px 超过可用高度 ${availablePx.toFixed(1)}px`,
      { worksheetId, cell: a1(r, c) });
  }
  const images = options.images ?? (page.imagePlacements ?? []).map(image => ({ imageId: image.imageId, worksheetId: image.worksheetId, rect: image.rect }));
  for (const image of images) {
    if (image.worksheetId !== worksheetId) continue;
    const right = image.rect.c + image.rect.cols, bottom = image.rect.r + image.rect.rows;
    if (image.rect.r < printRect.r || image.rect.c < printRect.c || right > printRect.c + printRect.cols || bottom > printRect.r + printRect.rows)
      report(`图片 ${image.imageId} 超出打印区域`, { worksheetId, regionId: image.imageId });
  }
  return { worksheetId, widthMm, heightMm, printableWidthMm, printableHeightMm, scale,
    missingFonts: [...missingFonts].sort(),
    warnings: options.fonts ? [] : ['未接入字体测量适配器，当前使用字符宽度估算；请在目标办公软件中进行实印校准。'], diagnostics: errors };
}
