import { defineStore } from 'pinia';
import { toRaw } from 'vue';
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

type FieldChange = { path: string; before?: Field; after?: Field };
type DocumentReplacement = { fromId: string; toId: string; fromPackage?: TemplatePackage; toPackage: TemplatePackage };
// Runtime operation metadata belongs to the existing history snapshots, never the saved document.
const fieldHistory = new WeakMap<TemplateDocument, FieldChange[]>();
const replacementHistory = new WeakMap<TemplateDocument, DocumentReplacement>();
function fieldChanges(before: Field[], after: Field[]): FieldChange[] {
  return [...new Set([...before, ...after].map(field => field.path))].flatMap(path => {
    const a = before.find(field => field.path === path), b = after.find(field => field.path === path);
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, ...(a ? { before: copy(a) } : {}), ...(b ? { after: copy(b) } : {}) }];
  });
}
function synchronizeFields(template: TemplatePackage, fields: Field[]) {
  for (const sheet of template.worksheets) {
    sheet.document.fields = copy(fields);
    for (const cell of Object.values(sheet.document.cells)) if (cell.binding) {
      const field = fields.find(item => item.fieldId === cell.binding!.fieldId || item.path === cell.binding!.path);
      if (!field) throw new Error(`字段 ${cell.binding.path} 仍被工作表 ${sheet.name} 绑定，不能撤销删除`);
      cell.binding.path = field.path; cell.binding.fieldId = field.fieldId; cell.binding.format = field.format;
      cell.numFmt = field.numberFormat ?? (field.format === 'number' ? '#,##0.00' : field.format === 'date' ? 'yyyy-mm-dd' : '@');
    }
  }
}

