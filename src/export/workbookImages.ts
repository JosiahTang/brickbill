import type ExcelJS from 'exceljs';
import type { TemplatePackage } from '../core/contracts/types.ts';
import { axisPosition, imageRangeRect } from '../domain/images.ts';
import { copy } from '../domain/model.ts';

/** Normalize retained native images once; package.resources remains the sole resource repository. */
export function readWorkbookImages(template: TemplatePackage, workbook: ExcelJS.Workbook): TemplatePackage {
  const result = copy(template);
  for (const worksheet of result.worksheets) {
    const doc = worksheet.document;
    if (doc.images !== undefined) continue; // Saved anchors, including an empty list, are authoritative.
    const sheet = workbook.getWorksheet(doc.excelSource?.sheetName ?? worksheet.name);
    if (!sheet?.getImages().length) continue;
    doc.imageLayoutVersion = 1; doc.images = [];
    if (doc.excelSource) doc.excelSource.warnings = doc.excelSource.warnings.map(warning =>
      warning.includes('编辑网格暂不显示图片') ? warning.replace('保存时保留，编辑网格暂不显示图片', '可在画布选择、移动和缩放，保存后保留') : warning);
    for (const [sourceIndex, image] of sheet.getImages().entries()) {
      const resource = workbook.getImage(Number(image.imageId));
      if (!resource || !['png', 'jpeg', 'gif'].includes(resource.extension)) throw new Error(`工作表 ${sheet.name} 图片 ${sourceIndex + 1} 类型不支持`);
      const base64 = resource.base64?.replace(/^data:[^,]+,/, '') ?? (resource.buffer
        ? bytesBase64(new Uint8Array(resource.buffer)) : undefined);
      if (!base64) throw new Error(`工作表 ${sheet.name} 图片 ${sourceIndex + 1} 缺少内嵌资源`);
      const resourceId = `excel.image.${image.imageId}`;
      result.resources ??= [];
      const existing = result.resources.find(item => item.resourceId === resourceId);
      if (existing && existing.base64 !== base64) throw new Error(`导入图片资源标识冲突：${resourceId}`);
      if (!existing) result.resources.push({ resourceId, mediaType: `image/${resource.extension}`, base64 });
      const range = image.range as ExcelJS.ImageRange & { ext?: { width: number; height: number } };
      const r = range.tl.row, c = range.tl.col;
      if (![r, c, range.br?.row ?? r, range.br?.col ?? c].every(value => Number.isFinite(value) && value >= 0))
        throw new Error(`工作表 ${sheet.name} 图片 ${sourceIndex + 1} 锚点无效`);
      const grow = (rows: number, cols: number) => {
        if (rows > 10000 || cols > 200 || rows * cols > 500000) throw new Error('图片超出可编辑范围：最多 10000 行、200 列和 500000 个单元格');
        while (doc.rowHeightPx.length < rows) {
          const index = doc.rowHeightPx.length;
          doc.rowHeightPx.push(Math.max(1, Math.min(1000, (sheet.getRow(index + 1).height ?? sheet.properties.defaultRowHeight ?? 18) * 96 / 72)));
        }
        while (doc.colWidthPx.length < cols) {
          const index = doc.colWidthPx.length;
          doc.colWidthPx.push(Math.max(1, Math.min(2000, (sheet.getColumn(index + 1).width ?? sheet.properties.defaultColWidth ?? 10) * 7 + 5)));
        }
        doc.rows = rows; doc.cols = cols;
      };
      grow(Math.max(doc.rows, Math.ceil(range.br?.row ?? r + 1)), Math.max(doc.cols, Math.ceil(range.br?.col ?? c + 1)));
      if (range.ext) {
        if (![range.ext.width, range.ext.height].every(value => Number.isFinite(value) && value > 0))
          throw new Error(`工作表 ${sheet.name} 图片 ${sourceIndex + 1} 尺寸无效`);
        const right = axisPosition(c, doc.colWidthPx) + range.ext.width, bottom = axisPosition(r, doc.rowHeightPx) + range.ext.height;
        while (axisPosition(doc.cols, doc.colWidthPx) < right) grow(doc.rows, doc.cols + 1);
        while (axisPosition(doc.rows, doc.rowHeightPx) < bottom) grow(doc.rows + 1, doc.cols);
      }
      doc.images.push({ imageId: `native.${sourceIndex}`, resourceId, sourceIndex,
        rect: imageRangeRect(range, doc) });
    }
  }
  return result;
}
function bytesBase64(bytes: Uint8Array): string {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/** One byte reader for retained Excel media and package resources (also used by output comparison). */
export function imageResourceBytes(resource: { base64?: string; buffer?: ArrayBuffer | Uint8Array; mediaType?: string; extension?: string }): Uint8Array {
  const value = resource.base64?.replace(/^data:[^,]+,/, '');
  if (value !== undefined && (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)))
    throw new Error('图片资源内容不是有效的 base64');
  const bytes = value !== undefined ? Uint8Array.from(atob(value), char => char.charCodeAt(0))
    : resource.buffer ? new Uint8Array(resource.buffer) : new Uint8Array();
  const format = resource.mediaType?.split('/')[1] ?? resource.extension;
  const matches = (offset: number, values: number[]) => values.every((v, i) => bytes[offset + i] === v);
  const valid = format === 'png' ? bytes.length >= 45 && matches(0, [137,80,78,71,13,10,26,10]) && matches(12, [73,72,68,82]) && matches(bytes.length - 8, [73,69,78,68])
    : format === 'jpeg' ? bytes.length >= 4 && matches(0, [255,216]) && matches(bytes.length - 2, [255,217])
    : format === 'gif' ? bytes.length >= 14 && (matches(0, [71,73,70,56,55,97]) || matches(0, [71,73,70,56,57,97])) && bytes.at(-1) === 59 : false;
  if (!valid) throw new Error('图片资源内容无效、截断或类型不支持');
  return bytes;
}

