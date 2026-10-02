import {
  BorderStyleTypes, CellValueType, CommandType, HorizontalAlign, VerticalAlign, WrapStrategy,
  type ICellData, type IObjectMatrixPrimitiveType, type IRange, type IStyleData,
} from '@univerjs/core';
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import zhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import {
  AddWorksheetMergeMutation, RemoveWorksheetMergeMutation, SetRangeValuesMutation,
  SetWorksheetRowHeightMutation, SetWorksheetRowIsAutoHeightMutation, SetWorksheetColWidthMutation,
} from '@univerjs/sheets';
import '@univerjs/preset-sheets-core/lib/index.css';
import { copy, displayText, numberFormat, type Cell, type Rect, type TemplateDocument } from '../domain/model.ts';
import { renderCells, validateDocument } from '../domain/operations.ts';

export const univerRange = (r: Rect): IRange => ({
  startRow: r.r, startColumn: r.c, endRow: r.r + r.rows - 1, endColumn: r.c + r.cols - 1,
});
const domainRange = (r: IRange): Rect => ({
  r: r.startRow, c: r.startColumn, rows: r.endRow - r.startRow + 1, cols: r.endColumn - r.startColumn + 1,
});
function cellData(cell: Cell, doc: TemplateDocument): ICellData {
  const s = cell.style ?? {};
  const style: IStyleData = {
    ff: s.fontFamily ?? 'Arial', fs: s.fontSizePt ?? 11, bl: s.bold ? 1 : 0,
    cl: { rgb: s.color ?? '#1F2937' }, bg: { rgb: s.background ?? '#FFFFFF' },
    ht: { left: HorizontalAlign.LEFT, center: HorizontalAlign.CENTER, right: HorizontalAlign.RIGHT }[s.horizontal ?? 'left'],
    vt: { top: VerticalAlign.TOP, middle: VerticalAlign.MIDDLE, bottom: VerticalAlign.BOTTOM }[s.vertical ?? 'middle'],
    tb: s.wrap === false ? WrapStrategy.CLIP : WrapStrategy.WRAP,
    n: { pattern: numberFormat(cell) }, bd: {},
  };
  const styles = { thin: BorderStyleTypes.THIN, medium: BorderStyleTypes.MEDIUM, dashed: BorderStyleTypes.DASHED };
  const keys = { top: 't', right: 'r', bottom: 'b', left: 'l' } as const;
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const edge = s.borders?.[side];
    if (edge) style.bd![keys[side]] = { s: styles[edge.style], cl: { rgb: edge.color } };
  }
  // Explicit type + f:null prevents native formula auto-detection.
  return { v: displayText(cell, doc.syntax), t: CellValueType.STRING, f: null, p: null, s: style };
}
export interface GridHandlers {
  select(rect: Rect): void;
  dragOver(r: number, c: number, dataTransfer: DataTransfer): void;
  drop(r: number, c: number, dataTransfer: DataTransfer): void;
}
export function mountUniver(container: HTMLElement, initial: TemplateDocument, handlers: GridHandlers, zoomRatio = 1) {
  const { univer, univerAPI: api } = createUniver({
    locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: mergeLocales(zhCN) },
    presets: [UniverSheetsCorePreset({ container, header: false, toolbar: false, footer: false, formulaBar: false, contextMenu: false })],
  });
  const workbook = api.createWorkbook({
    id: initial.id, name: initial.name, sheetOrder: ['main'],
    sheets: { main: { id: 'main', name: initial.sheetName, rowCount: initial.rows,
      columnCount: initial.cols, defaultRowHeight: 32, defaultColumnWidth: 140, zoomRatio,
      cellData: {}, mergeData: [] } },
  });
  const sheet = workbook.getActiveSheet();
  const target = { unitId: workbook.getId(), subUnitId: sheet.getSheetId() };
  let applying = false;
  let previous: TemplateDocument | undefined;
  let previousCells: Record<string, Cell> = {};
  let highlight: { dispose(): void } | undefined;
  const disposables = [
    // Controlled-design mode: select/scroll operations are allowed; all data changes
    // must use Pinia actions. It intentionally doesn't enable native arbitrary editing.
    api.addEvent(api.Event.BeforeCommandExecute, e => {
      if (!applying && e.type !== CommandType.OPERATION) e.cancel = true;
    }),
    api.addEvent(api.Event.BeforeSheetEditStart, e => { e.cancel = true; }),
    api.addEvent(api.Event.BeforeClipboardPaste, e => { e.cancel = true; }),
    api.addEvent(api.Event.SelectionChanged, e => {
      if (!applying && e.worksheet.getSheetId() === target.subUnitId && e.selections[0]) handlers.select(domainRange(e.selections[0]));
    }),
    api.addEvent(api.Event.DragOver, e => {
      if (e.worksheet.getSheetId() === target.subUnitId) handlers.dragOver(e.row, e.column, e.dataTransfer);
    }),
    api.addEvent(api.Event.Drop, e => {
      if (e.worksheet.getSheetId() === target.subUnitId) handlers.drop(e.row, e.column, e.dataTransfer);
    }),
  ];
  function run(id: string, payload: object) {
    const ok = api.syncExecuteCommand(id, { ...target, ...payload });
    if (!ok) throw new Error(`Univer 投影失败：${id}`);
  }
  function render(doc: TemplateDocument) {
    validateDocument(doc);
    if (doc.rows !== initial.rows || doc.cols !== initial.cols) throw new Error('改变画布总行列数需要重新挂载适配器');
    const nextCells = renderCells(doc);
    const changed = new Set([...Object.keys(previousCells), ...Object.keys(nextCells)]);
    const clear: IObjectMatrixPrimitiveType<ICellData | null> = {};
    const values: IObjectMatrixPrimitiveType<ICellData> = {};
    let count = 0;
    for (const key of changed) {
      if (previous?.syntax === doc.syntax && JSON.stringify(previousCells[key]) === JSON.stringify(nextCells[key])) continue;
      const [r, c] = key.split(':').map(Number);
      (clear[r] ??= {})[c] = null;
      if (nextCells[key]) (values[r] ??= {})[c] = cellData(nextCells[key], doc);
      count++;
    }
    const all = univerRange({ r: 0, c: 0, rows: doc.rows, cols: doc.cols });
    applying = true;
    try {
      // Mutations don't create an independent native undo stack. Pinia owns undo/redo.
      if (JSON.stringify(previous?.merges ?? []) !== JSON.stringify(doc.merges)) {
        if (previous?.merges.length) run(RemoveWorksheetMergeMutation.id, { ranges: previous.merges.map(univerRange) });
        if (doc.merges.length) run(AddWorksheetMergeMutation.id, { ranges: doc.merges.map(univerRange) });
      }
      if (count) {
        run(SetRangeValuesMutation.id, { cellValue: clear }); // removes stale style/content
        run(SetRangeValuesMutation.id, { cellValue: values });
      }
      if (!previous || JSON.stringify(previous.rowHeightPx) !== JSON.stringify(doc.rowHeightPx)) {
        run(SetWorksheetRowHeightMutation.id, { ranges: [all], rowHeight: Object.fromEntries(doc.rowHeightPx.map((h, r) => [r, h])) });
        run(SetWorksheetRowIsAutoHeightMutation.id, { ranges: [all], autoHeightInfo: 0 });
      }
      if (!previous || JSON.stringify(previous.colWidthPx) !== JSON.stringify(doc.colWidthPx))
        run(SetWorksheetColWidthMutation.id, { ranges: [all], colWidth: Object.fromEntries(doc.colWidthPx.map((w, c) => [c, w])) });
      previous = copy(doc); previousCells = nextCells;
    } finally { applying = false; }
  }
  function preview(rect?: Rect, valid = true) {
    highlight?.dispose(); highlight = undefined;
    if (!rect || rect.r < 0 || rect.c < 0 || rect.r + rect.rows > initial.rows || rect.c + rect.cols > initial.cols) return;
    highlight = sheet.getRange(rect.r, rect.c, rect.rows, rect.cols).highlight({
      stroke: valid ? '#16A34A' : '#DC2626', fill: valid ? 'rgba(22,163,74,0.12)' : 'rgba(220,38,38,0.12)',
    });
  }
  render(initial);
  return {
    render, preview,
    select(rect: Rect) {
      applying = true;
      try { sheet.getRange(rect.r, rect.c, rect.rows, rect.cols).activate(); sheet.scrollToCell(rect.r, rect.c); }
      finally { applying = false; }
    },
    dispose() { highlight?.dispose(); disposables.forEach(d => d.dispose()); univer.dispose(); },
  };
}