export const useDesignerStore = defineStore('designer', {
  state: () => ({
    doc: newDocument(),
    templatePackage: null as TemplatePackage | null,
    loadEpoch: 0,
    activeWorksheetId: '',
    selection: { r: 0, c: 0, rows: 1, cols: 1 } as Rect,
    past: [] as TemplateDocument[], future: [] as TemplateDocument[],
    worksheetHistory: {} as Record<string, { past: TemplateDocument[]; future: TemplateDocument[] }>,
    documentReplacements: [] as DocumentReplacement[],
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
      const packagedDocument = copy(replacement); packagedDocument.fields = stableFields(documentFields(replacement));
      const template = createTemplatePackage({ name: replacement.name, worksheets: [{ document: packagedDocument }] });
      const replacementRecord = { fromId, toId: replacement.id, fromPackage: previousPackage, toPackage: copy(template) };
      replacementHistory.set(previous, replacementRecord);
      this.loadEpoch++;
      this.past.push(previous); if (this.past.length > 100) this.past.shift(); this.future = [];
      this.doc = replacement;
      this.selection = { r: 0, c: 0, rows: 1, cols: 1 };
      this.templatePackage = template;
      this.activeWorksheetId = this.templatePackage.worksheets[0].worksheetId;
      this.documentReplacements.push(replacementRecord);
      this.worksheetHistory = { [this.activeWorksheetId]: { past: this.past, future: this.future } };
    },
    loadTemplatePackage(template: TemplatePackage) {
      validateTemplatePackage(template);
      const prepared = copy(template);
      const dictionary = new Map<string, Field>();
      for (const sheet of prepared.worksheets) for (const field of stableFields(documentFields(sheet.document))) {
        const existing = dictionary.get(field.path);
        if (existing && (existing.fieldId !== field.fieldId || existing.format !== field.format || existing.sourceKind !== field.sourceKind
          || existing.datasetId !== field.datasetId || existing.viewId !== field.viewId || existing.sourceFieldId !== field.sourceFieldId))
          throw new Error(`工作表间字段 ${field.path} 定义冲突；请先统一字段 ID、类型和来源`);
        if (!existing) dictionary.set(field.path, field);
      }
      for (const sheet of prepared.worksheets) sheet.document.fields = copy([...dictionary.values()]);
      validateTemplatePackage(prepared);
      const active = prepared.worksheets.find(sheet => sheet.visible) ?? prepared.worksheets[0];
      this.loadEpoch++;
      this.templatePackage = prepared;
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
      active.document = activeDocument;
      synchronizeFields(result, fields);
      result = updateWorksheet(result, active.worksheetId, active.document);
      result.name = this.doc.name;
      for (const sheet of result.worksheets) {
        sheet.document.name = result.name;
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
    associateProject(projectId: string, catalogVersion: string) {
      const template = this.packageSnapshot();
      if (template.projectId !== 'unassigned' && template.projectId !== projectId) throw new Error('当前模板已属于其他项目，请先打开所选项目的模板');
      template.projectId = projectId; template.catalogVersion = catalogVersion; template.revision++;
      validateTemplatePackage(template); this.templatePackage = template;
    },
    importCatalogFields(projectId: string, catalogVersion: string, fields: Field[]) {
      if (!this.templatePackage) throw new Error('请先打开模板');
      if (this.templatePackage.projectId !== 'unassigned' && this.templatePackage.projectId !== projectId)
        throw new Error('当前模板已属于其他项目，请先打开所选项目的模板');
      let count = 0;
      this.commit(doc => {
        for (const field of fields) {
          if (documentFields(doc).some(item => item.path === field.path || item.fieldId === field.fieldId)) continue;
          upsertField(doc, field); count++;
        }
      }, template => { template.projectId = projectId; template.catalogVersion = catalogVersion; });
      return count;
    },
    saveResources(resources: NonNullable<TemplatePackage['resources']>) {
      const template = this.packageSnapshot();
      for (const existing of template.resources ?? []) if (!resources.some(item => item.resourceId === existing.resourceId)
        && (template.pageDefinitions?.some(page => page.imagePlacements?.some(image => image.resourceId === existing.resourceId))
          || template.worksheets.some(sheet => sheet.document.images?.some(image => image.resourceId === existing.resourceId))))
        throw new Error(`图片 ${existing.resourceId} 仍被页面引用，请先删除定位并保存页面`);
      if (resources.some(item => !['image/png', 'image/jpeg', 'image/gif'].includes(item.mediaType))) throw new Error('图片资源仅支持 PNG、JPEG 或导入的 GIF');
      if (resources.reduce((sum, item) => sum + item.base64.length * 3 / 4, 0) > 20 * 1024 * 1024) throw new Error('模板图片资源总量不能超过 20 MiB');
      template.resources = copy(resources); template.revision++;
      validateTemplatePackage(template); this.templatePackage = template;
    },
    updateImage(imageId: string, rect: Rect) {
      this.commit(doc => {
        const image = doc.images?.find(item => item.imageId === imageId);
        if (!image) throw new Error(`图片不存在：${imageId}`);
        image.rect = copy(rect);
      });
    },
    saveViewDraft(definition: DataViewDefinition) {
      validateContract<DataViewDefinition>('dataView', definition);
      const packageState = this.packageSnapshot(); packageState.viewDrafts ??= [];
      const index = packageState.viewDrafts.findIndex(item => item.viewId === definition.viewId && item.version === definition.version);
      if (index < 0) packageState.viewDrafts.push(copy(definition)); else packageState.viewDrafts[index] = copy(definition);
      packageState.revision++; validateTemplatePackage(packageState); this.templatePackage = packageState;
    },
    setViewRefs(refs: Array<{ viewId: string; version: string }>) {
      if (!this.templatePackage) throw new Error('请先打开模板包');
      const packageState = this.packageSnapshot();
      const byId = new Map(packageState.viewRefs.map(ref => [ref.viewId, ref.version]));
      for (const ref of refs) byId.set(ref.viewId, ref.version);
      packageState.viewRefs = [...byId].map(([viewId, version]) => ({ viewId, version })).sort((a, b) => a.viewId.localeCompare(b.viewId));
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
    commit(change: (draft: TemplateDocument) => void, changePackage?: (template: TemplatePackage) => void) {
      const next = ops.transaction(this.doc, change); // validates BEFORE modifying this.doc
      const changes = fieldChanges(stableFields(documentFields(this.doc)), stableFields(documentFields(next)));
      let template: TemplatePackage | undefined;
      if (this.templatePackage) {
        template = copy(this.templatePackage);
        template.worksheets.find(sheet => sheet.worksheetId === this.activeWorksheetId)!.document = copy(next);
        synchronizeFields(template, stableFields(documentFields(next)));
        changePackage?.(template);
        template = updateWorksheet(template, this.activeWorksheetId, template.worksheets.find(sheet => sheet.worksheetId === this.activeWorksheetId)!.document);
      }
      const previous = copy(this.doc); if (changes.length) fieldHistory.set(previous, changes);
      this.past.push(previous);
      if (this.past.length > 100) this.past.shift();
      this.future = []; this.doc = next;
      if (template) { this.templatePackage = template; this.doc = copy(template.worksheets.find(sheet => sheet.worksheetId === this.activeWorksheetId)!.document); }
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
      this.restoreHistory('undo');
    },
    redo() {
      this.restoreHistory('redo');
    },
    restoreHistory(direction: 'undo' | 'redo') {
      const source = direction === 'undo' ? this.past : this.future, target = direction === 'undo' ? this.future : this.past;
      const saved = source.at(-1); if (!saved) return;
      const doc = copy(saved); doc.revision = this.doc.revision + 1;
      const replacement = replacementHistory.get(toRaw(saved));
      const changes = fieldHistory.get(toRaw(saved)) ?? [];
      let template = this.templatePackage ? copy(this.templatePackage) : undefined, worksheetId = this.activeWorksheetId;
      if (replacement) {
        template = direction === 'redo' ? copy(replacement.toPackage) : replacement.fromPackage ? copy(replacement.fromPackage)
          : createTemplatePackage({ name: doc.name, worksheets: [{ document: doc }] });
        worksheetId = template.worksheets.find(sheet => sheet.document.id === doc.id)?.worksheetId ?? template.worksheets[0].worksheetId;
      } else {
        let fields = stableFields(documentFields(this.doc));
        for (const change of changes) {
          const current = fields.find(field => field.path === change.path);
          if (JSON.stringify(current) !== JSON.stringify(change.after)) throw new Error(`字段 ${change.path} 存在较新修改，不能撤销或重做`);
          fields = fields.filter(field => field.path !== change.path); if (change.before) fields.push(copy(change.before));
        }
        // Keep the present dictionary order for unaffected fields; restored fields use the historical order.
        const order = [...documentFields(saved).map(field => field.path), ...fields.map(field => field.path)];
        fields.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path)); doc.fields = copy(fields);
        if (template) {
          template.worksheets.find(sheet => sheet.worksheetId === worksheetId)!.document = copy(doc);
          synchronizeFields(template, fields);
          const normalized = template.worksheets.find(sheet => sheet.worksheetId === worksheetId)!.document;
          doc.cells = copy(normalized.cells);
          template = updateWorksheet(template, worksheetId, normalized);
        }
      }
      ops.validateDocument(doc); if (template) validateTemplatePackage(template);
      const inverse = copy(this.doc);
      if (replacement) replacementHistory.set(inverse, replacement);
      if (changes.length) fieldHistory.set(inverse, changes.map(change => ({ path: change.path, before: change.after, after: change.before })));
      source.pop(); target.push(inverse); if (target.length > 100) target.shift();
      this.doc = doc; if (template) this.templatePackage = template; this.activeWorksheetId = worksheetId;
      if (replacement) this.loadEpoch++;
      if (this.activeWorksheetId) this.worksheetHistory[this.activeWorksheetId] = { past: this.past, future: this.future };
      this.selection = { r: 0, c: 0, rows: 1, cols: 1 };
    },
  },
});
