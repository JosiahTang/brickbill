import ExcelJS from 'exceljs';
import { copy, displayText, type Cell } from '../domain/model.ts';
import { anchor, a1, renderCells, validateDocument } from '../domain/operations.ts';
import { ReportingError } from '../core/contracts/errors.ts';
import type { ErrorContext, TemplatePackage } from '../core/contracts/types.ts';
import type { ProjectedDocumentPages, ProjectedSheetPage } from '../core/render/page.ts';
import { base64ToBytes, loadExcel } from './importExcel.ts';
import { excelStyle, pxToExcelWidth, XLSX_MIME } from './excel.ts';

export interface PagedXlsxResult {
  bytes: Uint8Array;
  mediaType: typeof XLSX_MIME;
  fileName: string;
  sheetNames: string[];
}

function fail(message: string, context: ErrorContext = {}): never {
  throw new ReportingError({ code: 'UNSUPPORTED_FORMULA_LAYOUT', stage: 'export', message, context });
}

function safeSheetName(page: ProjectedSheetPage, index: number, seen: Set<string>): string {
  const suffix = `_${String(index + 1).padStart(3, '0')}`;
  const source = page.document.sheetName.replace(/[\\/?*:[\]]/g, '_').trim() || 'Page';
  let name = `${source.slice(0, 31 - suffix.length)}${suffix}`;
  let attempt = 1;
  while (seen.has(name.toLocaleLowerCase())) {
    const extra = `_${attempt++}`;
    name = `${source.slice(0, 31 - suffix.length - extra.length)}${suffix}${extra}`;
  }
  seen.add(name.toLocaleLowerCase());
  return name;
}

function formulaIn(value: unknown): boolean {
  return !!value && typeof value === 'object'
    && ('formula' in value || 'sharedFormula' in value || 'ref' in value && 'shareType' in value);
}

function scalarValue(cell: Cell, syntax: ProjectedSheetPage['document']['syntax'], context: ErrorContext): ExcelJS.CellValue {
  if (cell.binding) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'export',
    message: `字段绑定未解析：${cell.binding.path}`, context: { ...context, fieldId: cell.binding.fieldId, sourcePath: cell.binding.path } });
  const value = cell.excelValue;
  if (formulaIn(value)) fail('模板包含公式，当前页面结构变化后无法安全重定位公式', context);
  if (value && typeof value === 'object' && 'date' in value) return new Date(String(value.date));
  return value !== undefined ? copy(value) as ExcelJS.CellValue : displayText(cell, syntax);
}

function paperCode(page: ProjectedSheetPage): number | undefined {
  const codes: Record<string, number> = { A4: 9, A3: 8, Letter: 1, Legal: 5 };
  return codes[page.pageSetup.paperSize];
}

function configurePrint(sheet: ExcelJS.Worksheet, page: ProjectedSheetPage): void {
  const { pageSetup, document } = page;
  const lastRow = Math.max(0, document.rows - 1), lastCol = Math.max(0, document.cols - 1);
  const area = pageSetup.printableRect;
  const printArea = area
    ? `${a1(area.r, area.c)}:${a1(area.r + area.rows - 1, area.c + area.cols - 1)}`
    : `A1:${a1(lastRow, lastCol)}`;
  const headers = [...new Set(pageSetup.repeatHeaderRows ?? [])].sort((a, b) => a - b);
  const contiguousHeaders = headers.length && headers.every((row, index) => row === headers[0] + index);
  sheet.pageSetup = {
    paperSize: paperCode(page),
    orientation: pageSetup.orientation,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 1,
    margins: {
      left: pageSetup.marginsMm.left / 25.4,
      right: pageSetup.marginsMm.right / 25.4,
      top: pageSetup.marginsMm.top / 25.4,
      bottom: pageSetup.marginsMm.bottom / 25.4,
      header: 0.2,
      footer: 0.2,
    },
    ...(contiguousHeaders ? { printTitlesRow: `${headers[0] + 1}:${headers[headers.length - 1] + 1}` } : {}),
  };
  sheet.pageSetup.printArea = printArea;
  // ExcelJS does not expose custom paper dimensions. Leaving paperSize unset lets
  // the consuming Office installation apply its configured custom paper size.
}