/** Update existing native image objects, preserving other source worksheet objects. */
export function applyWorkbookImageAnchors(sheet: ExcelJS.Worksheet, document: TemplatePackage['worksheets'][number]['document'],
  resources?: NonNullable<TemplatePackage['resources']>) {
  if (document.images === undefined) return;
  const native = sheet.getImages();
  const selected = document.images.map(image => {
    const target = native[image.sourceIndex];
    if (!target) throw new Error(`工作表 ${sheet.name} 图片源不存在：${image.imageId}`);
    const resource = resources === undefined ? sheet.workbook.getImage(Number(target.imageId))
      : resources.find(item => item.resourceId === image.resourceId);
    if (!resource) throw new Error(`工作表 ${sheet.name} 图片 ${image.imageId} 资源不存在：${image.resourceId}`);
    let bytes: Uint8Array;
    try { bytes = imageResourceBytes(resource); }
    catch (error) { throw new Error(`工作表 ${sheet.name} 图片 ${image.imageId}：${error instanceof Error ? error.message : String(error)}`); }
    const extension = ('mediaType' in resource ? resource.mediaType?.split('/')[1] : resource.extension) as 'png' | 'jpeg' | 'gif';
    return { image, target, bytes, extension };
  });
  for (const { image, target, bytes, extension } of selected) {
    // Reuse identical media across saves; never mutate a source resource shared by
    // another sheet/background, and never append identical bytes on every save.
    const base64 = bytesBase64(bytes);
    const existing = sheet.workbook.model.media.findIndex(resource => {
      if (resource.extension !== extension) return false;
      const value = resource as unknown as ExcelJS.Image;
      return (value.base64?.replace(/^data:[^,]+,/, '') ?? (value.buffer ? bytesBase64(new Uint8Array(value.buffer)) : undefined)) === base64;
    });
    target.imageId = String(existing >= 0 ? existing : sheet.workbook.addImage({ base64, extension }));
    const { r, c, rows, cols } = image.rect;
    // ExcelJS's public range uses Anchor instances; construct them with the owning worksheet.
    const AnchorClass = target.range.tl.constructor as new (worksheet: ExcelJS.Worksheet, point: { row: number; col: number }, offset: number) => ExcelJS.Anchor;
    target.range.tl = new AnchorClass(sheet, { row: r, col: c }, 0);
    target.range.br = new AnchorClass(sheet, { row: r + rows, col: c + cols }, 0);
    delete (target.range as ExcelJS.ImageRange & { ext?: unknown }).ext;
  }
  // ExcelJS 4.4 has no public remove-image API. Keep this narrow compatibility access
  // in the existing adapter; replacing worksheet.model would reparse cells/merges/tables.
  const media = sheet as unknown as { _media: Array<{ type: string }> };
  media._media = [...media._media.filter(item => item.type !== 'image'), ...selected.map(item => item.target)];
  selected.forEach(({ image }, index) => { image.sourceIndex = index; });
}
