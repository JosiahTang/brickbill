import ExcelJS from 'exceljs';
import { copy, displayText, numberFormat, type Cell, type TemplateDocument } from '../domain/model.ts';
import { anchor, a1, renderCells, validateDocument } from '../domain/operations.ts';
import { base64ToBytes, loadExcel, METADATA_MARKER, METADATA_SHEET } from './importExcel.ts';
import { PACKAGE_METADATA_MARKER } from './importExcel.ts';
import type { TemplatePackage } from '../core/contracts/types.ts';
import { validateTemplatePackage } from '../core/templates/package.ts';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const argb = (color: string) => 'FF' + color.slice(1).toUpperCase();
export function excelStyle(cell: Cell): Partial<ExcelJS.Style> {
  const s = cell.excelStyle ? cell.styleEdits ?? {} : cell.style ?? {};
  const border: Partial<ExcelJS.Borders> = {};
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const edge = s.borders?.[side];
    if (edge) border[side] = { style: edge.style, color: { argb: argb(edge.color) } };
  }
  const normalized: Partial<ExcelJS.Style> = {
    font: { name: s.fontFamily ?? 'Arial', size: s.fontSizePt ?? 11,
      bold: s.bold ?? false, color: { argb: argb(s.color ?? '#1F2937') } },
    alignment: { horizontal: s.horizontal ?? 'left', vertical: s.vertical ?? 'middle', wrapText: s.wrap ?? true },
    fill: s.background
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(s.background) } }
      : { type: 'pattern', pattern: 'none' },
    border, numFmt: numberFormat(cell),
  };
  if (!cell.excelStyle) return normalized;
  const original = copy(cell.excelStyle) as Partial<ExcelJS.Style>;
  const font = { ...original.font };
  if (s.fontFamily !== undefined) font.name = s.fontFamily;
  if (s.fontSizePt !== undefined) font.size = s.fontSizePt;
  if (s.bold !== undefined) font.bold = s.bold;
  if (s.color !== undefined) font.color = { argb: argb(s.color) };
  const alignment = { ...original.alignment };
  if (s.horizontal !== undefined) alignment.horizontal = s.horizontal;
  if (s.vertical !== undefined) alignment.vertical = s.vertical;
  if (s.wrap !== undefined) alignment.wrapText = s.wrap;
  return { ...original, font, alignment, numFmt: numberFormat(cell),
    ...(s.background !== undefined ? { fill: normalized.fill } : {}),
    ...(s.borders !== undefined ? { border } : {}) };
}
// Excel column widths are character-based, NOT pixels. This is a configurable
// approximation, using an assumed maximum digit width (MDW); calibrate for the
// selected workbook font and target Excel/Office runtime before pixel-accurate use.
export function pxToExcelWidth(px: number, mdw = 7): number {
  if (!Number.isFinite(mdw) || mdw <= 0) throw new Error('非法 MDW');
  return Math.max(0, Math.round(((px - 5) / mdw) * 256) / 256);
}
export async function exportTemplate(doc: TemplateDocument, options: { embed?: boolean; rowMap?: number[] } = {}): Promise<Uint8Array> {
  validateDocument(doc);
  const workbook = doc.excelSource?.base64 ? await loadExcel(base64ToBytes(doc.excelSource.base64)) : new ExcelJS.Workbook();
  const oldMeta = workbook.getWorksheet(METADATA_SHEET); if (oldMeta) workbook.removeWorksheet(oldMeta.id);
  workbook.creator = 'Web Template Designer';
  const existing = doc.excelSource ? workbook.getWorksheet(doc.excelSource.sheetName) : undefined;
  const sheet = existing ?? workbook.addWorksheet(doc.sheetName, {
    views: [{ showGridLines: false }],
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.name = doc.sheetName;
  if (existing) {
    for (const merge of [...(sheet.model.merges ?? [])]) sheet.unMergeCells(merge);
    sheet.eachRow({ includeEmpty: true }, row => row.eachCell({ includeEmpty: true }, cell => { cell.value = null; cell.style = {}; }));
  }
  if (options.rowMap) {
    const moveRow = (r: number) => {
      const exact = options.rowMap![Math.floor(r)];
      if (exact >= 0) return exact + r % 1;
      for (let i = Math.floor(r) + 1; i < options.rowMap!.length; i++) if (options.rowMap![i] >= 0) return options.rowMap![i];
      return doc.rows;
    };
    for (const image of sheet.getImages()) {
      image.range.tl.nativeRow = Math.floor(moveRow(image.range.tl.nativeRow));
      if (image.range.br) image.range.br.nativeRow = Math.floor(moveRow(image.range.br.nativeRow));
    }
  }
  doc.rowHeightPx.forEach((px, r) => { sheet.getRow(r + 1).height = px * 72 / 96; });
  doc.colWidthPx.forEach((px, c) => { sheet.getColumn(c + 1).width = pxToExcelWidth(px); });

  // Merge first, then assign a NEW style object for each cell to avoid style sharing.
  for (const m of doc.merges)
    sheet.mergeCells(m.r + 1, m.c + 1, m.r + m.rows, m.c + m.cols);
  const cells = renderCells(doc);
  let lastRow = 0, lastCol = 0;
  for (const [key, source] of Object.entries(cells)) {
    const [r, c] = key.split(':').map(Number);
    const target = sheet.getCell(r + 1, c + 1);
    const [ar, ac] = anchor(doc, r, c);
    if (ar === r && ac === c) {
      // Assigning a string is NOT the same as assigning { formula: ... }.
      // Placeholder text and even literal '=...' are serialized as strings.
      const value = source.excelValue;
      target.value = source.binding ? displayText(source, doc.syntax)
        : value && typeof value === 'object' && 'date' in value ? new Date(String(value.date))
        : value !== undefined ? copy(value) as ExcelJS.CellValue : displayText(source, doc.syntax);
    }
    target.style = excelStyle(source);
    lastRow = Math.max(lastRow, r); lastCol = Math.max(lastCol, c);
  }
  if (!existing || options.rowMap) sheet.pageSetup.printArea = `A1:${a1(lastRow, lastCol)}`;
  if (options.embed !== false) {
    const meta = workbook.addWorksheet(METADATA_SHEET, { state: 'veryHidden' });
    meta.getCell('A1').value = METADATA_MARKER;
    const saved = copy(doc);
    if (saved.excelSource) saved.excelSource.base64 = '';
    const json = JSON.stringify(saved);
    for (let i = 0; i < json.length; i += 30000) meta.getCell(Math.floor(i / 30000) + 2, 1).value = json.slice(i, i + 30000);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  // Copy into an owned ArrayBuffer; avoids Buffer/SharedArrayBuffer BlobPart typing issues.
  const bytes = new Uint8Array(buffer.byteLength); bytes.set(new Uint8Array(buffer));
  return bytes;
}

export async function exportTemplatePackage(template: TemplatePackage): Promise<Uint8Array> {
  validateTemplatePackage(template);
  const workbook = template.sourceWorkbook?.base64
    ? await loadExcel(base64ToBytes(template.sourceWorkbook.base64)) : new ExcelJS.Workbook();
  const oldMeta = workbook.getWorksheet(METADATA_SHEET);
  if (oldMeta) workbook.removeWorksheet(oldMeta.id);
  workbook.creator = 'Web Template Designer';
  const packageSheetIds = new Set(template.worksheets.map(item => item.worksheetId));
  const created = new Map<string, ExcelJS.Worksheet>();

  for (const item of template.worksheets) {
    const doc = item.document;
    validateDocument(doc);
    let sheet = doc.excelSource?.sheetName ? workbook.getWorksheet(doc.excelSource.sheetName) : undefined;
    sheet ??= workbook.getWorksheet(item.name);
    if (!sheet) sheet = workbook.addWorksheet(item.name);
    else {
      for (const merge of [...(sheet.model.merges ?? [])]) sheet.unMergeCells(merge);
      sheet.eachRow({ includeEmpty: true }, row => row.eachCell({ includeEmpty: true }, cell => { cell.value = null; cell.style = {}; }));
      sheet.name = item.name;
    }
    sheet.state = item.visible ? 'visible' : 'hidden';
    doc.rowHeightPx.forEach((px, r) => { sheet!.getRow(r + 1).height = px * 72 / 96; });
    doc.colWidthPx.forEach((px, c) => { sheet!.getColumn(c + 1).width = pxToExcelWidth(px); });
    for (const merge of doc.merges) sheet.mergeCells(merge.r + 1, merge.c + 1, merge.r + merge.rows, merge.c + merge.cols);
    let lastRow = 0, lastCol = 0;
    for (const [key, source] of Object.entries(renderCells(doc))) {
      const [r, c] = key.split(':').map(Number);
      const target = sheet.getCell(r + 1, c + 1);
      const [ar, ac] = anchor(doc, r, c);
      if (ar === r && ac === c) {
        const value = source.excelValue;
        target.value = source.binding ? displayText(source, doc.syntax)
          : value && typeof value === 'object' && 'date' in value ? new Date(String(value.date))
          : value !== undefined ? copy(value) as ExcelJS.CellValue : displayText(source, doc.syntax);
      }
      target.style = excelStyle(source);
      lastRow = Math.max(lastRow, r); lastCol = Math.max(lastCol, c);
    }
    const matchingPage = template.pageDefinitions?.find(page => page.worksheetIds.includes(item.worksheetId));
    if (matchingPage) {
      const paperSize: Record<string, number> = { A4: 9, A3: 8, Letter: 1, Legal: 5 };
      sheet.pageSetup = { ...sheet.pageSetup, paperSize: paperSize[matchingPage.paperSize],
        orientation: matchingPage.orientation,
        margins: { left: matchingPage.marginsMm.left / 25.4, right: matchingPage.marginsMm.right / 25.4,
          top: matchingPage.marginsMm.top / 25.4, bottom: matchingPage.marginsMm.bottom / 25.4,
          header: 0.2, footer: 0.2 } };
    }
    if (!sheet.pageSetup.printArea || !sheet.pageSetup.printArea.length)
      sheet.pageSetup.printArea = `A1:${a1(lastRow, lastCol)}`;
    created.set(item.worksheetId, sheet);
  }

  // Keep unconfigured source sheets intact, but put configured sheets in package order.
  const ordered = template.worksheets.map(item => created.get(item.worksheetId)!).filter(Boolean);
  const current = workbook.worksheets;
  const unconfigured = current.filter(sheet => sheet.name !== METADATA_SHEET && !ordered.includes(sheet));
  const allInOrder = [...ordered, ...unconfigured];
  allInOrder.forEach((sheet, index) => { (sheet as unknown as { orderNo: number }).orderNo = index + 1; });

  const meta = workbook.addWorksheet(METADATA_SHEET, { state: 'veryHidden' });
  meta.getCell('A1').value = PACKAGE_METADATA_MARKER;
  const saved = copy(template);
  if (saved.sourceWorkbook) saved.sourceWorkbook.base64 = '';
  for (const sheet of saved.worksheets) if (sheet.document.excelSource) sheet.document.excelSource.base64 = '';
  const json = JSON.stringify(saved);
  for (let i = 0; i < json.length; i += 30000) meta.getCell(Math.floor(i / 30000) + 2, 1).value = json.slice(i, i + 30000);
  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer.byteLength); bytes.set(new Uint8Array(buffer));
  return bytes;
}
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = fileName;
  document.body.appendChild(link); link.click(); link.remove();
  // Delayed cleanup is intentional: revoking immediately can race Chromium downloads.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export function xlsxBlob(bytes: Uint8Array): Blob {
  const data = new ArrayBuffer(bytes.byteLength); new Uint8Array(data).set(bytes);
  return new Blob([data], { type: XLSX_MIME });
}