function addPlacedImages(workbook: ExcelJS.Workbook, sheet: ExcelJS.Worksheet,
  page: ProjectedSheetPage, template: TemplatePackage): void {
  const resources = new Map((template.resources ?? []).map(resource => [resource.resourceId, resource]));
  for (const placement of page.imagePlacements) {
    const resource = resources.get(placement.resourceId);
    if (!resource) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'export',
      message: `图片资源不存在：${placement.resourceId}`, context: { worksheetId: page.worksheetId, fieldId: placement.imageId } });
    const extension = resource.mediaType.split('/')[1];
    if (!extension || !['png', 'jpeg', 'gif'].includes(extension))
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'export', message: `Excel 不支持该图片类型：${resource.mediaType}`, context: { fieldId: placement.imageId } });
    const imageId = workbook.addImage({ base64: resource.base64, extension: extension as 'png' | 'jpeg' | 'gif' });
    const { r, c, rows, cols } = placement.rect;
    const anchor = (col: number, row: number) => ({ col, row, nativeCol: Math.floor(col), nativeRow: Math.floor(row), nativeColOff: 0, nativeRowOff: 0 });
    sheet.addImage(imageId, { tl: anchor(c, r) as unknown as ExcelJS.ImageRange['tl'], br: anchor(c + cols, r + rows) as unknown as ExcelJS.ImageRange['br'] });
  }
}

function copySourceImages(source: ExcelJS.Workbook | undefined, targetWorkbook: ExcelJS.Workbook,
  targetSheet: ExcelJS.Worksheet, page: ProjectedSheetPage, template: TemplatePackage): void {
  if (!source || page.imagePlacements.length) return;
  const sourceName = template.worksheets.find(item => item.worksheetId === page.worksheetId)?.document.excelSource?.sheetName
    ?? template.worksheets.find(item => item.worksheetId === page.worksheetId)?.name;
  const sourceSheet = sourceName ? source.getWorksheet(sourceName) : undefined;
  if (!sourceSheet) return;
  for (const image of sourceSheet.getImages()) {
    const original = source.getImage(Number(image.imageId));
    const newImageId = targetWorkbook.addImage({
      ...(original.base64 ? { base64: original.base64 } : {}),
      ...(original.buffer ? { buffer: original.buffer } : {}),
      ...(original.filename ? { filename: original.filename } : {}),
      extension: original.extension,
    });
    targetSheet.addImage(newImageId, structuredClone(image.range));
  }
}

function renderPage(sheet: ExcelJS.Worksheet, page: ProjectedSheetPage, pageIndex: number): void {
  const document = page.document;
  validateDocument(document);
  for (const merge of document.merges) sheet.mergeCells(merge.r + 1, merge.c + 1, merge.r + merge.rows, merge.c + merge.cols);
  document.rowHeightPx.forEach((px, row) => { sheet.getRow(row + 1).height = px * 72 / 96; });
  document.colWidthPx.forEach((px, col) => { sheet.getColumn(col + 1).width = pxToExcelWidth(px); });
  const rendered = renderCells(document);
  for (const [address, source] of Object.entries(rendered)) {
    const [row, col] = address.split(':').map(Number);
    const target = sheet.getCell(row + 1, col + 1);
    const [anchorRow, anchorCol] = anchor(document, row, col);
    if (anchorRow === row && anchorCol === col) target.value = scalarValue(source, document.syntax, {
      pageNumber: page.pageNumber, worksheetId: page.worksheetId, cell: a1(row, col),
    });
    target.style = excelStyle(source);
  }
  configurePrint(sheet, page);
}

function normalized(value: unknown): unknown {
  if (value instanceof Date) return { date: value.getTime() };
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalized(item)]));
  return value;
}

