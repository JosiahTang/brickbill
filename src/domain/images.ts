import type { Rect, TemplateDocument } from './model.ts';

export function axisPosition(position: number, sizes: number[]): number {
  const base = Math.floor(position);
  return sizes.slice(0, base).reduce((sum, size) => sum + size, 0) + (sizes[base] ?? 0) * (position - base);
}
export function axisCoordinate(px: number, sizes: number[], defaultSize?: number): number {
  let remaining = Math.max(0, px);
  for (let index = 0; index < sizes.length; index++) {
    if (remaining < sizes[index]) return index + remaining / sizes[index];
    remaining -= sizes[index];
  }
  return sizes.length + (defaultSize ? remaining / defaultSize : 0);
}
/** Excel supports both two-cell anchors and a top-left anchor with a fixed pixel extent. */
export function imageRangeRect(range: { tl: { row: number; col: number }; br?: { row: number; col: number }; ext?: { width: number; height: number } },
  doc: Pick<TemplateDocument, 'rowHeightPx' | 'colWidthPx'>, defaults?: { row: number; col: number }): Rect {
  const r = range?.tl?.row, c = range?.tl?.col;
  if (![r, c].every(value => Number.isFinite(value) && value >= 0)) throw new Error('图片锚点无效');
  let endRow: number, endCol: number;
  if (range.br) { endRow = range.br.row; endCol = range.br.col; }
  else {
    if (!range.ext || ![range.ext.width, range.ext.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('图片尺寸无效');
    endRow = axisCoordinate(axisPosition(r, doc.rowHeightPx) + range.ext.height, doc.rowHeightPx, defaults?.row);
    endCol = axisCoordinate(axisPosition(c, doc.colWidthPx) + range.ext.width, doc.colWidthPx, defaults?.col);
  }
  if (!Number.isFinite(endRow) || !Number.isFinite(endCol) || endRow <= r || endCol <= c) throw new Error('图片锚点尺寸无效');
  return { r, c, rows: endRow - r, cols: endCol - c };
}
export function imagePixels(rect: Rect, doc: Pick<TemplateDocument, 'rowHeightPx' | 'colWidthPx'>) {
  const x = axisPosition(rect.c, doc.colWidthPx), y = axisPosition(rect.r, doc.rowHeightPx);
  return { x, y, width: axisPosition(rect.c + rect.cols, doc.colWidthPx) - x,
    height: axisPosition(rect.r + rect.rows, doc.rowHeightPx) - y };
}
export function imageRect(box: { x: number; y: number; width: number; height: number }, doc: TemplateDocument): Rect {
  const r = axisCoordinate(box.y, doc.rowHeightPx), c = axisCoordinate(box.x, doc.colWidthPx);
  return { r, c, rows: axisCoordinate(box.y + box.height, doc.rowHeightPx) - r,
    cols: axisCoordinate(box.x + box.width, doc.colWidthPx) - c };
}
export function validImageRect(rect: Rect, doc: Pick<TemplateDocument, 'rows' | 'cols'>): boolean {
  return !!rect && [rect.r, rect.c, rect.rows, rect.cols].every(Number.isFinite)
    && rect.r >= 0 && rect.c >= 0 && rect.rows > 0 && rect.cols > 0
    && rect.r + rect.rows <= doc.rows + 1e-8 && rect.c + rect.cols <= doc.cols + 1e-8;
}
