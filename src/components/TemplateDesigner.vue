<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useDesignerStore } from '../stores/designer.ts';
import { loadDraft, saveDraft } from '../stores/persistence.ts';
import { copy, documentFields, displayText, keyOf, type Field, type Format, type RepeatRegion } from '../domain/model.ts';
import * as ops from '../domain/operations.ts';
import { createCertificateDocument, certificateData } from '../domain/certificate.ts';
import type { DataViewDefinition, PageDefinition, TemplatePackage } from '../core/contracts/types.ts';
import { validateContract } from '../core/contracts/validate.ts';
import { catalogDatasetField } from '../core/catalog/designer-field.ts';
import { generateDocument, type GeneratedResult } from '../domain/generate.ts';
import { mountUniver } from '../adapters/univer.ts';
import { exportTemplate, exportTemplatePackage, downloadBlob, xlsxBlob } from '../export/excel.ts';
import { importTemplatePackage, parseTemplatePackageJson, parseDocumentJson, MAX_FILE_SIZE } from '../export/importExcel.ts';
import { createHostBridge } from '../bridge/host.ts';
import PagedPreview from './preview/PagedPreview.vue';
import { ReportingClient, defaultReportingBaseUrl, type GenerationPageReply, type GenerationReply, type ReportingProject } from '../services/reporting.ts';
import type { ProjectedSheetPage } from '../core/render/page.ts';
import type { PagePlan, ReportingErrorShape, TemplatePackage as ReportingTemplatePackage } from '../core/contracts/types.ts';

