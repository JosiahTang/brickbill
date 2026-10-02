import ExcelJS from 'exceljs';
import { copy, documentFields, newDocument, type CellStyle, type TemplateDocument } from '../domain/model.ts';
import { validateDocument } from '../domain/operations.ts';
import { createTemplatePackage, validateTemplatePackage } from '../core/templates/package.ts';
import type { TemplatePackage } from '../core/contracts/types.ts';

export const METADATA_SHEET = '_brickbill_template';
export const METADATA_MARKER = 'BRICKBILL_TEMPLATE_V1';
export const PACKAGE_METADATA_MARKER = 'BRICKBILL_TEMPLATE_PACKAGE_V2';
export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function base64ToBytes(value: string): Uint8Array { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function loadExcel(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  if (bytes.byteLength > MAX_FILE_SIZE) throw new Error('Excel 文件不能超过 20 MiB');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as never); }
  catch { throw new Error('无法读取 Excel，请使用未加密的 .xlsx 文件（旧版 .xls 请先另存为 .xlsx）'); }
  return workbook;
}
export async function listExcelSheets(bytes: Uint8Array): Promise<string[]> {
  const workbook = await loadExcel(bytes);
  return workbook.worksheets.filter(s => s.name !== METADATA_SHEET && s.state === 'visible').map(s => s.name);
}
function color(value?: Partial<ExcelJS.Color>): string | undefined {
  return value?.argb && /^[a-f\d]{8}$/i.test(value.argb) ? '#' + value.argb.slice(2) : undefined;
}
function styleOf(cell: ExcelJS.Cell): CellStyle {
  const style: CellStyle = {};
  const { font, fill, alignment, border } = cell;
  if (font?.name) style.fontFamily = font.name;
  if (font?.size) style.fontSizePt = Math.max(6, Math.min(72, font.size));
  if (font?.bold !== undefined) style.bold = font.bold;
  if (color(font?.color)) style.color = color(font.color);
  if (fill?.type === 'pattern' && fill.pattern === 'solid') style.background = color(fill.fgColor);
  if (alignment) {
    if (['left', 'center', 'right'].includes(alignment.horizontal ?? '')) style.horizontal = alignment.horizontal as CellStyle['horizontal'];
    if (['top', 'middle', 'bottom'].includes(alignment.vertical ?? '')) style.vertical = alignment.vertical as CellStyle['vertical'];
    if (alignment.wrapText !== undefined) style.wrap = alignment.wrapText;
  }
  if (border) for (const side of ['top', 'right', 'bottom', 'left'] as const) if (border[side]?.style) {
    style.borders ??= {};
    style.borders[side] = { style: ['medium', 'dashed'].includes(border[side]!.style!) ? border[side]!.style as 'medium' | 'dashed' : 'thin', color: color(border[side]!.color) ?? '#000000' };
  }
  return style;
}
export function parseDocumentJson(text: string): TemplateDocument {
  if (text.length > 40 * 1024 * 1024) throw new Error('模板 JSON 过大');
  const value = JSON.parse(text); const doc = value.document ?? value;
  validateDocument(doc); return copy(doc);
}
export async function importExcel(bytes: Uint8Array, fileName: string, sheetName?: string,
  options: { ignoreEmbeddedMetadata?: boolean } = {}): Promise<TemplateDocument> {
  if (!/\.xlsx$/i.test(fileName)) throw new Error('仅支持 .xlsx；请将旧版 .xls 另存为 .xlsx');
  const workbook = await loadExcel(bytes);
  const embedded = workbook.getWorksheet(METADATA_SHEET);
  if (embedded && !options.ignoreEmbeddedMetadata) {
    if (embedded.getCell('A1').value !== METADATA_MARKER) throw new Error(`工作表 ${METADATA_SHEET} 为系统保留名称，请在 Excel 中重命名后导入`);
    let json = ''; embedded.eachRow((row, r) => { if (r > 1) json += String(row.getCell(1).value ?? ''); });
    const doc = parseDocumentJson(json);
    doc.fields ??= copy(documentFields(doc));
    // Embedded bindings are authoritative for saved templates, regardless of worksheet tab order.
    if (!workbook.getWorksheet(doc.sheetName)) throw new Error('模板绑定对应的工作表已不存在');
    doc.excelSource = { fileName, sheetName: doc.sheetName, base64: bytesToBase64(bytes), warnings: doc.excelSource?.warnings ?? [] };
    return doc;
  }
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets.find(s => s.state === 'visible');
  if (!sheet) throw new Error('未找到可导入的工作表');
  const doc = newDocument();
  doc.id = `excel-${Date.now()}`; doc.name = fileName.replace(/\.xlsx$/i, ''); doc.sheetName = sheet.name;
  doc.blocks = []; doc.repeatRegions = [];
  const merges = sheet.model.merges ?? [];
  doc.rows = Math.max(20, sheet.rowCount); doc.cols = Math.max(10, sheet.columnCount);
  for (const address of merges) {
    const range = sheet.getCell(address.split(':')[0]); const end = sheet.getCell(address.split(':')[1] ?? address);
    const r = Number(range.row) - 1, c = Number(range.col) - 1;
    const rows = Number(end.row) - r, cols = Number(end.col) - c;
    doc.merges.push({ r, c, rows, cols }); doc.rows = Math.max(doc.rows, r + rows); doc.cols = Math.max(doc.cols, c + cols);
  }
  if (doc.rows > 10000 || doc.cols > 200 || doc.rows * doc.cols > 500000) throw new Error('模板过大：支持最多 10000 行、200 列和 500000 个单元格，请清理远处多余格式');
  doc.rowHeightPx = Array.from({ length: doc.rows }, (_, r) => Math.max(1, Math.min(1000, (sheet.getRow(r + 1).height ?? sheet.properties.defaultRowHeight ?? 18) * 96 / 72)));
  doc.colWidthPx = Array.from({ length: doc.cols }, (_, c) => Math.max(1, Math.min(2000, (sheet.getColumn(c + 1).width ?? sheet.properties.defaultColWidth ?? 10) * 7 + 5)));
  sheet.eachRow({ includeEmpty: true }, row => row.eachCell({ includeEmpty: true }, cell => {
    const r = Number(cell.row) - 1, c = Number(cell.col) - 1;
    if (cell.value === null && !Object.keys(cell.style).length) return;
    const isSlave = cell.isMerged && cell.master.address !== cell.address;
    let value = cell.value;
    // Shared formulas become standalone formulas before row projection.
    if (cell.type === ExcelJS.ValueType.Formula) value = { formula: cell.formula, result: cell.result };
    const excelValue = value instanceof Date ? { date: value.toISOString() } : value;
    doc.cells[`${r}:${c}`] = {
      style: styleOf(cell), excelStyle: copy(cell.style) as Record<string, unknown>, numFmt: cell.numFmt,
      ...(!isSlave && value !== null ? { text: value instanceof Date ? value.toISOString().slice(0, 10) : cell.text, excelValue } : {}),
    };
  }));
  const warnings = ['导入及导出支持常规单元格、合并、样式、图片和打印设置；图表、宏、透视表及特殊 Excel 对象不保证保留。'];
  if (sheet.getImages().length) warnings.push(`本表含 ${sheet.getImages().length} 张图片：保存时保留，编辑网格暂不显示图片。`);
  if (workbook.worksheets.filter(s => s.name !== METADATA_SHEET).length > 1) warnings.push('本次编辑选定工作表，其他工作表随文件保留。');
  if (Object.values(doc.cells).some(c => c.excelValue && typeof c.excelValue === 'object' && 'formula' in c.excelValue)) warnings.push('公式在模板保存时保留；涉及扩行的生成需先将公式替换为业务字段。');
  doc.excelSource = { fileName, sheetName: sheet.name, base64: bytesToBase64(bytes), warnings };
  validateDocument(doc); return doc;
}

