import { defineStore } from 'pinia';
import { newDocument, copy, documentFields, fieldByPath, keyOf, type BlockDefinition, type CellStyle, type Rect, type Format, type RepeatSpec, type TemplateDocument, type Field, type RepeatRegion } from '../domain/model.ts';
import * as ops from '../domain/operations.ts';
import { upsertField, removeField, addInferredFields } from '../domain/fields.ts';
import { createDemoDocument } from '../domain/demo.ts';
import type { TemplatePackage, TemplateWorksheet, PageDefinition, DataViewDefinition } from '../core/contracts/types.ts';
import { createTemplatePackage, renameWorksheet, reorderWorksheets, updateWorksheet, upsertPageDefinition, validateTemplatePackage } from '../core/templates/package.ts';
import { validateContract } from '../core/contracts/validate.ts';

function stableFields(fields: Field[]): Field[] {
  return copy(fields).map(field => ({ ...field, fieldId: field.fieldId || `legacy.${field.path}` }));
}

export const useDesignerStore = defineStore('designer', {
  state: () => ({
    doc: newDocument(),
    templatePackage: null as TemplatePackage | null,
    activeWorksheetId: '',
    selection: { r: 0, c: 0, rows: 1, cols: 1 } as Rect,
    past: [] as TemplateDocument[], future: [] as TemplateDocument[],
    worksheetHistory: {} as Record<string, { past: TemplateDocument[]; future: TemplateDocument[] }>,
    documentReplacements: [] as Array<{ fromId: string; toId: string; fromPackage?: TemplatePackage; toPackage: TemplatePackage }>,
  }),
  getters: {
    canUndo: s => s.past.length > 0,
    canRedo: s => s.future.length > 0,
    worksheets: s => s.templatePackage?.worksheets ?? [],
    selectedCell: s => {
      const [r, c] = ops.anchor(s.doc, s.selection.r, s.selection.c);
      return s.doc.cells[keyOf(r, c)];
    },
  },
  actions: {
    loadDocument(next: TemplateDocument) {
      ops.validateDocument(next);
      const previous = copy(this.doc);
      const previousPackage = this.templatePackage ? this.packageSnapshot() : undefined;
      const fromId = previous.id;
      const replacement = copy(next); replacement.revision = this.doc.revision + 1;
      this.past.push(previous); if (this.past.length > 100) this.past.shift(); this.future = [];
      this.doc = replacement;
      this.selection = { r: 0, c: 0, rows: 1, cols: 1 };
      const packagedDocument = copy(this.doc); packagedDocument.fields = stableFields(documentFields(this.doc));
      this.templatePackage = createTemplatePackage({ name: this.doc.name, worksheets: [{ document: packagedDocument }] });
      this.activeWorksheetId = this.templatePackage.worksheets[0].worksheetId;
      this.documentReplacements.push({ fromId, toId: this.doc.id, fromPackage: previousPackage, toPackage: copy(this.templatePackage) });
      this.worksheetHistory = { [this.activeWorksheetId]: { past: this.past, future: this.future } };
    },
    loadTemplatePackage(template: TemplatePackage) {
      validateTemplatePackage(template);
      this.templatePackage = copy(template);
      const dictionary = new Map<string, Field>();
      for (const sheet of this.templatePackage.worksheets) for (const field of stableFields(documentFields(sheet.document))) {
        const existing = dictionary.get(field.path);
        if (existing && (existing.fieldId !== field.fieldId || existing.format !== field.format || existing.sourceKind !== field.sourceKind
          || existing.datasetId !== field.datasetId || existing.viewId !== field.viewId || existing.sourceFieldId !== field.sourceFieldId))
          throw new Error(`工作表间字段 ${field.path} 定义冲突；请先统一字段 ID、类型和来源`);
        if (!existing) dictionary.set(field.path, field);
      }
      for (const sheet of this.templatePackage.worksheets) sheet.document.fields = copy([...dictionary.values()]);
      const active = this.templatePackage.worksheets.find(sheet => sheet.visible) ?? this.templatePackage.worksheets[0];
      this.activeWorksheetId = active.worksheetId; this.doc = copy(active.document);
      this.selection = { r: 0, c: 0, rows: 1, cols: 1 }; this.past = []; this.future = [];
      this.worksheetHistory = Object.fromEntries(this.templatePackage.worksheets.map(sheet => [sheet.worksheetId, { past: [], future: [] }]));
    },
    packageSnapshot(): TemplatePackage {
      let result = this.templatePackage ? copy(this.templatePackage)
        : createTemplatePackage({ name: this.doc.name, worksheets: [{ document: this.doc }] });
      const active = result.worksheets.find(sheet => sheet.worksheetId === this.activeWorksheetId) ?? result.worksheets[0];
      const fields = stableFields(documentFields(this.doc));
      const activeDocument = copy(this.doc); activeDocument.fields = copy(fields);
      result = updateWorksheet(result, active.worksheetId, activeDocument);
      result.name = this.doc.name;
      for (const sheet of result.worksheets) {
        sheet.document.fields = copy(fields); sheet.document.name = result.name;
        for (const cell of Object.values(sheet.document.cells)) if (cell.binding) {
          const field = fields.find(item => item.fieldId === cell.binding!.fieldId || item.path === cell.binding!.path);
          if (field) {
            cell.binding.path = field.path; cell.binding.fieldId = field.fieldId; cell.binding.format = field.format;
            cell.numFmt = field.numberFormat ?? (field.format === 'number' ? '#,##0.00' : field.format === 'date' ? 'yyyy-mm-dd' : '@');
          }
        }
      }
      validateTemplatePackage(result);
      return result;
    },
    switchWorksheet(worksheetId: string) {
      const packageState = this.packageSnapshot();
      const next = packageState.worksheets.find(sheet => sheet.worksheetId === worksheetId);
      if (!next) throw new Error(`工作表不存在：${worksheetId}`);
      if (worksheetId === this.activeWorksheetId) { this.templatePackage = packageState; return; }
      this.worksheetHistory[this.activeWorksheetId] = { past: this.past, future: this.future };
      this.templatePackage = packageState; this.activeWorksheetId = worksheetId; this.doc = copy(next.document);
      this.selection = { r: 0, c: 0, rows: 1, cols: 1 };
      const history = this.worksheetHistory[worksheetId] ?? { past: [], future: [] };
      this.past = history.past; this.future = history.future;
    },
    addWorksheet(name?: string) {
      const packageState = this.packageSnapshot();
      const document = newDocument(); document.sheetName = name?.trim() || `工作表${packageState.worksheets.length + 1}`;
      document.name = packageState.name; document.fields = stableFields(documentFields(this.doc));
      const worksheetId = `sheet.${crypto.randomUUID().replaceAll('-', '')}`;
      const sheet: TemplateWorksheet = { worksheetId, name: document.sheetName, visible: true, bindingMode: 'stable-field-id', document };
      packageState.worksheets.push(sheet); packageState.revision++; validateTemplatePackage(packageState);
      this.worksheetHistory[this.activeWorksheetId] = { past: this.past, future: this.future };
      this.templatePackage = packageState; this.activeWorksheetId = worksheetId; this.doc = copy(document);
      this.selection = { r: 0, c: 0, rows: 1, cols: 1 }; this.past = []; this.future = [];
      this.worksheetHistory[worksheetId] = { past: [], future: [] };
    },
    renameActiveWorksheet(name: string) {
      if (!this.activeWorksheetId) return;
      const next = renameWorksheet(this.packageSnapshot(), this.activeWorksheetId, name);
      this.templatePackage = next; this.doc = copy(next.worksheets.find(sheet => sheet.worksheetId === this.activeWorksheetId)!.document);
    },
    reorderWorksheets(ids: string[]) { this.templatePackage = reorderWorksheets(this.packageSnapshot(), ids); },
    savePageDefinition(definition: PageDefinition) {
      this.templatePackage = upsertPageDefinition(this.packageSnapshot(), definition);
    },
    saveViewDraft(definition: DataViewDefinition) {
      validateContract<DataViewDefinition>('dataView', definition);
      const packageState = this.packageSnapshot(); packageState.viewDrafts ??= [];
      const index = packageState.viewDrafts.findIndex(item => item.viewId === definition.viewId && item.version === definition.version);
      if (index < 0) packageState.viewDrafts.push(copy(definition)); else packageState.viewDrafts[index] = copy(definition);
      packageState.revision++; validateTemplatePackage(packageState); this.templatePackage = packageState;
    },
    saveField(field: Field, oldPath?: string) {
      if (oldPath && field.path !== oldPath && (this.templatePackage?.worksheets.length ?? 0) > 1)
        throw new Error('多工作表模板中的字段路径是共享标识，不能直接改名；请保持路径并修改字段来源');
      this.commit(doc => upsertField(doc, field, oldPath)); this.syncPackageFields();
    },
    deleteField(path: string) {
      const usedElsewhere = this.templatePackage?.worksheets.some(sheet => sheet.worksheetId !== this.activeWorksheetId
        && Object.values(sheet.document.cells).some(cell => cell.binding?.path === path));
      if (usedElsewhere) throw new Error('该字段已在其他工作表绑定，请先解除所有工作表中的绑定');
      this.commit(doc => removeField(doc, path)); this.syncPackageFields();
    },
    inferFields(data: unknown) { let count = 0; this.commit(doc => { count = addInferredFields(doc, data); }); this.syncPackageFields(); return count; },
    syncPackageFields() {
      const fields = stableFields(documentFields(this.doc)); this.doc.fields = copy(fields);
      if (this.templatePackage) {
        for (const sheet of this.templatePackage.worksheets) sheet.document.fields = copy(fields);
        this.templatePackage.revision++;
      }
    },
    saveRegion(region: RepeatRegion) {
      this.commit(doc => {
        doc.repeatRegions ??= [];
        const index = doc.repeatRegions.findIndex(r => r.id === region.id);
        if (index >= 0) doc.repeatRegions[index] = copy(region); else doc.repeatRegions.push(copy(region));
      });
    },
    deleteRegion(id: string) { this.commit(doc => { doc.repeatRegions = doc.repeatRegions?.filter(r => r.id !== id); }); },
    unbind() {
      this.commit(doc => {
        const [r, c] = ops.anchor(doc, this.selection.r, this.selection.c);
        const cell = doc.cells[keyOf(r, c)]; if (cell) { delete cell.binding; delete cell.excelValue; }
      });
    },
    // Sole write path. Preview/selection changes never enter the undo history.
    commit(change: (draft: TemplateDocument) => void) {
      const next = ops.transaction(this.doc, change); // validates BEFORE modifying this.doc
      this.past.push(copy(this.doc));
      if (this.past.length > 100) this.past.shift();
      this.future = []; this.doc = next;
      if (this.activeWorksheetId) this.worksheetHistory[this.activeWorksheetId] = { past: this.past, future: this.future };
    },
    loadDemo() { this.commit(doc => {
      const demo = createDemoDocument();
      Object.assign(doc, demo, { revision: doc.revision, id: doc.id });
    }); },
    snapshot(): TemplateDocument { return copy(this.doc); },
    select(rect: Rect) { ops.checkBounds(rect, this.doc.rows, this.doc.cols); this.selection = copy(rect); },
    place(block: BlockDefinition, r: number, c: number) {
      // UI calls this over HTTPS/localhost; use a host-provided UUID for older CEF.
      const id = crypto.randomUUID();
      this.commit(doc => ops.placeBlock(doc, block, r, c, id));
      this.select({ r, c, rows: block.rows, cols: block.cols });
    },
    bind(r: number, c: number, path: string, replace = false) {
      this.commit(doc => ops.bindField(doc, r, c, path, replace));
    },
    setText(text: string) {
      this.commit(doc => ops.setText(doc, this.selection.r, this.selection.c, text));
    },
    setFormat(format: Format) {
      const [r, c] = ops.anchor(this.doc, this.selection.r, this.selection.c);
      const binding = this.doc.cells[keyOf(r, c)]?.binding;
      ops.assert(binding, '请先绑定业务字段');
      const field = fieldByPath(binding.path, documentFields(this.doc));
      this.commit(doc => {
        upsertField(doc, { ...field, format }, field.path);
        const cell = doc.cells[keyOf(r, c)]; if (cell) cell.numFmt = field.numberFormat ?? (format === 'number' ? '#,##0.00' : format === 'date' ? 'yyyy-mm-dd' : '@');
      });
      this.syncPackageFields();
    },
    setStyle(style: CellStyle) { this.commit(doc => ops.styleRange(doc, this.selection, style)); },
    merge() { this.commit(doc => ops.mergeRange(doc, this.selection)); },
    clear() { this.commit(doc => ops.clearRange(doc, this.selection)); },
    unmerge() { this.commit(doc => ops.unmergeRange(doc, this.selection)); },
    resize(rowHeightPx: number, colWidthPx: number) {
      this.commit(doc => {
        for (let r = this.selection.r; r < this.selection.r + this.selection.rows; r++) doc.rowHeightPx[r] = rowHeightPx;
        for (let c = this.selection.c; c < this.selection.c + this.selection.cols; c++) doc.colWidthPx[c] = colWidthPx;
      });
    },
    setRepeat(id: string, repeat?: RepeatSpec) {
      this.commit(doc => {
        const block = doc.blocks.find(b => b.id === id); ops.assert(block, '找不到积木');
        if (repeat) block.repeat = copy(repeat); else delete block.repeat;
      });
    },
    move(id: string, r: number, c: number) { this.commit(doc => ops.moveBlock(doc, id, r, c)); },
    remove(id: string) { this.commit(doc => ops.removeBlock(doc, id)); },
    undo() {
      const doc = this.past.pop(); if (!doc) return;
      this.future.push(copy(this.doc)); doc.revision = this.doc.revision + 1; this.doc = doc;
      const replacement = [...this.documentReplacements].reverse().find(item => item.toId === this.future.at(-1)?.id && item.fromId === doc.id);
      if (replacement) {
        this.templatePackage = replacement.fromPackage ? copy(replacement.fromPackage) : createTemplatePackage({ name: doc.name, worksheets: [{ document: doc }] });
        this.activeWorksheetId = this.templatePackage.worksheets.find(sheet => sheet.document.id === doc.id)?.worksheetId ?? this.templatePackage.worksheets[0].worksheetId;
      } else if (this.templatePackage) {
        const active = this.templatePackage.worksheets.find(sheet => sheet.worksheetId === this.activeWorksheetId);
        if (active) this.templatePackage = updateWorksheet(this.templatePackage, active.worksheetId, this.doc);
      }
      if (this.activeWorksheetId) this.worksheetHistory[this.activeWorksheetId] = { past: this.past, future: this.future };
      this.selection = { r: 0, c: 0, rows: 1, cols: 1 };
    },
    redo() {
      const doc = this.future.pop(); if (!doc) return;
      this.past.push(copy(this.doc)); doc.revision = this.doc.revision + 1; this.doc = doc;
      const replacement = [...this.documentReplacements].reverse().find(item => item.fromId === this.past.at(-1)?.id && item.toId === doc.id);
      if (replacement) {
        this.templatePackage = copy(replacement.toPackage);
        this.activeWorksheetId = this.templatePackage.worksheets.find(sheet => sheet.document.id === doc.id)?.worksheetId ?? this.templatePackage.worksheets[0].worksheetId;
      } else if (this.templatePackage) {
        const active = this.templatePackage.worksheets.find(sheet => sheet.worksheetId === this.activeWorksheetId);
        if (active) this.templatePackage = updateWorksheet(this.templatePackage, active.worksheetId, this.doc);
      }
      if (this.activeWorksheetId) this.worksheetHistory[this.activeWorksheetId] = { past: this.past, future: this.future };
      this.selection = { r: 0, c: 0, rows: 1, cols: 1 };
    },
  },
});