const store = useDesignerStore();
const container = ref<HTMLDivElement>(), fileInput = ref<HTMLInputElement>();
const busy = ref(false), projectionError = ref(''), saveStatus = ref('尚未修改'), ready = ref(false);
const hint = ref('导入 Excel 模板后，将左侧字段拖到单元格；明细字段请先设置重复区域。');
const search = ref(''), activeTab = ref('binding'), addressInput = ref('A1');
const zoom = ref(1);
const fieldDialog = ref(false), dataDialog = ref(false), previewDialog = ref(false);
const serviceDialog = ref(false), servicePreviewDialog = ref(false);
const sheetNameInput = ref('');
const dataText = ref(JSON.stringify(certificateData, null, 2));
const generated = ref<GeneratedResult>();
const serviceBaseUrl = ref(defaultReportingBaseUrl), serviceToken = ref('');
const serviceProjects = ref<ReportingProject[]>([]), serviceProjectId = ref(''), serviceDocumentType = ref('');
const serviceBusinessKeyText = ref('{}'), serviceDraftRevision = ref(0), servicePublishedVersion = ref<number>();
const serviceAutoMatch = ref(false), serviceMatchPriority = ref(100), serviceMatchConditionsText = ref('{}');
const serviceError = ref(''), serviceViewSummary = ref(''), serviceGeneration = ref<GenerationReply>();
const serviceErrorIssue = ref<ReportingErrorShape>();
const servicePageNumber = ref(0), servicePageSheets = ref<ProjectedSheetPage[]>([]), servicePageResources = ref<NonNullable<ReportingTemplatePackage['resources']>>([]);
const servicePageDiagnostics = ref<ReportingErrorShape[]>([]), servicePageLoading = ref(false), servicePagePlan = ref<PagePlan>();
const serviceIdempotencyKey = ref('');
const serviceGenerationTemplateLabel = computed(() => {
  const templateRef = serviceGeneration.value?.snapshot.templateRef as { packageId?: string; revision?: number } | undefined;
  return templateRef ? `${templateRef.packageId ?? ''}@${templateRef.revision ?? ''}` : '';
});
const serviceViewDraftCount = computed(() => store.templatePackage?.viewDrafts?.length ?? 0);
const oldPath = ref<string>();
const fieldForm = reactive({ path: '', label: '', format: 'text' as Format, collection: '', group: '', required: false, example: '', numberFormat: '', fieldId: '', sourceKind: 'legacy' as NonNullable<Field['sourceKind']>, datasetId: '', viewId: '', sourceFieldId: '', parameterId: '', unit: '', grain: '', constantValue: '', pageField: 'number' as NonNullable<Field['pageField']> });
const regionForm = reactive({ id: '', name: '', source: '', parentId: '', start: 1, end: 1, empty: 'keep' as 'keep' | 'remove' });
const viewText = ref('');
const viewForm = reactive({ viewId: 'view.new', label: '新数据视图', version: '0.1.0', sourceDatasetId: '', outputFields: '' });
const viewStep = reactive({ kind: 'filter' as 'filter' | 'sort' | 'group' | 'project' | 'pivot' | 'applyFunction', fieldId: '', operator: 'eq' as 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'isNull', value: '', direction: 'asc' as 'asc' | 'desc', configJson: '' });
const pageForm = reactive({ pageDefinitionId: '', regionId: '', label: '主表', pageType: 'main' as PageDefinition['pageType'], paginationMode: 'fixed' as NonNullable<PageDefinition['paginationMode']>, continuationOf: '', paperSize: 'A4' as PageDefinition['paperSize'], orientation: 'portrait' as PageDefinition['orientation'], customWidth: 210, customHeight: 297, top: 10, right: 10, bottom: 10, left: 10, printRow: 1, printCol: 1, printRows: 60, printCols: 12, repeatHeaderRows: '', imagePlacementsJson: '[]', regionLabel: '明细区域', regionKind: 'detail' as PageDefinition['regions'][number]['kind'], viewId: '', paginationGroupId: 'certificate-groups', groupBy: '', recordHeight: 1, capacityRows: 0, emptyPolicy: 'keep' as 'keep' | 'hide', keepGroupsTogether: true, oversizedGroupPolicy: 'error' as 'error' | 'split-records', orderByJson: '[]', mergeFieldIds: '', hideRepeatedFieldIds: '', repeatGroupFieldIds: '', repeatOn: 'all' as 'all' | 'first' | 'last', appendixIfViewHasRecords: '', blankRows: 'keep' as 'keep' | 'remove' });
const form = reactive({ text: '', field: '', format: 'text' as Format, horizontal: 'left' as 'left' | 'center' | 'right', background: '#FFFFFF', rowHeight: 32, colWidth: 140 });
const fields = computed(() => documentFields(store.doc));
const pageDefinitions = computed(() => store.templatePackage?.pageDefinitions ?? []);
const viewDrafts = computed(() => store.templatePackage?.viewDrafts ?? []);
const collections = computed(() => [...new Set(fields.value.map(f => f.collection).filter((s): s is string => !!s))]);
const groups = computed(() => {
  const result = new Map<string, Field[]>();
  for (const field of fields.value) {
    if (search.value && !`${field.label} ${field.path} ${field.group ?? ''}`.toLowerCase().includes(search.value.toLowerCase())) continue;
    const source = field.sourceKind === 'dataset' ? `数据集 · ${field.datasetId}` : field.sourceKind === 'view' ? `视图 · ${field.viewId}`
      : field.sourceKind === 'constant' ? '常量' : field.sourceKind === 'parameter' ? '运行参数' : field.sourceKind === 'page' ? '页面字段'
      : field.collection ? `旧版集合 · ${field.collection}` : '兼容 / 单值字段';
    const group = `${source} / ${field.group || field.collection || '未分组'}`; const list = result.get(group) ?? []; list.push(field); result.set(group, list);
  }
  return [...result.entries()];
});
const bindingCount = computed(() => Object.values(store.doc.cells).filter(c => c.binding).length);
const selectedAddress = computed(() => ops.a1(store.selection.r, store.selection.c));
const selectedRegion = computed(() => [...(store.doc.repeatRegions ?? [])].reverse().find(r => ops.inside(r.rect, store.selection.r, store.selection.c)));
let grid: ReturnType<typeof mountUniver> | undefined, gridShape = '';
let bridge: Awaited<ReturnType<typeof createHostBridge>> | undefined;
let destroyed = false, saveTimer: ReturnType<typeof setTimeout> | undefined;
let persistenceQueue = Promise.resolve();
const MIME = 'application/x-report-designer';
let dragging: string | undefined, hoverKey = '', hoverEffect: DataTransfer['dropEffect'] = 'copy';
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function captureServiceError(error: unknown) {
  serviceError.value = message(error);
  const source = error as { code?: unknown; stage?: unknown; context?: unknown };
  if (!source || typeof source.code !== 'string') { serviceErrorIssue.value = undefined; return; }
  const stages = ['contract', 'collect', 'catalog', 'view', 'rule', 'layout', 'render', 'export', 'repository'];
  serviceErrorIssue.value = { code: source.code as ReportingErrorShape['code'], message: serviceError.value,
    stage: stages.includes(String(source.stage)) ? source.stage as ReportingErrorShape['stage'] : 'contract',
    ...(source.context && typeof source.context === 'object' && !Array.isArray(source.context)
      ? { context: source.context as ReportingErrorShape['context'] } : {}) };
}
function perform(action: () => void) { try { action(); } catch (error) { ElMessage.warning(message(error)); } }
async function performAsync(action: () => Promise<void>) {
  if (busy.value) return; busy.value = true;
  try { await action(); } catch (error) { if (serviceDialog.value || servicePreviewDialog.value) captureServiceError(error); ElMessage.error(message(error)); } finally { busy.value = false; }
}
function persist() {
  const snapshot = store.packageSnapshot(); saveStatus.value = '正在保存草稿…';
  persistenceQueue = persistenceQueue.catch(() => {}).then(() => saveDraft(snapshot)).then(() => {
    if (snapshot.worksheets.some(sheet => sheet.document.revision === store.doc.revision)) saveStatus.value = '草稿已自动保存';
  }).catch(error => { saveStatus.value = message(error); });
}
function syncGrid() {
  if (!container.value) return;
  try {
    const shape = `${store.doc.id}:${store.doc.sheetName}:${store.doc.rows}:${store.doc.cols}:${zoom.value}`;
    if (!grid || gridShape !== shape) {
      grid?.dispose(); container.value.replaceChildren();
      grid = mountUniver(container.value, store.snapshot(), {
        select(rect) { try { store.select(rect); } catch { /* Ignore header selections. */ } }, dragOver, drop,
      }, zoom.value); gridShape = shape;
    } else grid.render(store.snapshot());
    projectionError.value = '';
  } catch (error) { projectionError.value = message(error); }
}
watch(() => [store.doc.revision, store.selection] as const, () => {
  const cell = store.selectedCell;
  form.text = cell?.text ?? ''; form.field = cell?.binding?.path ?? ''; form.format = cell?.binding?.format ?? 'text';
  form.horizontal = cell?.style?.horizontal ?? 'left'; form.background = cell?.style?.background ?? '#FFFFFF';
  form.rowHeight = store.doc.rowHeightPx[store.selection.r] ?? 32; form.colWidth = store.doc.colWidthPx[store.selection.c] ?? 140;
  addressInput.value = selectedAddress.value;
}, { immediate: true });
watch(() => store.doc.revision, () => {
  if (!ready.value) return;
  syncGrid(); generated.value = undefined; saveStatus.value = '有未保存修改';
  clearTimeout(saveTimer); saveTimer = setTimeout(persist, 600);
}, { flush: 'post' });
watch(() => store.templatePackage?.revision, () => {
  if (!ready.value) return;
  saveStatus.value = '有未保存修改'; clearTimeout(saveTimer); saveTimer = setTimeout(persist, 600);
}, { flush: 'post' });
watch(() => store.activeWorksheetId, () => { if (ready.value) {
  syncGrid(); sheetNameInput.value = store.doc.sheetName;
  if (!pageForm.pageDefinitionId) resetNewPageBounds();
} }, { flush: 'post' });
onMounted(async () => {
  try { const draft = await loadDraft(); if (draft) {
    if ('worksheets' in draft) store.loadTemplatePackage(draft); else store.loadDocument(draft);
    store.past = []; sheetNameInput.value = store.doc.sheetName; saveStatus.value = '已恢复本地草稿';
    resetNewPageBounds();
  } }
  catch (error) { saveStatus.value = message(error); }
  if (destroyed) return;
  await nextTick(); ready.value = true; syncGrid();
  try { bridge = await createHostBridge(); if (destroyed) bridge.dispose(); } catch (error) { ElMessage.error(message(error)); }
});
onBeforeUnmount(() => { destroyed = true; clearTimeout(saveTimer); if (ready.value) persist(); grid?.dispose(); bridge?.dispose(); });
function startDrag(event: DragEvent, field: Field) {
  if (!event.dataTransfer) return;
  dragging = field.path; hoverKey = ''; event.dataTransfer.effectAllowed = 'copy';
  hint.value = `正在拖动 ${field.label}，请释放到目标单元格。`;
  event.dataTransfer.setData(MIME, JSON.stringify({ version: 1, kind: 'field', id: field.path }));
}
function endDrag() { dragging = undefined; hoverKey = ''; grid?.preview(); }
function dragOver(r: number, c: number, transfer: DataTransfer) {
  if (!dragging) return;
  const key = `${store.doc.revision}:${dragging}:${r}:${c}`;
  if (hoverKey === key) { transfer.dropEffect = hoverEffect; return; } hoverKey = key;
  let error = '';
  try { ops.transaction(store.doc, doc => ops.bindField(doc, r, c, dragging!, true)); } catch (e) { error = message(e); }
  transfer.dropEffect = hoverEffect = error ? 'none' : 'copy';
  hint.value = error || `释放到 ${ops.a1(r, c)}，替换内容并保留格式（可撤销）`;
  grid?.preview(store.doc.merges.find(m => ops.inside(m, r, c)) ?? { r, c, rows: 1, cols: 1 }, !error);
}
function bind(path: string, r = store.selection.r, c = store.selection.c) {
  store.bind(r, c, path, true); const [ar, ac] = ops.anchor(store.doc, r, c);
  store.select(store.doc.merges.find(m => m.r === ar && m.c === ac) ?? { r: ar, c: ac, rows: 1, cols: 1 });
  grid?.select(store.selection); hint.value = `已绑定 ${ops.a1(ar, ac)} → ${path}，原格式保留，可撤销。`;
}
function drop(r: number, c: number, transfer: DataTransfer) { perform(() => {
  try {
    const raw = transfer.getData(MIME); if (!raw || raw.length > 512) throw new Error('无效字段拖拽');
    const payload = JSON.parse(raw);
    if (payload.version !== 1 || payload.kind !== 'field' || !fields.value.some(f => f.path === payload.id)) throw new Error('未知字段');
    bind(payload.id, r, c);
  } finally { endDrag(); }
}); }
function goToAddress() { perform(() => {
  const match = /^([A-Z]+)([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?$/i.exec(addressInput.value.trim());
  if (!match) throw new Error('请输入 A1 或 A1:F3 格式的地址');
  const column = (s: string) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const r = Number(match[2]) - 1, c = column(match[1]);
  store.select({ r, c, rows: match[4] ? Number(match[4]) - r : 1, cols: match[3] ? column(match[3]) - c + 1 : 1 }); grid?.select(store.selection);
}); }
function openField(field?: Field) {
  oldPath.value = field?.path;
  Object.assign(fieldForm, { path: '', label: '', format: 'text', collection: '', group: '', required: false, example: '', numberFormat: '', fieldId: '', sourceKind: 'legacy', datasetId: '', viewId: '', sourceFieldId: '', parameterId: '', unit: '', grain: '', constantValue: '', pageField: 'number' }, field ?? {}, { sourceKind: field?.sourceKind ?? 'legacy', constantValue: field?.constantValue == null ? '' : String(field.constantValue) });
  fieldDialog.value = true;
}
function saveField() { perform(() => {
  const fieldId = fieldForm.fieldId || `field.${crypto.randomUUID().replaceAll('-', '')}`;
  const field: Field = { path: fieldForm.path.trim(), fieldId, label: fieldForm.label.trim(), format: fieldForm.format, sourceKind: fieldForm.sourceKind,
    collection: fieldForm.collection.trim() || undefined, group: fieldForm.group.trim() || undefined, required: fieldForm.required,
    example: fieldForm.example, numberFormat: fieldForm.numberFormat.trim() || undefined,
    datasetId: fieldForm.datasetId.trim() || undefined, viewId: fieldForm.viewId.trim() || undefined,
    sourceFieldId: fieldForm.sourceFieldId.trim() || undefined, parameterId: fieldForm.parameterId.trim() || undefined,
    unit: fieldForm.unit.trim() || undefined, grain: fieldForm.grain.trim() || undefined,
    pageField: fieldForm.sourceKind === 'page' ? fieldForm.pageField : undefined,
    constantValue: fieldForm.sourceKind === 'constant' ? (fieldForm.format === 'number' ? Number(fieldForm.constantValue)
      : fieldForm.format === 'boolean' ? fieldForm.constantValue === 'true' : fieldForm.constantValue) : undefined };
  if (field.sourceKind === 'constant' && field.format === 'number' && !Number.isFinite(field.constantValue)) throw new Error('数字常量必须是有效数字');
  if (field.sourceKind === 'constant' && field.format === 'boolean' && !['true', 'false'].includes(fieldForm.constantValue)) throw new Error('布尔常量请选择 true 或 false');
  if (field.sourceKind === 'dataset' && !field.datasetId) throw new Error('数据源字段必须选择数据集');
  if (field.sourceKind === 'view' && !field.viewId) throw new Error('视图字段必须选择视图');
  if (field.sourceKind === 'view' && !field.sourceFieldId) field.sourceFieldId = field.path;
  store.saveField(field, oldPath.value);
  fieldDialog.value = false; ElMessage.success('字段已保存');
}); }
function fieldUsage(path: string) {
  const otherSheets = store.worksheets.filter(sheet => sheet.worksheetId !== store.activeWorksheetId);
  return Object.values(store.doc.cells).filter(cell => cell.binding?.path === path).length
    + otherSheets.reduce((sum, sheet) => sum + Object.values(sheet.document.cells).filter(cell => cell.binding?.path === path).length, 0);
}
function loadViewDraft(view?: DataViewDefinition) {
  const selected = view ?? viewDrafts.value.at(-1) ?? {
  contractVersion: 2, viewId: 'view.new', label: '新数据视图', version: '0.1.0', sourceDatasetId: '', outputFields: [], steps: [],
  };
  Object.assign(viewForm, { viewId: selected.viewId, label: selected.label, version: selected.version, sourceDatasetId: selected.sourceDatasetId, outputFields: selected.outputFields.join(',') });
  viewText.value = JSON.stringify(selected, null, 2);
}
function appendViewStep() { perform(() => {
  const definition = JSON.parse(viewText.value || '{}') as Partial<DataViewDefinition>;
  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  if (viewStep.kind === 'filter') {
    if (!viewStep.fieldId.trim()) throw new Error('筛选需要字段 ID');
    let value: string | number = viewStep.value;
    if (['gt', 'gte', 'lt', 'lte'].includes(viewStep.operator)) {
      value = Number(viewStep.value); if (!Number.isFinite(value)) throw new Error('数值筛选请输入有效数字');
    }
    steps.push({ op: 'filter', fieldId: viewStep.fieldId.trim(), operator: viewStep.operator, ...(viewStep.operator !== 'isNull' ? { value } : {}) } as DataViewDefinition['steps'][number]);
  } else if (viewStep.kind === 'sort') {
    if (!viewStep.fieldId.trim()) throw new Error('排序需要字段 ID');
    steps.push({ op: 'sort', by: [{ fieldId: viewStep.fieldId.trim(), direction: viewStep.direction }] });
  } else {
    const step: unknown = JSON.parse(viewStep.configJson);
    if (!step || typeof step !== 'object' || Array.isArray(step) || (step as { op?: unknown }).op !== viewStep.kind)
      throw new Error(`步骤 JSON 的 op 必须是 ${viewStep.kind}`);
    steps.push(step as DataViewDefinition['steps'][number]);
  }
  Object.assign(definition, { contractVersion: 2, viewId: viewForm.viewId.trim(), label: viewForm.label.trim(), version: viewForm.version.trim(),
    sourceDatasetId: viewForm.sourceDatasetId.trim(), outputFields: viewForm.outputFields.split(',').map(value => value.trim()).filter(Boolean), steps });
  viewText.value = JSON.stringify(definition, null, 2); ElMessage.success('已追加受控视图步骤');
}); }
function saveViewDraft() { perform(() => {
  const definition = JSON.parse(viewText.value) as Record<string, unknown>;
  Object.assign(definition, { contractVersion: 2, viewId: viewForm.viewId.trim(), label: viewForm.label.trim(), version: viewForm.version.trim(),
    sourceDatasetId: viewForm.sourceDatasetId.trim(), outputFields: viewForm.outputFields.split(',').map(value => value.trim()).filter(Boolean) });
  const value: unknown = definition; validateContract<DataViewDefinition>('dataView', value);
  store.saveViewDraft(value); ElMessage.success('视图草稿已保存并版本化');
}); }
function loadPage(page: PageDefinition, regionId?: string) {
  const region = page.regions.find(item => item.regionId === regionId) ?? page.regions.find(item => item.worksheetId === store.activeWorksheetId);
  if (region?.worksheetId === store.activeWorksheetId) store.select(region.rect);
  Object.assign(pageForm, { pageDefinitionId: page.pageDefinitionId, regionId: region?.regionId ?? '', label: page.label,
    pageType: page.pageType, paginationMode: page.paginationMode ?? 'fixed', continuationOf: page.continuationOf ?? '', paperSize: page.paperSize, orientation: page.orientation,
    customWidth: page.customPaperMm?.width ?? 210, customHeight: page.customPaperMm?.height ?? 297,
    top: page.marginsMm.top, right: page.marginsMm.right, bottom: page.marginsMm.bottom, left: page.marginsMm.left,
    printRow: (page.printableRect?.r ?? 0) + 1, printCol: (page.printableRect?.c ?? 0) + 1,
    printRows: page.printableRect?.rows ?? store.doc.rows, printCols: page.printableRect?.cols ?? store.doc.cols,
    repeatHeaderRows: page.repeatHeaderRows?.map(row => String(row + 1)).join(',') ?? '',
    imagePlacementsJson: JSON.stringify(page.imagePlacements ?? [], null, 2),
    regionLabel: region?.label ?? '明细区域', regionKind: region?.kind === 'detail' ? 'detail' : region?.kind ?? 'detail',
    viewId: region?.viewId ?? '', paginationGroupId: region?.paginationGroupId ?? 'certificate-groups',
    groupBy: region?.groupBy?.join(',') ?? '', recordHeight: region?.recordHeight ?? region?.rect.rows ?? 1,
    capacityRows: region?.capacityRows ?? 0, emptyPolicy: region?.emptyPolicy ?? 'keep', keepGroupsTogether: region?.keepGroupsTogether ?? true,
    oversizedGroupPolicy: region?.oversizedGroupPolicy ?? 'error', orderByJson: JSON.stringify(region?.orderBy ?? [], null, 2),
    mergeFieldIds: region?.mergeFieldIds?.join(',') ?? '', hideRepeatedFieldIds: region?.hideRepeatedFieldIds?.join(',') ?? '',
    repeatGroupFieldIds: region?.repeatGroupFieldIds?.join(',') ?? '', repeatOn: region?.repeatOn ?? 'all',
    appendixIfViewHasRecords: region?.appendixIfViewHasRecords ?? '', blankRows: region?.blankRows ?? 'keep' });
}
function resetNewPageBounds() {
  Object.assign(pageForm, { printRow: 1, printCol: 1, printRows: store.doc.rows, printCols: store.doc.cols });
}
function startContinuation(page: PageDefinition) { perform(() => {
  const region = page.regions.find(item => item.kind === 'detail' && item.worksheetId === store.activeWorksheetId);
  if (!region) throw new Error('主页面没有属于当前工作表的明细区');
  Object.assign(pageForm, { pageDefinitionId: '', regionId: region.regionId, label: `${page.label}续页`, pageType: 'continuation', paginationMode: page.paginationMode ?? 'fixed', continuationOf: page.pageDefinitionId,
    paperSize: page.paperSize, orientation: page.orientation, customWidth: page.customPaperMm?.width ?? 210, customHeight: page.customPaperMm?.height ?? 297,
    top: page.marginsMm.top, right: page.marginsMm.right, bottom: page.marginsMm.bottom, left: page.marginsMm.left,
    printRow: (page.printableRect?.r ?? 0) + 1, printCol: (page.printableRect?.c ?? 0) + 1,
    printRows: page.printableRect?.rows ?? store.doc.rows, printCols: page.printableRect?.cols ?? store.doc.cols,
    repeatHeaderRows: page.repeatHeaderRows?.map(row => String(row + 1)).join(',') ?? '', imagePlacementsJson: JSON.stringify(page.imagePlacements ?? [], null, 2),
    regionLabel: region.label, regionKind: 'detail', viewId: region.viewId ?? '', paginationGroupId: region.paginationGroupId ?? '',
    groupBy: region.groupBy?.join(',') ?? '', recordHeight: region.recordHeight ?? region.rect.rows, capacityRows: region.capacityRows ?? 0,
    emptyPolicy: region.emptyPolicy ?? 'keep', keepGroupsTogether: region.keepGroupsTogether ?? true, oversizedGroupPolicy: region.oversizedGroupPolicy ?? 'error',
    orderByJson: JSON.stringify(region.orderBy ?? [], null, 2), mergeFieldIds: region.mergeFieldIds?.join(',') ?? '',
    hideRepeatedFieldIds: region.hideRepeatedFieldIds?.join(',') ?? '', repeatGroupFieldIds: region.repeatGroupFieldIds?.join(',') ?? '',
    repeatOn: region.repeatOn ?? 'all', appendixIfViewHasRecords: region.appendixIfViewHasRecords ?? '', blankRows: region.blankRows ?? 'keep' });
}); }
function savePageConfiguration() { perform(() => {
  const pageDefinitionId = pageForm.pageDefinitionId || `page.${crypto.randomUUID().replaceAll('-', '')}`;
  const rect = { r: store.selection.r, c: store.selection.c, rows: store.selection.rows, cols: store.selection.cols };
  const existing = pageDefinitions.value.find(page => page.pageDefinitionId === pageDefinitionId);
  const parent = pageForm.pageType === 'continuation' ? pageDefinitions.value.find(page => page.pageDefinitionId === pageForm.continuationOf) : undefined;
  if (pageForm.pageType === 'continuation' && (!parent || parent.pageType !== 'main')) throw new Error('续页必须引用已保存的主页面');
  const regionId = pageForm.regionId || `region.${crypto.randomUUID().replaceAll('-', '')}`;
  const orderBy: unknown = JSON.parse(pageForm.orderByJson || '[]');
  if (!Array.isArray(orderBy) || orderBy.some(item => !item || typeof item.fieldId !== 'string' || !['asc', 'desc'].includes(item.direction))) throw new Error('排序规则必须是字段 ID 与 asc/desc 方向的数组');
  const fieldIds = (value: string) => [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
  const region = { regionId, worksheetId: store.activeWorksheetId, label: pageForm.regionLabel.trim() || '页面区域', kind: pageForm.regionKind, rect,
    ...(pageForm.regionKind !== 'detail' ? { repeatOn: pageForm.repeatOn } : {}), blankRows: pageForm.blankRows,
    ...(['detail', 'groupHeader', 'groupFooter'].includes(pageForm.regionKind) ? { viewId: pageForm.viewId.trim(), paginationGroupId: pageForm.paginationGroupId.trim(),
      groupBy: pageForm.groupBy.split(',').map(value => value.trim()).filter(Boolean), recordHeight: Math.max(1, pageForm.recordHeight),
      ...(pageForm.capacityRows > 0 ? { capacityRows: pageForm.capacityRows } : {}), emptyPolicy: pageForm.emptyPolicy,
      keepGroupsTogether: pageForm.keepGroupsTogether, oversizedGroupPolicy: pageForm.oversizedGroupPolicy,
      orderBy: orderBy as PageDefinition['regions'][number]['orderBy'], mergeFieldIds: fieldIds(pageForm.mergeFieldIds),
      hideRepeatedFieldIds: fieldIds(pageForm.hideRepeatedFieldIds), repeatGroupFieldIds: fieldIds(pageForm.repeatGroupFieldIds),
      ...(pageForm.appendixIfViewHasRecords.trim() ? { appendixIfViewHasRecords: pageForm.appendixIfViewHasRecords.trim() } : {}) } : {}) } as PageDefinition['regions'][number];
  const imagePlacements: unknown = JSON.parse(pageForm.imagePlacementsJson || '[]');
  if (!Array.isArray(imagePlacements)) throw new Error('图片定位必须是数组');
  const repeatHeaderRows = fieldIds(pageForm.repeatHeaderRows).map(value => Number(value) - 1);
  if (repeatHeaderRows.some(row => !Number.isInteger(row) || row < 0)) throw new Error('重复表头行请输入有效的 1 起始行号');
  if (![pageForm.printRow, pageForm.printCol, pageForm.printRows, pageForm.printCols].every(Number.isInteger)
    || pageForm.printRow < 1 || pageForm.printCol < 1 || pageForm.printRows < 1 || pageForm.printCols < 1) throw new Error('打印范围必须使用正整数');
  if (pageForm.paperSize === 'custom' && (![pageForm.customWidth, pageForm.customHeight].every(Number.isFinite) || pageForm.customWidth <= 0 || pageForm.customHeight <= 0)) throw new Error('自定义纸张宽高必须大于 0');
  const regions = (existing?.regions ?? parent?.regions ?? []).filter(item => item.regionId !== regionId);
  regions.push(region);
  const definition: PageDefinition = { pageDefinitionId, label: pageForm.label.trim() || '页面定义', pageType: pageForm.pageType, paginationMode: pageForm.paginationMode,
    worksheetIds: [...new Set([...(existing?.worksheetIds ?? parent?.worksheetIds ?? []), store.activeWorksheetId])], paperSize: pageForm.paperSize, orientation: pageForm.orientation,
    ...(pageForm.paperSize === 'custom' ? { customPaperMm: { width: pageForm.customWidth, height: pageForm.customHeight } } : {}),
    marginsMm: { top: pageForm.top, right: pageForm.right, bottom: pageForm.bottom, left: pageForm.left },
    printableRect: { r: pageForm.printRow - 1, c: pageForm.printCol - 1, rows: pageForm.printRows, cols: pageForm.printCols },
    ...(repeatHeaderRows.length ? { repeatHeaderRows } : {}), ...(imagePlacements.length ? { imagePlacements: imagePlacements as PageDefinition['imagePlacements'] } : {}),
    ...(pageForm.continuationOf ? { continuationOf: pageForm.continuationOf } : {}), regions };
  store.savePageDefinition(definition); pageForm.pageDefinitionId = pageDefinitionId; pageForm.regionId = regionId;
  ElMessage.success('页面和区域配置已保存');
}); }
function editRegion(region?: RepeatRegion) {
  activeTab.value = 'repeat';
  Object.assign(regionForm, region ? { ...region, start: region.rect.r + 1, end: region.rect.r + region.rect.rows, parentId: region.parentId ?? '' }
    : { id: '', name: '', source: collections.value[0] ?? '', parentId: '', start: store.selection.r + 1, end: store.selection.r + store.selection.rows, empty: 'keep' });
}
function saveRegion() { perform(() => {
  const existing = store.doc.repeatRegions?.find(r => r.id === regionForm.id);
  const parent = store.doc.repeatRegions?.find(r => r.id === regionForm.parentId);
  store.saveRegion({ id: regionForm.id || crypto.randomUUID(), name: regionForm.name.trim(), source: regionForm.source,
    parentId: regionForm.parentId || undefined, empty: regionForm.empty,
    rect: { r: regionForm.start - 1, rows: regionForm.end - regionForm.start + 1,
      c: existing?.rect.c ?? (parent ? store.selection.c : 0), cols: existing?.rect.cols ?? (parent ? store.selection.cols : store.doc.cols) } });
  regionForm.id = ''; ElMessage.success('明细区域已保存，现在可以拖入该集合字段');
}); }
async function importSelected(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''; if (!file) return;
  await performAsync(async () => {
    const jsonFile = /\.json$/i.test(file.name);
    if (file.size > (jsonFile ? 40 * 1024 * 1024 : MAX_FILE_SIZE)) throw new Error(jsonFile ? '模板 JSON 不能超过 40 MiB' : 'Excel 文件不能超过 20 MiB');
    if (/\.json$/i.test(file.name)) {
      const text = await file.text();
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && 'worksheets' in value) loadImportedPackage(parseTemplatePackageJson(text));
      else store.loadDocument(parseDocumentJson(text));
      ElMessage.success('模板已打开'); return;
    }
    if (!/\.xlsx$/i.test(file.name)) throw new Error('请选择 .xlsx 模板或已保存的模板 JSON');
    const bytes = new Uint8Array(await file.arrayBuffer());
    loadImportedPackage(await importTemplatePackage(bytes, file.name)); ElMessage.success(`已导入 ${store.worksheets.length} 个工作表，可开始拖拽绑定`);
  });
}
function loadImportedPackage(template: TemplatePackage) {
  for (const sheet of template.worksheets) sheet.document.fields ??= copy(fields.value);
  store.loadTemplatePackage(template); sheetNameInput.value = store.doc.sheetName;
  Object.assign(pageForm, { pageDefinitionId: '', regionId: '' }); resetNewPageBounds();
  loadViewDraft(viewDrafts.value[0]);
}
function loadSample() { perform(() => { store.loadDocument(createCertificateDocument()); dataText.value = JSON.stringify(certificateData, null, 2); hint.value = '质保书示例包含按炉号分组、嵌套化学分析、力学性能和无损检测。'; }); }
function readData(): unknown { if (dataText.value.length > 5 * 1024 * 1024) throw new Error('业务 JSON 不能超过 5 MiB'); return JSON.parse(dataText.value); }
function inferDataFields() { perform(() => { const count = store.inferFields(readData()); ElMessage.success(`已新增 ${count} 个字段，已有字段定义保持不变`); }); }
function previewData() { perform(() => { generated.value = generateDocument(store.snapshot(), readData()); dataDialog.value = false; previewDialog.value = true; }); }
function saveTemplate() { void performAsync(async () => {
  const snapshot = store.packageSnapshot(), bytes = await exportTemplatePackage(snapshot);
  if (bridge) { const result = await bridge.savePackage(`${snapshot.name}.xlsx`, bytes, snapshot); ElMessage.success(result.status === 'acknowledged' ? '宿主已确认保存模板包' : '已下载模板包；当前宿主未协商包级协议 v2'); }
  else { downloadBlob(xlsxBlob(bytes), `${snapshot.name}.xlsx`); ElMessage.success('已发起模板包下载'); }
  persist();
}); }
function exportJson() { const snapshot = store.packageSnapshot(); downloadBlob(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }), `${snapshot.name}.json`); }
function exportGenerated() { void performAsync(async () => {
  if (!generated.value) return;
  const bytes = await exportTemplate(generated.value.document, { embed: false, rowMap: generated.value.rowMap });
  downloadBlob(xlsxBlob(bytes), `${store.doc.name}-生成结果.xlsx`); ElMessage.success('已发起生成结果下载');
}); }
function reportingClient() { return new ReportingClient(serviceBaseUrl.value, serviceToken.value); }
function serviceProjectChanged() {
  const project = serviceProjects.value.find(item => item.projectId === serviceProjectId.value); if (!project) return;
  serviceDocumentType.value = project.documentTypes[0] ?? '';
  const examples: Record<string, string> = {};
  for (const [key, definition] of Object.entries(project.businessKey)) {
    examples[key] = key.toLowerCase().includes('printno') ? 'DEMO-CERT-001'
      : key.toLowerCase().includes('productpart') ? 'T'
      : key.toLowerCase().includes('certificaterequestid') ? 'MES-DEMO-9001' : '';
    if (!definition.required && !examples[key]) examples[key] = '';
  }
  serviceBusinessKeyText.value = JSON.stringify(examples, null, 2);
  serviceAutoMatch.value = false; serviceMatchConditionsText.value = '{}'; serviceMatchPriority.value = 100;
  serviceDraftRevision.value = 0; servicePublishedVersion.value = undefined; serviceIdempotencyKey.value = '';
  serviceViewSummary.value = ''; serviceError.value = '';
  void refreshServiceTemplateState();
}
async function openReporting() {
  serviceDialog.value = true; serviceError.value = ''; serviceErrorIssue.value = undefined;
  try {
    serviceProjects.value = await reportingClient().getProjects();
    if (!serviceProjects.value.length) throw new Error('当前身份没有可访问的项目');
    if (!serviceProjects.value.some(item => item.projectId === serviceProjectId.value)) serviceProjectId.value = serviceProjects.value[0].projectId;
    serviceProjectChanged();
  } catch (error) { serviceError.value = message(error); }
}
async function refreshServiceTemplateState() {
  if (!serviceProjectId.value || !store.templatePackage) return;
  const client = reportingClient(), id = store.templatePackage.packageId;
  try { const draft = await client.getTemplateDraft(serviceProjectId.value, id); serviceDraftRevision.value = draft.revision; }
  catch (error) { if ((error as { code?: string }).code !== 'DATA_NOT_FOUND') serviceError.value = message(error); else serviceDraftRevision.value = 0; }
  try { const versions = await client.getTemplateVersions(serviceProjectId.value, id); servicePublishedVersion.value = versions.at(-1)?.version; }
  catch (error) { if ((error as { code?: string }).code !== 'DATA_NOT_FOUND') serviceError.value = message(error); }
}
function serviceBusinessKey(): Record<string, string> {
  const value: unknown = JSON.parse(serviceBusinessKeyText.value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('业务单号参数必须是 JSON 对象');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== 'string')) throw new Error('业务单号参数值必须使用文本');
  return Object.fromEntries(entries) as Record<string, string>;
}
function importServiceCatalog() { void performAsync(async () => {
  const catalog = await reportingClient().getCatalog(serviceProjectId.value); let count = 0;
  for (const item of catalog.fields) {
    const field = catalogDatasetField(item);
    if (!field) continue;
    if (fields.value.some(field => field.fieldId === item.fieldId || field.path === item.fieldId)) continue;
    store.saveField(field);
    count++;
  }
  ElMessage.success(`已从项目目录新增 ${count} 个字段，现有手工字段保持不变`);
}); }
function testServiceViews() { void performAsync(async () => {
  const result = await reportingClient().previewViews(serviceProjectId.value, { documentType: serviceDocumentType.value, businessKey: serviceBusinessKey() });
  serviceViewSummary.value = `试算完成：${result.views.length} 个视图，${result.views.reduce<number>((sum, view) => sum + Number((view as { outputRecordCount?: number }).outputRecordCount ?? 0), 0)} 条输出记录，目录版本 ${result.catalogVersion}`;
}); }
function publishServiceViews() { void performAsync(async () => {
  const drafts = store.templatePackage?.viewDrafts ?? [];
  if (!drafts.length) throw new Error('当前模板包没有本地视图草稿');
  const client = reportingClient(), published: string[] = [];
  for (const definition of drafts) {
    let revision = 0;
    try { revision = (await client.getViewDraft(serviceProjectId.value, definition.viewId)).revision; }
    catch (error) { if ((error as { code?: string }).code !== 'DATA_NOT_FOUND') throw error; }
    await client.saveViewDraft(serviceProjectId.value, definition, revision);
    const result = await client.publishView(serviceProjectId.value, definition.viewId);
    published.push(`${definition.viewId}@${result.version}`);
  }
  serviceViewSummary.value = `已发布 ${published.length} 个项目视图：${published.join('、')}`;
}); }
function saveServiceTemplate() { void performAsync(async () => {
  if (!store.templatePackage) throw new Error('请先导入 Excel 模板或创建模板包');
  const template = store.packageSnapshot() as ReportingTemplatePackage;
  template.projectId = serviceProjectId.value; template.status = 'draft';
  const saved = await reportingClient().saveTemplateDraft(serviceProjectId.value, template, serviceDraftRevision.value);
  serviceDraftRevision.value = saved.revision; servicePublishedVersion.value = undefined;
  serviceError.value = ''; ElMessage.success(`模板草稿已保存，修订号 ${saved.revision}`);
}); }
function publishServiceTemplate() { void performAsync(async () => {
  if (!serviceDraftRevision.value) throw new Error('请先将模板草稿保存到服务端');
  const record = await reportingClient().publishTemplate(serviceProjectId.value, store.templatePackage!.packageId);
  servicePublishedVersion.value = record.version; serviceError.value = '';
  ElMessage.success(`模板已发布为不可变版本 ${record.version}`);
}); }
function saveServiceMatchRule() { void performAsync(async () => {
  if (!servicePublishedVersion.value || !store.templatePackage) throw new Error('请先发布当前模板');
  const conditions: unknown = JSON.parse(serviceMatchConditionsText.value || '{}');
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)
    || Object.values(conditions as Record<string, unknown>).some(value => typeof value !== 'string'))
    throw new Error('自动匹配条件必须是“业务参数名：文本值”的 JSON 对象');
  await reportingClient().setTemplateMatchRule(serviceProjectId.value, store.templatePackage.packageId, servicePublishedVersion.value,
    { documentType: serviceDocumentType.value, conditions: conditions as Record<string, string>, priority: serviceMatchPriority.value });
  serviceError.value = ''; ElMessage.success(`模板版本 ${servicePublishedVersion.value} 的自动匹配规则已保存`);
}); }
async function loadServicePage(pageNumber: number) {
  if (!serviceGeneration.value) return;
  servicePageLoading.value = true;
  try {
    const result: GenerationPageReply = await reportingClient().getPage(serviceProjectId.value, serviceGeneration.value.generationId, pageNumber);
    servicePageNumber.value = result.pageNumber; servicePageSheets.value = result.sheets;
    servicePageResources.value = result.resources; servicePageDiagnostics.value = result.diagnostics as ReportingErrorShape[];
  } catch (error) { captureServiceError(error); }
  finally { servicePageLoading.value = false; }
}
function generateFromService(mode: 'preview' | 'issue') { void performAsync(async () => {
  serviceError.value = ''; serviceErrorIssue.value = undefined;
  if (!serviceAutoMatch.value && !store.templatePackage) throw new Error('请先导入并配置模板');
  if (!serviceAutoMatch.value && !servicePublishedVersion.value) throw new Error('请先保存并发布模板');
  serviceIdempotencyKey.value ||= crypto.randomUUID();
  const request = {
    mode, documentType: serviceDocumentType.value, businessKey: serviceBusinessKey(),
    ...(!serviceAutoMatch.value ? { templateRef: { id: store.templatePackage!.packageId, version: servicePublishedVersion.value! } } : { autoMatch: true }),
    idempotencyKey: serviceIdempotencyKey.value,
  } as const;
  const reply = await reportingClient().generate(serviceProjectId.value, request);
  serviceGeneration.value = reply; servicePagePlan.value = reply.snapshot.pagePlan as PagePlan;
  serviceError.value = ''; serviceDialog.value = false; servicePreviewDialog.value = true;
  await loadServicePage(1); serviceIdempotencyKey.value = '';
}); }
function downloadServiceGeneration() { void performAsync(async () => {
  if (!serviceGeneration.value) return;
  const blob = await reportingClient().getFile(serviceProjectId.value, serviceGeneration.value.generationId);
  if (bridge) {
    const output = serviceGeneration.value.snapshot.output as { sha256?: string } | undefined;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await bridge.saveGenerated(`${store.doc.name}-${serviceGeneration.value.generationId}.xlsx`, bytes,
      { projectId: serviceProjectId.value, generationId: serviceGeneration.value.generationId, sha256: output?.sha256 ?? '' });
    ElMessage.success(result.status === 'acknowledged' ? '宿主已保存与预览对应的生成文件' : '已下载生成文件；当前宿主未协商文件保存协议 v2');
  } else { downloadBlob(blob, `${store.doc.name}-${serviceGeneration.value.generationId}.xlsx`); ElMessage.success('已下载与分页预览对应的服务端生成文件'); }
}); }
function downloadServicePdf() { void performAsync(async () => {
  if (!serviceGeneration.value?.pdfUrl) return;
  const blob = await reportingClient().getPdf(serviceProjectId.value, serviceGeneration.value.generationId);
  downloadBlob(blob, `${store.doc.name}-${serviceGeneration.value.generationId}.pdf`);
  ElMessage.success('已下载按原生成快照制作的 PDF');
}); }
function reprintServiceGeneration() { void performAsync(async () => {
  if (!serviceGeneration.value) return;
  await reportingClient().reprint(serviceProjectId.value, serviceGeneration.value.generationId);
  const blob = await reportingClient().getFile(serviceProjectId.value, serviceGeneration.value.generationId);
  if (bridge) {
    const output = serviceGeneration.value.snapshot.output as { sha256?: string } | undefined;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await bridge.saveGenerated(`${store.doc.name}-${serviceGeneration.value.generationId}-重印.xlsx`, bytes,
      { projectId: serviceProjectId.value, generationId: serviceGeneration.value.generationId, sha256: output?.sha256 ?? '' });
    ElMessage.success(result.status === 'acknowledged' ? '宿主已从原快照保存重印文件' : '已下载重印文件；使用的是原快照且未重新采集');
  } else { downloadBlob(blob, `${store.doc.name}-${serviceGeneration.value.generationId}-重印.xlsx`); ElMessage.success('已从原生成快照重印，未重新采集数据'); }
}); }
function locateServiceIssue(issue: ReportingErrorShape) {
  const context = issue.context;
  if (context?.worksheetId && store.worksheets.some(item => item.worksheetId === context.worksheetId)) store.switchWorksheet(context.worksheetId);
  if (context?.cell && /^[A-Z]+[1-9]\d*$/i.test(context.cell)) {
    addressInput.value = context.cell; goToAddress();
  }
  servicePreviewDialog.value = false; serviceDialog.value = false;
}
const previewTable = computed(() => {
  const doc = generated.value?.document; if (!doc) return [];
  const end = Math.max(doc.rows, Object.keys(doc.cells).reduce((n, k) => Math.max(n, Number(k.split(':')[0]) + 1), 1));
  return Array.from({ length: end }, (_, r) => Array.from({ length: doc.cols }, (_, c) => {
    const merge = doc.merges.find(m => ops.inside(m, r, c)); if (merge && (merge.r !== r || merge.c !== c)) return undefined;
    const cell = doc.cells[keyOf(r, c)], style = cell?.style;
    return { key: c, text: cell ? displayText(cell, doc.syntax) : '', rowspan: merge?.rows ?? 1, colspan: merge?.cols ?? 1,
      style: { background: style?.background, color: style?.color, fontWeight: style?.bold ? 'bold' : 'normal', textAlign: style?.horizontal ?? 'left', whiteSpace: 'pre-wrap' as const } };
  }).filter((cell): cell is NonNullable<typeof cell> => !!cell));
});
</script>