export function parseTemplatePackageJson(text: string): TemplatePackage {
  if (text.length > 40 * 1024 * 1024) throw new Error('模板包 JSON 过大');
  const value: unknown = JSON.parse(text);
  validateTemplatePackage(value);
  return copy(value as TemplatePackage);
}

export async function importTemplatePackage(bytes: Uint8Array, fileName: string, projectId = 'unassigned'): Promise<TemplatePackage> {
  if (!/\.xlsx$/i.test(fileName)) throw new Error('仅支持 .xlsx 工作簿');
  const workbook = await loadExcel(bytes);
  const metadata = workbook.getWorksheet(METADATA_SHEET);
  if (metadata && ![PACKAGE_METADATA_MARKER, METADATA_MARKER].includes(String(metadata.getCell('A1').value ?? '')))
    throw new Error(`工作表 ${METADATA_SHEET} 为系统保留名称，请在 Excel 中重命名后导入`);
  if (metadata?.getCell('A1').value === PACKAGE_METADATA_MARKER) {
    let json = ''; metadata.eachRow((row, rowNumber) => { if (rowNumber > 1) json += String(row.getCell(1).value ?? ''); });
    const template = parseTemplatePackageJson(json);
    template.sourceWorkbook = { fileName, base64: bytesToBase64(bytes) };
    for (const sheet of template.worksheets) {
      const exists = workbook.getWorksheet(sheet.name);
      if (!exists) throw new Error(`模板包引用的工作表已不存在：${sheet.name}`);
    }
    validateTemplatePackage(template);
    return template;
  }

  let documents: TemplateDocument[];
  if (metadata?.getCell('A1').value === METADATA_MARKER) {
    const legacy = await importExcel(bytes, fileName);
    documents = [legacy];
    const names = workbook.worksheets.filter(sheet => sheet.name !== METADATA_SHEET && sheet.state === 'visible'
      && sheet.name !== legacy.sheetName).map(sheet => sheet.name);
    for (const name of names) documents.push(await importExcel(bytes, fileName, name, { ignoreEmbeddedMetadata: true }));
  } else {
    const names = workbook.worksheets.filter(sheet => sheet.name !== METADATA_SHEET && sheet.state === 'visible').map(sheet => sheet.name);
    if (!names.length) throw new Error('没有可见工作表');
    documents = [];
    for (const name of names) documents.push(await importExcel(bytes, fileName, name, { ignoreEmbeddedMetadata: true }));
  }
  const template = createTemplatePackage({ projectId, name: fileName.replace(/\.xlsx$/i, ''),
    worksheets: documents.map(document => ({ document })), sourceWorkbook: { fileName, base64: bytesToBase64(bytes) } });
  validateTemplatePackage(template);
  return template;
}