async function verifyPagedOutput(bytes: Uint8Array, template: TemplatePackage, projection: ProjectedDocumentPages,
  sheetNames: string[], original?: ExcelJS.Workbook): Promise<void> {
  const reopened = await loadExcel(bytes);
  if (reopened.worksheets.length !== projection.pages.length)
    throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'export', message: 'XLSX 回读校验失败：输出工作表数量与分页投影不一致' });
  for (let index = 0; index < projection.pages.length; index++) {
    const page = projection.pages[index], sheet = reopened.worksheets[index];
    const context = { pageNumber: page.pageNumber, worksheetId: page.worksheetId };
    if (sheet.name !== sheetNames[index] || sheet.state !== 'visible')
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'export', message: 'XLSX 回读校验失败：页面名称、顺序或可见状态不正确', context });
    const expectedMerges = page.document.merges.map(merge => `${a1(merge.r, merge.c)}:${a1(merge.r + merge.rows - 1, merge.c + merge.cols - 1)}`).sort();
    const actualMerges = [...(sheet.model.merges ?? [])].sort();
    if (JSON.stringify(expectedMerges) !== JSON.stringify(actualMerges))
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'export', message: 'XLSX 回读校验失败：合并单元格与页面投影不一致', context });
    for (const [address, cell] of Object.entries(renderCells(page.document))) {
      const [row, col] = address.split(':').map(Number), [anchorRow, anchorCol] = anchor(page.document, row, col);
      if (anchorRow !== row || anchorCol !== col) continue;
      const expected = scalarValue(cell, page.document.syntax, { ...context, cell: a1(row, col) });
      const actual = sheet.getCell(row + 1, col + 1).value;
      if (JSON.stringify(normalized(actual)) !== JSON.stringify(normalized(expected)))
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'export', message: `XLSX 回读校验失败：单元格 ${a1(row, col)} 的值与页面投影不一致`, context: { ...context, cell: a1(row, col) } });
    }
    const rect = page.pageSetup.printableRect;
    const expectedPrintArea = rect ? `${a1(rect.r, rect.c)}:${a1(rect.r + rect.rows - 1, rect.c + rect.cols - 1)}`
      : `A1:${a1(Math.max(0, page.document.rows - 1), Math.max(0, page.document.cols - 1))}`;
    if (sheet.pageSetup.printArea !== expectedPrintArea)
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'export', message: 'XLSX 回读校验失败：打印区域不正确', context });
    const sourceName = template.worksheets.find(item => item.worksheetId === page.worksheetId)?.document.excelSource?.sheetName
      ?? template.worksheets.find(item => item.worksheetId === page.worksheetId)?.name;
    const nativeCount = !page.imagePlacements.length && sourceName ? original?.getWorksheet(sourceName)?.getImages().length ?? 0 : 0;
    const actualImages = sheet.getImages();
    if (actualImages.length !== page.imagePlacements.length + nativeCount)
      throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'export', message: 'XLSX 回读校验失败：图片数量与模板配置不一致', context });
    const expectedAnchors = page.imagePlacements.length ? page.imagePlacements.map(image => ({
      tl: { col: image.rect.c, row: image.rect.r }, br: { col: image.rect.c + image.rect.cols, row: image.rect.r + image.rect.rows },
    })) : sourceName ? original?.getWorksheet(sourceName)?.getImages().map(image => image.range) ?? [] : [];
    expectedAnchors.forEach((expected, imageIndex) => {
      const actual = actualImages[imageIndex]?.range;
      if (!actual || Math.abs(actual.tl.col - expected.tl.col) > 0.001 || Math.abs(actual.tl.row - expected.tl.row) > 0.001
        || Math.abs(actual.br.col - expected.br.col) > 0.001 || Math.abs(actual.br.row - expected.br.row) > 0.001)
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'export', message: `XLSX 回读校验失败：图片 ${imageIndex + 1} 的锚点位置不正确`, context });
    });
    page.document.rowHeightPx.forEach((height, row) => {
      if (Math.abs((sheet.getRow(row + 1).height ?? 0) - height * 72 / 96) > 0.1)
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'export', message: `XLSX 回读校验失败：第 ${row + 1} 行高度不一致`, context: { ...context, cell: `A${row + 1}` } });
    });
    page.document.colWidthPx.forEach((width, col) => {
      if (Math.abs((sheet.getColumn(col + 1).width ?? 0) - pxToExcelWidth(width)) > 0.01)
        throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'export', message: `XLSX 回读校验失败：第 ${col + 1} 列宽度不一致`, context: { ...context, cell: a1(0, col) } });
    });
  }
}

/** Exports the same fixed page projection used by preview as one physical XLSX sheet per page. */
export async function exportPagedXlsx(template: TemplatePackage, projection: ProjectedDocumentPages,
  fileName = `${template.name || 'report'}.xlsx`): Promise<PagedXlsxResult> {
  if (projection.pagePlan.templateId !== template.packageId || projection.pagePlan.templateVersion !== template.revision)
    throw new ReportingError({ code: 'REVISION_CONFLICT', stage: 'export', message: '页面投影与模板包版本不匹配' });
  if (projection.pages.length !== projection.pagePlan.totalPages || !projection.pages.length)
    throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'export', message: '页面投影页数不完整' });
  const original = template.sourceWorkbook?.base64 ? await loadExcel(base64ToBytes(template.sourceWorkbook.base64)) : undefined;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Brickbill Reporting';
  workbook.subject = `Paged output for ${template.packageId}@${template.revision}`;
  const names = new Set<string>(), sheetNames: string[] = [];
  projection.pages.forEach((page, index) => {
    const sheet = workbook.addWorksheet(safeSheetName(page, index, names), { views: [{ showGridLines: false }] });
    sheet.state = 'visible';
    renderPage(sheet, page, index + 1);
    copySourceImages(original, workbook, sheet, page, template);
    addPlacedImages(workbook, sheet, page, template);
    sheetNames.push(sheet.name);
  });
  const raw = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(raw.byteLength); bytes.set(new Uint8Array(raw));
  await verifyPagedOutput(bytes, template, projection, sheetNames, original);
  return { bytes, mediaType: XLSX_MIME, fileName, sheetNames };
}