<template>
  <div class="designer" :aria-busy="busy">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">▦</span><div><strong>单据模板设计器</strong><small>EXCEL TEMPLATE STUDIO</small></div></div>
      <span class="save-status">{{ saveStatus }}</span>
      <button :disabled="busy || !ready" @click="fileInput?.click()">导入 / 打开模板</button>
      <button :disabled="busy || !ready" @click="dataDialog = true">业务数据 / 生成</button>
      <button :disabled="busy || !ready" @click="openReporting">项目服务 / 分页生成</button>
      <button class="primary" :disabled="busy || !ready || !!projectionError" @click="saveTemplate">{{ busy ? '处理中…' : '保存模板 Excel' }}</button>
      <input ref="fileInput" hidden type="file" accept=".xlsx,.json" @change="importSelected" />
    </header>
    <aside class="materials">
      <div class="panel-heading"><h3>字段字典 <span>{{ fields.length }}</span></h3><button class="small primary" @click="openField()">＋ 新增</button></div>
      <input v-model="search" aria-label="搜索字段" placeholder="搜索名称、路径或分组" />
      <button class="wide subtle" @click="dataDialog = true">从 JSON 数据自动生成字段</button>
      <p class="muted">拖拽到单元格，或双击绑定到当前选区。多行字段带有集合名称。</p>
      <p v-if="!groups.length" class="muted">没有匹配的字段</p>
      <section v-for="[name, list] in groups" :key="name">
        <h4>{{ name }} <span>{{ list.length }}</span></h4>
        <div v-for="field in list" :key="field.path" class="field" draggable="true" :data-field="field.path" @dragstart="startDrag($event, field)" @dragend="endDrag" @dblclick="perform(() => bind(field.path))">
          <div class="field-line"><span class="type-badge">{{ field.format === 'number' ? '#' : field.format === 'date' ? '日' : field.format === 'boolean' ? '✓' : 'T' }}</span><strong>{{ field.label }}</strong><span v-if="field.required" class="required">*</span><button class="icon" :aria-label="`编辑${field.label}`" @click.stop="openField(field)">✎</button></div>
          <small>{{ field.path }} · {{ field.fieldId ?? '旧路径绑定' }}</small><span v-if="field.collection" class="collection-tag">多行 · {{ field.collection }}</span><span v-if="field.unit || field.grain" class="collection-tag">{{ field.unit || '' }}{{ field.grain ? ` · ${field.grain}` : '' }}</span><small>已使用 {{ fieldUsage(field.path) }} 处</small>
        </div>
      </section>
    </aside>
    <main class="canvas-panel">
      <div class="document-bar"><input :value="store.doc.name" aria-label="模板名称" @change="perform(() => store.commit(d => { d.name = ($event.target as HTMLInputElement).value.trim() || '未命名模板'; }))" /><select :value="store.activeWorksheetId" aria-label="当前工作表" @change="perform(() => store.switchWorksheet(($event.target as HTMLSelectElement).value))"><option v-for="sheet in store.worksheets" :key="sheet.worksheetId" :value="sheet.worksheetId">{{ sheet.name }}</option></select><button class="small" @click="perform(() => store.addWorksheet())">＋ 工作表</button><input v-model="sheetNameInput" aria-label="工作表名称" /><button class="small" @click="perform(() => store.renameActiveWorksheet(sheetNameInput))">重命名</button><span>{{ store.doc.rows }} 行 × {{ store.doc.cols }} 列</span><button class="small" @click="loadSample">质保书示例</button></div>
      <div class="toolbar"><input v-model="addressInput" aria-label="单元格地址" @keydown.enter="goToAddress" /><button class="small" @click="goToAddress">定位</button><i></i><button class="small" :disabled="!store.canUndo" @click="store.undo()">撤销</button><button class="small" :disabled="!store.canRedo" @click="store.redo()">重做</button><i></i><button class="small" @click="editRegion()">＋ 设置明细区域</button><button class="small" @click="exportJson">保存 JSON</button><select v-model.number="zoom" aria-label="画布缩放" @change="syncGrid"><option :value="0.4">40%</option><option :value="0.5">50%</option><option :value="0.75">75%</option><option :value="1">100%</option><option :value="1.25">125%</option></select></div>
      <div v-if="projectionError" class="error-box">{{ projectionError }} <button @click="syncGrid">重试加载画布</button></div>
      <details v-if="store.doc.excelSource?.warnings.length" class="import-notice"><summary>已导入 {{ store.doc.excelSource.fileName }} · 查看导入说明</summary><p v-for="warning in store.doc.excelSource.warnings" :key="warning">{{ warning }}</p></details>
      <div ref="container" class="canvas" @dragover.prevent @drop.prevent />
      <footer class="statusbar"><span>{{ hint }}</span><b>{{ bindingCount }} 个绑定 · {{ store.doc.repeatRegions?.length ?? 0 }} 个明细区域</b></footer>
    </main>
    <aside class="properties">
      <div class="tabs"><button :class="{ active: activeTab === 'binding' }" @click="activeTab = 'binding'">单元格</button><button :class="{ active: activeTab === 'repeat' }" @click="activeTab = 'repeat'">旧式扩行</button><button :class="{ active: activeTab === 'views' }" @click="activeTab = 'views'; loadViewDraft()">数据视图</button><button :class="{ active: activeTab === 'pages' }" @click="activeTab = 'pages'">分页配置</button></div>
      <template v-if="activeTab === 'binding'">
        <h3>{{ selectedAddress }} <span>{{ store.selection.rows }} × {{ store.selection.cols }}</span></h3><p v-if="selectedRegion" class="region-tip">{{ selectedRegion.name }} · {{ selectedRegion.source }}</p>
        <label>绑定字段<select v-model="form.field"><option value="">请选择字段</option><option v-for="field in fields" :key="field.path" :value="field.path">{{ field.label }} · {{ field.path }}</option></select></label>
        <div class="button-row"><button class="primary" :disabled="!form.field" @click="perform(() => bind(form.field))">应用绑定</button><button :disabled="!store.selectedCell?.binding" @click="perform(() => store.unbind())">解除绑定</button></div>
        <p class="muted">绑定会替换当前格的文字或公式，保留格式。合并区域自动绑定到左上角。</p>
        <label>静态文本<textarea v-model="form.text" rows="3" placeholder="编辑标签、标题或备注" /></label><button class="wide" @click="perform(() => store.setText(form.text))">应用文本</button>
        <label>字段数据类型<select v-model="form.format" :disabled="!store.selectedCell?.binding" @change="perform(() => store.setFormat(form.format))"><option value="text">文本</option><option value="number">数字</option><option value="date">日期</option><option value="boolean">布尔值</option></select></label>
        <details class="format-panel"><summary>格式与区域操作</summary><label>水平对齐<select v-model="form.horizontal" @change="perform(() => store.setStyle({ horizontal: form.horizontal }))"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label><label>背景颜色<input v-model="form.background" type="color" @change="perform(() => store.setStyle({ background: form.background }))" /></label>
          <div class="two-cols"><label>行高 px<input v-model.number="form.rowHeight" type="number" min="1" max="1000" /></label><label>列宽 px<input v-model.number="form.colWidth" type="number" min="1" max="2000" /></label></div><button class="wide" @click="perform(() => store.resize(form.rowHeight, form.colWidth))">应用尺寸</button><div class="button-row"><button @click="perform(() => store.merge())">合并选区</button><button @click="perform(() => store.unmerge())">取消合并</button></div>
        </details><div class="guide"><strong>使用步骤</strong><ol><li>导入已有 Excel 排版</li><li>新增字段或从 JSON 生成字典</li><li>为多行集合设置明细样板区域</li><li>拖入字段，预览并保存模板</li></ol></div>
      </template>
      <template v-else-if="activeTab === 'repeat'">
        <h3>明细自动扩行</h3><p class="muted">选中“一条业务记录”的样板行，可包含多行和合并格。生成时复制样式，并向下移动后续表格。</p>
        <div v-for="region in store.doc.repeatRegions" :key="region.id" class="region-card"><strong>{{ region.parentId ? '↳ ' : '' }}{{ region.name }}</strong><small>{{ region.source }} · 第 {{ region.rect.r + 1 }}–{{ region.rect.r + region.rect.rows }} 行</small><div class="button-row"><button class="small" @click="editRegion(region)">编辑</button><button class="small" @click="perform(() => { store.select(region.rect); grid?.select(region.rect); })">定位</button><button class="small danger-text" @click="perform(() => store.deleteRegion(region.id))">删除</button></div></div>
        <button class="wide" @click="editRegion()">以当前选区新建区域</button>
        <label>区域名称<input v-model="regionForm.name" placeholder="例如：化学成分明细" /></label><label>数组数据源<select v-model="regionForm.source"><option value="">选择集合</option><option v-for="source in collections" :key="source">{{ source }}</option></select></label>
        <label>父区域（嵌套明细）<select v-model="regionForm.parentId"><option value="">无，独立区域</option><option v-for="region in (store.doc.repeatRegions ?? []).filter(r => r.id !== regionForm.id)" :key="region.id" :value="region.id">{{ region.name }} · {{ region.source }}</option></select></label>
        <div class="two-cols"><label>开始行<input v-model.number="regionForm.start" type="number" min="1" :max="store.doc.rows" /></label><label>结束行<input v-model.number="regionForm.end" type="number" :min="regionForm.start" :max="store.doc.rows" /></label></div>
        <p v-if="regionForm.parentId" class="muted">子区域的列范围取当前选区。请框选检验数据列，避开父记录的炉号等合并列。</p>
        <label>空数组处理<select v-model="regionForm.empty"><option value="keep">保留空白样板行</option><option value="remove">移除样板行</option></select></label><button class="wide primary" @click="saveRegion">{{ regionForm.id ? '更新明细区域' : '保存明细区域' }}</button><p class="muted">多个独立区域可使用同一集合；同一行的并列检验列应归入同一区域。已绑定字段的区域不能直接删除。</p>
      </template>
      <template v-else-if="activeTab === 'views'">
        <h3>数据视图草稿 <span>{{ viewDrafts.length }}</span></h3><p class="muted">筛选、排序可用表单配置；分组汇总、投影、透视与注册函数使用受控 JSON 步骤，不执行任意脚本。正式执行时仍由统一视图引擎校验字段、关系和函数参数。</p>
        <div v-for="view in viewDrafts" :key="`${view.viewId}:${view.version}`" class="region-card"><strong>{{ view.label }}</strong><small>{{ view.viewId }} · v{{ view.version }} · {{ view.sourceDatasetId }}</small><div class="button-row"><button class="small" @click="loadViewDraft(view)">载入编辑</button></div></div>
        <div class="two-cols"><label>视图 ID<input v-model="viewForm.viewId" placeholder="view.chemistry" /></label><label>名称<input v-model="viewForm.label" /></label></div><div class="two-cols"><label>版本<input v-model="viewForm.version" /></label><label>来源数据集 ID<input v-model="viewForm.sourceDatasetId" list="view-datasets" placeholder="material.lines" /><datalist id="view-datasets"><option v-for="view in viewDrafts" :key="view.sourceDatasetId" :value="view.sourceDatasetId" /></datalist></label></div>
        <label>输出字段 ID（逗号分隔）<input v-model="viewForm.outputFields" placeholder="quality.heatNo,quality.carbon" /></label>
        <h4>添加受控步骤</h4><label>步骤类型<select v-model="viewStep.kind"><option value="filter">筛选条件</option><option value="sort">排序</option><option value="project">字段投影</option><option value="group">分组汇总</option><option value="pivot">行列转换</option><option value="applyFunction">调用公共函数</option></select></label>
        <template v-if="viewStep.kind === 'filter'"><div class="two-cols"><label>字段 ID<input v-model="viewStep.fieldId" /></label><label>条件<select v-model="viewStep.operator"><option value="eq">等于</option><option value="neq">不等于</option><option value="gt">大于</option><option value="gte">大于等于</option><option value="lt">小于</option><option value="lte">小于等于</option><option value="contains">包含</option><option value="in">属于</option><option value="isNull">为空</option></select></label></div><label>比较值<input v-model="viewStep.value" /></label></template>
        <template v-else-if="viewStep.kind === 'sort'"><div class="two-cols"><label>字段 ID<input v-model="viewStep.fieldId" /></label><label>方向<select v-model="viewStep.direction"><option value="asc">升序</option><option value="desc">降序</option></select></label></div></template>
        <label v-else>步骤配置 JSON<textarea v-model="viewStep.configJson" class="json-editor" rows="4" :placeholder="viewStep.kind === 'project' ? '{ &quot;op&quot;: &quot;project&quot;, &quot;fields&quot;: [{ &quot;sourceFieldId&quot;: &quot;source.id&quot;, &quot;outputFieldId&quot;: &quot;view.id&quot; }] }' : viewStep.kind === 'group' ? '{ &quot;op&quot;: &quot;group&quot;, &quot;by&quot;: [&quot;quality.heatNo&quot;], &quot;aggregations&quot;: [{ &quot;operation&quot;: &quot;average&quot;, &quot;fieldId&quot;: &quot;quality.hardness&quot;, &quot;outputFieldId&quot;: &quot;view.average&quot; }] }' : '{ &quot;op&quot;: &quot;applyFunction&quot;, &quot;functionId&quot;: &quot;hardness-by-sample&quot;, &quot;version&quot;: &quot;1.0.0&quot;, &quot;parameters&quot;: {} }'" /></label>
        <div class="button-row"><button @click="appendViewStep">追加步骤</button><button class="primary" @click="saveViewDraft">校验并保存视图草稿</button></div>
        <details><summary>视图配置 JSON</summary><textarea v-model="viewText" class="json-editor" rows="12" spellcheck="false" /></details>
      </template>
      <template v-else>
        <h3>页面与分页配置 <span>{{ pageDefinitions.length }}</span></h3><p class="muted">从当前工作表选区创建固定区、页眉/页尾或明细区。明细容量、联动组键与超大组策略必须明确设置。</p>
        <div v-for="page in pageDefinitions" :key="page.pageDefinitionId" class="region-card"><strong>{{ page.label }} · {{ page.pageType }}</strong><small>{{ page.pageDefinitionId }} · {{ page.paginationMode ?? 'fixed' }} · {{ page.paperSize }} {{ page.orientation === 'portrait' ? '纵向' : '横向' }} · {{ page.regions.length }} 个区域</small><div class="button-row"><button class="small" @click="loadPage(page)">编辑此页</button><button v-if="page.pageType === 'main'" class="small" @click="startContinuation(page)">新建续页</button></div><small v-for="region in page.regions" :key="region.regionId">{{ region.label }}：{{ region.kind }} · {{ region.viewId ?? '固定内容' }} <button class="small" @click="loadPage(page, region.regionId)">编辑区域</button></small></div>
        <label>页面名称<input v-model="pageForm.label" /></label><div class="two-cols"><label>页面类型<select v-model="pageForm.pageType"><option value="main">主表</option><option value="continuation">续页</option><option value="appendix">附页</option></select></label><label>续接主表 ID<input v-model="pageForm.continuationOf" placeholder="续页/附页填写" /></label></div>
        <label>分页模式<select v-model="pageForm.paginationMode"><option value="fixed">固定版式</option><option value="flow">流式明细</option></select></label><small v-if="pageForm.paginationMode === 'flow'">流式页面使用一个明细区；可添加同视图和组键的分组头、分组尾区域。明细自动按文字高度分配到页面，末页页尾可放合计或声明。</small>
        <div class="two-cols"><label>纸张<select v-model="pageForm.paperSize"><option value="A4">A4</option><option value="A3">A3</option><option value="Letter">Letter</option><option value="Legal">Legal</option><option value="custom">自定义</option></select></label><label>方向<select v-model="pageForm.orientation"><option value="portrait">纵向</option><option value="landscape">横向</option></select></label></div>
        <div v-if="pageForm.paperSize === 'custom'" class="two-cols"><label>纸张宽度 mm<input v-model.number="pageForm.customWidth" type="number" min="1" /></label><label>纸张高度 mm<input v-model.number="pageForm.customHeight" type="number" min="1" /></label></div>
        <div class="two-cols"><label>上边距 mm<input v-model.number="pageForm.top" type="number" min="0" /></label><label>右边距 mm<input v-model.number="pageForm.right" type="number" min="0" /></label><label>下边距 mm<input v-model.number="pageForm.bottom" type="number" min="0" /></label><label>左边距 mm<input v-model.number="pageForm.left" type="number" min="0" /></label></div>
        <details><summary>打印范围、重复表头与图片定位</summary><div class="two-cols"><label>起始行（从 1 开始）<input v-model.number="pageForm.printRow" type="number" min="1" /></label><label>起始列（从 1 开始）<input v-model.number="pageForm.printCol" type="number" min="1" /></label><label>打印行数<input v-model.number="pageForm.printRows" type="number" min="1" /></label><label>打印列数<input v-model.number="pageForm.printCols" type="number" min="1" /></label></div><label>重复表头行（逗号分隔，从 1 开始）<input v-model="pageForm.repeatHeaderRows" placeholder="例如 1,2,3" /></label><label>图片定位 JSON<textarea v-model="pageForm.imagePlacementsJson" class="json-editor" rows="5" spellcheck="false" placeholder='[{ "imageId": "seal", "resourceId": "image.seal", "worksheetId": "...", "rect": { "r": 0, "c": 0, "rows": 3, "cols": 4 }, "repeatOn": "all" }]' /></label><small>图片引用模板资源 ID；导入工作簿中的图片会随原工作簿保留。新增资源需先加入模板包。</small></details>
        <h4>当前选区区域</h4><p class="muted">{{ selectedAddress }} · {{ store.selection.rows }} × {{ store.selection.cols }} 格</p>
        <label>区域名称<input v-model="pageForm.regionLabel" /></label><label>区域类型<select v-model="pageForm.regionKind"><option value="fixed">固定内容</option><option value="header">表头</option><option value="footer">页尾 / 签章 / 声明</option><option v-if="pageForm.paginationMode === 'flow'" value="groupHeader">分组头</option><option v-if="pageForm.paginationMode === 'flow'" value="groupFooter">分组尾</option><option value="detail">重复明细</option></select></label>
        <template v-if="['detail', 'groupHeader', 'groupFooter'].includes(pageForm.regionKind)"><label>视图标识<input v-model="pageForm.viewId" placeholder="例如 view.chemistry" /></label><label>联动分页组<input v-model="pageForm.paginationGroupId" placeholder="成分与力学区使用相同 ID" /></label><label>业务组键（字段 ID，逗号分隔）<input v-model="pageForm.groupBy" placeholder="certificate.printNo,material.heatNo" /></label><div class="two-cols"><label>每条记录行数<input v-model.number="pageForm.recordHeight" type="number" min="1" /></label><label>额外指定容量行数<input v-model.number="pageForm.capacityRows" type="number" min="0" placeholder="0=扣除页尾后自动计算" /></label></div><label>空数据<select v-model="pageForm.emptyPolicy"><option value="keep">保留区域</option><option value="hide">隐藏区域</option></select></label><label>超大组处理<select v-model="pageForm.oversizedGroupPolicy"><option value="error">报错，不拆组</option><option value="split-records">按记录续页</option></select></label><label class="checkbox"><input v-model="pageForm.keepGroupsTogether" type="checkbox" />业务组尽量保持在同一页</label><details><summary>排序、分组合并与重复值设置</summary><label>排序规则 JSON<textarea v-model="pageForm.orderByJson" class="json-editor" rows="3" placeholder='[{ "fieldId": "quality.heatNo", "direction": "asc" }]' /></label><label>组内纵向合并字段 ID<input v-model="pageForm.mergeFieldIds" placeholder="quality.heatNo" /></label><label>重复时仅显示一次的字段 ID<input v-model="pageForm.hideRepeatedFieldIds" /></label><label>续页重显业务标识字段 ID<input v-model="pageForm.repeatGroupFieldIds" /></label><label v-if="pageForm.pageType === 'appendix'">附页出现条件视图 ID<input v-model="pageForm.appendixIfViewHasRecords" placeholder="该视图有记录时生成附页" /></label></details></template>
        <template v-else><label>内容出现范围<select v-model="pageForm.repeatOn"><option value="all">每页</option><option value="first">仅首页</option><option value="last">仅末页</option></select></label></template>
        <label>区域补白<select v-model="pageForm.blankRows"><option value="keep">保留模板空白行</option><option value="remove">移除未使用空白行</option></select></label>
        <div class="button-row"><button class="small" @click="pageForm.pageDefinitionId = ''; pageForm.regionId = ''">新建页面</button><button class="primary" @click="savePageConfiguration">保存页面区域</button></div>
        <p class="muted">发布到项目服务后，可按固定业务号读取一次数据快照，逐页预览并下载相同分页计划的 Excel。</p>
      </template>
    </aside>
    <el-dialog v-model="fieldDialog" :title="oldPath ? '编辑字段' : '新增字段'" width="620px" :close-on-click-modal="false">
      <div class="two-cols"><label>显示名称<input v-model="fieldForm.label" placeholder="例如：炉号" /></label><label>数据类型<select v-model="fieldForm.format"><option value="text">文本</option><option value="number">数字</option><option value="date">日期</option><option value="boolean">布尔值</option></select></label></div><label>字段路径<input v-model="fieldForm.path" :disabled="!!oldPath && store.worksheets.length > 1" placeholder="例如：chemistry.heatNo" /></label><small v-if="oldPath && store.worksheets.length > 1">字段路径作为多工作表共享别名保持稳定；可在此修改字段来源和显示名称。</small>
      <label>所属数组 / 集合（单值留空）<input v-model="fieldForm.collection" list="collections" placeholder="例如：chemistry 或 chemistry.tests" /><datalist id="collections"><option v-for="source in collections" :key="source" :value="source" /></datalist></label><div class="two-cols"><label>分组<input v-model="fieldForm.group" placeholder="例如：化学成分" /></label><label>Excel 显示格式<input v-model="fieldForm.numberFormat" placeholder="例如：0.000 / yyyy-mm-dd" /></label></div><label>示例值<input v-model="fieldForm.example" /></label><label class="checkbox"><input v-model="fieldForm.required" type="checkbox" />必填，生成时校验缺失值</label>
      <h4>稳定字段来源</h4><div class="two-cols"><label>来源类型<select v-model="fieldForm.sourceKind"><option value="legacy">兼容旧路径</option><option value="dataset">项目数据集</option><option value="view">数据视图</option><option value="constant">常量</option><option value="parameter">运行参数</option><option value="page">页面系统字段</option></select></label><label>单位<input v-model="fieldForm.unit" placeholder="kg、MPa、mm" /></label></div>
      <div v-if="fieldForm.sourceKind === 'dataset'" class="two-cols"><label>数据集 ID<input v-model="fieldForm.datasetId" placeholder="例如 material.lines" /></label><label>源字段 ID<input v-model="fieldForm.sourceFieldId" /></label></div><div v-if="fieldForm.sourceKind === 'view'" class="two-cols"><label>视图 ID<input v-model="fieldForm.viewId" placeholder="例如 view.chemistry" /></label><label>输出字段 ID<input v-model="fieldForm.sourceFieldId" /></label></div>
      <label v-if="fieldForm.sourceKind === 'parameter'">参数 ID<input v-model="fieldForm.parameterId" placeholder="例如 issueDate" /></label><label v-if="fieldForm.sourceKind === 'constant' && fieldForm.format !== 'boolean'">常量值<input v-model="fieldForm.constantValue" /></label><label v-if="fieldForm.sourceKind === 'constant' && fieldForm.format === 'boolean'">布尔常量<select v-model="fieldForm.constantValue"><option value="true">true</option><option value="false">false</option></select></label><label v-if="fieldForm.sourceKind === 'page'">页面字段<select v-model="fieldForm.pageField"><option value="number">页码</option><option value="total">总页数</option><option value="recordNumber">整单记录序号</option><option value="groupNumber">业务组序号</option></select></label>
      <small>字段 ID：{{ fieldForm.fieldId || '保存时自动分配；编辑时保持不变' }} · 数据粒度：<input v-model="fieldForm.grain" placeholder="如 certificate / heat / sample" /></small>
      <template #footer><button v-if="oldPath" class="danger-text" @click="perform(() => { store.deleteField(oldPath!); fieldDialog = false; })">删除字段</button><button @click="fieldDialog = false">取消</button><button class="primary" @click="saveField">保存字段</button></template>
    </el-dialog>
    <el-dialog v-model="dataDialog" title="业务数据与自动生成" width="760px" :close-on-click-modal="false"><p class="muted">粘贴业务 JSON 对象。数组会识别为多行集合，嵌套数组可生成子明细字段；遍历所有记录补齐字段，已有字典不会被覆盖。数据仅在当前浏览器处理。</p><textarea v-model="dataText" class="json-editor" rows="18" aria-label="业务 JSON 数据" spellcheck="false" /><template #footer><button @click="inferDataFields">自动生成字段字典</button><button class="primary" @click="previewData">生成预览</button></template></el-dialog>
    <el-dialog v-model="serviceDialog" title="项目数据服务与模板发布" width="820px" :close-on-click-modal="false">
      <p class="muted">本流程使用服务端登记的项目数据源、视图和已发布模板。保存草稿后发布不可变版本，再用明确的业务单号生成。</p>
      <div class="two-cols"><label>服务地址<input v-model="serviceBaseUrl" spellcheck="false" placeholder="/api" /></label><label>访问令牌<input v-model="serviceToken" type="password" autocomplete="off" placeholder="仅部署了令牌验证时填写" /></label></div>
      <div class="two-cols"><label>项目<select v-model="serviceProjectId" @change="serviceProjectChanged"><option v-for="project in serviceProjects" :key="project.projectId" :value="project.projectId">{{ project.displayName }} · {{ project.projectId }}</option></select></label><label>单据类型<select v-model="serviceDocumentType"><option v-for="type in serviceProjects.find(item => item.projectId === serviceProjectId)?.documentTypes ?? []" :key="type" :value="type">{{ type }}</option></select></label></div>
      <label>业务单号参数 JSON<textarea v-model="serviceBusinessKeyText" class="json-editor" rows="4" spellcheck="false" @input="serviceIdempotencyKey = ''" /></label>
      <div class="button-row"><button @click="importServiceCatalog">导入项目字段目录</button><button @click="testServiceViews">视图试算</button><button @click="refreshServiceTemplateState">刷新版本状态</button></div>
      <div class="button-row"><button :disabled="!serviceViewDraftCount" @click="publishServiceViews">发布当前模板包中的 {{ serviceViewDraftCount }} 个视图草稿</button></div>
      <p v-if="serviceViewSummary" class="muted">{{ serviceViewSummary }}</p>
      <div class="import-notice"><strong>当前模板</strong><p>{{ store.templatePackage?.name ?? store.doc.name }} · {{ store.templatePackage?.packageId ?? '请先导入或创建模板包' }}</p><p>服务端草稿修订：{{ serviceDraftRevision }} · 已发布版本：{{ servicePublishedVersion ?? '无' }}</p></div>
      <div class="button-row"><button :disabled="!serviceProjectId || !store.templatePackage" @click="saveServiceTemplate">保存项目模板草稿</button><button :disabled="!serviceDraftRevision || !store.templatePackage" @click="publishServiceTemplate">发布新版本</button></div>
      <label class="checkbox"><input v-model="serviceAutoMatch" type="checkbox" />按项目中已登记的匹配条件自动选择模板</label>
      <template v-if="store.templatePackage && servicePublishedVersion"><div class="two-cols"><label>自动匹配优先级<input v-model.number="serviceMatchPriority" type="number" min="0" max="1000000" /></label><label>业务条件 JSON<input v-model="serviceMatchConditionsText" spellcheck="false" placeholder='{"customerCode":"CUST-A","productPart":"T"}' /></label></div><button @click="saveServiceMatchRule">登记当前版本的自动匹配条件</button></template>
      <div class="button-row"><button :disabled="!serviceAutoMatch && !servicePublishedVersion" @click="generateFromService('preview')">{{ serviceAutoMatch ? '自动匹配并预览' : '读取业务数据并预览' }}</button><button class="primary" :disabled="!serviceAutoMatch && !servicePublishedVersion" @click="generateFromService('issue')">正式生成并保存快照</button></div>
      <p v-if="serviceError" class="error-box">{{ serviceError }} <button v-if="serviceErrorIssue?.context" class="small" @click="locateServiceIssue(serviceErrorIssue)">定位问题 <small>{{ serviceErrorIssue.context.worksheetId ?? '' }} {{ serviceErrorIssue.context.cell ?? serviceErrorIssue.context.regionId ?? '' }} {{ serviceErrorIssue.context.fieldId ?? '' }} {{ serviceErrorIssue.context.recordId ?? '' }}</small></button></p>
      <template #footer><button @click="serviceDialog = false">关闭</button></template>
    </el-dialog>
    <el-dialog v-model="servicePreviewDialog" title="固定快照的逐页预览" width="94%" top="3vh">
      <p v-if="serviceGeneration" class="muted">生成记录 {{ serviceGeneration.generationId }} · 模板 {{ serviceGenerationTemplateLabel }} · {{ serviceGeneration.mode === 'issue' ? '正式生成' : '预览' }} · {{ serviceGeneration.pageCount }} 页 · 下载与本预览使用同一份页面计划。</p>
      <PagedPreview :page-number="servicePageNumber" :total-pages="serviceGeneration?.pageCount ?? 0" :sheets="servicePageSheets" :resources="servicePageResources" :diagnostics="servicePageDiagnostics" :loading="servicePageLoading" @navigate="loadServicePage" @locate="locateServiceIssue" />
      <p v-if="serviceError" class="error-box">{{ serviceError }} <button v-if="serviceErrorIssue?.context" class="small" @click="locateServiceIssue(serviceErrorIssue)">定位问题 <small>{{ serviceErrorIssue.context.worksheetId ?? '' }} {{ serviceErrorIssue.context.cell ?? serviceErrorIssue.context.regionId ?? '' }} {{ serviceErrorIssue.context.fieldId ?? '' }} {{ serviceErrorIssue.context.recordId ?? '' }}</small></button></p>
      <template #footer><button @click="servicePreviewDialog = false">关闭</button><button @click="reprintServiceGeneration">按原快照重印</button><button v-if="serviceGeneration?.pdfUrl" :disabled="busy" @click="downloadServicePdf">下载 PDF</button><button class="primary" :disabled="busy || !serviceGeneration" @click="downloadServiceGeneration">下载 XLSX</button></template>
    </el-dialog>
    <el-dialog v-model="previewDialog" title="生成结果预览" width="92%" top="4vh"><template v-if="generated"><p class="muted">已生成 {{ generated.recordCount }} 条明细（含子记录），共 {{ generated.document.rows }} 行；网页预览与 Excel 均包含完整结果。</p><details v-if="generated.warnings.length" class="import-notice"><summary>{{ generated.warnings.length }} 项数据提示</summary><p v-for="warning in generated.warnings" :key="warning">{{ warning }}</p></details><div class="preview-scroll"><table class="preview-table"><tbody><tr v-for="(row, index) in previewTable" :key="index"><td v-for="cell in row" :key="cell.key" :rowspan="cell.rowspan" :colspan="cell.colspan" :style="cell.style">{{ cell.text }}</td></tr></tbody></table></div></template><template #footer><button @click="previewDialog = false; dataDialog = true">修改数据</button><button class="primary" :disabled="busy || !generated" @click="exportGenerated">下载生成结果 Excel</button></template></el-dialog>
  </div>
</template>

<style scoped src="/src/components/designer.css"></style>
