<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { displayText } from '../../domain/model.ts';
import type { ProjectedSheetPage } from '../../core/render/page.ts';
import type { ReportingErrorShape, TemplatePackage } from '../../core/contracts/types.ts';

const props = defineProps<{ pageNumber: number; totalPages: number; sheets: ProjectedSheetPage[];
  resources: NonNullable<TemplatePackage['resources']>; diagnostics?: ReportingErrorShape[]; loading?: boolean }>();
const emit = defineEmits<{ navigate: [page: number]; locate: [issue: ReportingErrorShape] }>();
const zoom = ref(1), activeSheet = ref(0);
watch(() => [props.pageNumber, props.sheets.length] as const, () => { activeSheet.value = 0; });
const sheet = computed(() => props.sheets[activeSheet.value]);
const resourceMap = computed(() => new Map(props.resources.map(item => [item.resourceId, item])));
const dimensions = computed(() => {
  const doc = sheet.value?.document; if (!doc) return { cols: [], rows: [], width: 0, height: 0 };
  const cols = Array.from({ length: doc.cols }, (_, index) => doc.colWidthPx[index] ?? 64);
  const rows = Array.from({ length: doc.rows }, (_, index) => doc.rowHeightPx[index] ?? 22);
  return { cols, rows, width: cols.reduce((sum, px) => sum + px, 0), height: rows.reduce((sum, px) => sum + px, 0) };
});
const paper = computed(() => {
  const setup = sheet.value?.pageSetup; if (!setup) return { width: 210, height: 297 };
  const sizes: Record<string, [number, number]> = { A4: [210, 297], A3: [297, 420], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
  let [width, height] = setup.paperSize === 'custom' ? [setup.customPaperMm?.width ?? 210, setup.customPaperMm?.height ?? 297] : sizes[setup.paperSize] ?? [210, 297];
  if (setup.orientation === 'landscape' && height > width || setup.orientation === 'portrait' && width > height) [width, height] = [height, width];
  return { width, height };
});
const layout = computed(() => {
  const current = sheet.value, size = dimensions.value;
  if (!current) return { width: 0, height: 0, areaWidth: 0, areaHeight: 0, fit: 1, x: 0, y: 0, paperWidth: 0, paperHeight: 0, left: 0, top: 0 };
  const rect = current.pageSetup.printableRect ?? { r: 0, c: 0, rows: current.document.rows, cols: current.document.cols };
  const startX = size.cols.slice(0, rect.c).reduce((sum, value) => sum + value, 0);
  const startY = size.rows.slice(0, rect.r).reduce((sum, value) => sum + value, 0);
  const areaWidth = size.cols.slice(rect.c, rect.c + rect.cols).reduce((sum, value) => sum + value, 0);
  const areaHeight = size.rows.slice(rect.r, rect.r + rect.rows).reduce((sum, value) => sum + value, 0);
  const paperWidth = paper.value.width * 96 / 25.4, paperHeight = paper.value.height * 96 / 25.4;
  const margins = current.pageSetup.marginsMm;
  const left = margins.left * 96 / 25.4, top = margins.top * 96 / 25.4;
  const usableWidth = paperWidth - (margins.left + margins.right) * 96 / 25.4;
  const usableHeight = paperHeight - (margins.top + margins.bottom) * 96 / 25.4;
  const fit = Math.min(usableWidth / Math.max(1, areaWidth), usableHeight / Math.max(1, areaHeight), 1);
  return { width: size.width, height: size.height, areaWidth, areaHeight, fit, x: startX, y: startY,
    paperWidth, paperHeight, left, top };
});
function cssColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const hex = value.replace(/^#|^FF/i, '');
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : undefined;
}
function sideBorder(side: unknown): string | undefined {
  if (!side || typeof side !== 'object') return undefined;
  const value = side as { style?: string; color?: { argb?: string } };
  if (!value.style || value.style === 'none') return undefined;
  const width = ['thick', 'double'].includes(value.style) ? 2 : 1;
  const style = value.style.includes('dash') || value.style === 'dotted' ? 'dashed' : 'solid';
  return `${width}px ${style} ${cssColor(value.color?.argb) ?? '#333'}`;
}
function cellCss(cell: any): Record<string, string> {
  const style = cell?.style ?? {}, raw = cell?.excelStyle ?? {};
  const font = raw.font ?? {}, fill = raw.fill?.fgColor?.argb;
  return {
    ...(style.background ?? cssColor(fill) ? { backgroundColor: style.background ?? cssColor(fill)! } : {}),
    ...(style.color ?? cssColor(font.color?.argb) ? { color: style.color ?? cssColor(font.color?.argb)! } : {}),
    fontFamily: style.fontFamily ?? font.name ?? 'Arial',
    fontSize: `${(style.fontSizePt ?? font.size ?? 10) * 4 / 3}px`,
    fontWeight: (style.bold ?? font.bold) ? 'bold' : 'normal',
    textAlign: style.horizontal ?? raw.alignment?.horizontal ?? 'left',
    alignItems: (style.vertical ?? raw.alignment?.vertical) === 'top' ? 'flex-start' : (style.vertical ?? raw.alignment?.vertical) === 'bottom' ? 'flex-end' : 'center',
    justifyContent: (style.horizontal ?? raw.alignment?.horizontal) === 'right' ? 'flex-end' : (style.horizontal ?? raw.alignment?.horizontal) === 'center' ? 'center' : 'flex-start',
    whiteSpace: (style.wrap ?? raw.alignment?.wrapText) ? 'pre-wrap' : 'pre',
    ...(sideBorder(style.borders?.top ?? raw.border?.top) ? { borderTop: sideBorder(style.borders?.top ?? raw.border?.top)! } : {}),
    ...(sideBorder(style.borders?.right ?? raw.border?.right) ? { borderRight: sideBorder(style.borders?.right ?? raw.border?.right)! } : {}),
    ...(sideBorder(style.borders?.bottom ?? raw.border?.bottom) ? { borderBottom: sideBorder(style.borders?.bottom ?? raw.border?.bottom)! } : {}),
    ...(sideBorder(style.borders?.left ?? raw.border?.left) ? { borderLeft: sideBorder(style.borders?.left ?? raw.border?.left)! } : {}),
  };
}
const cells = computed(() => {
  const current = sheet.value; if (!current) return [];
  const doc = current.document, merges = new Map<string, { rows: number; cols: number }>(), covered = new Set<string>();
  for (const merge of doc.merges) {
    merges.set(`${merge.r}:${merge.c}`, { rows: merge.rows, cols: merge.cols });
    for (let row = merge.r; row < merge.r + merge.rows; row++) for (let col = merge.c; col < merge.c + merge.cols; col++)
      if (row !== merge.r || col !== merge.c) covered.add(`${row}:${col}`);
  }
  const occupied = new Set(Object.keys(doc.cells));
  for (const key of merges.keys()) occupied.add(key);
  return [...occupied].flatMap(key => {
    if (covered.has(key)) return [];
    const [row, col] = key.split(':').map(Number);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= doc.rows || col >= doc.cols) return [];
    const cell = doc.cells[key], span = merges.get(key) ?? { rows: 1, cols: 1 };
    return [{ key, row, col, rows: span.rows, cols: span.cols, text: cell ? displayText(cell, doc.syntax) : '', style: cellCss(cell) }];
  }).sort((a, b) => a.row - b.row || a.col - b.col);
});
const images = computed(() => {
  const current = sheet.value; if (!current) return [];
  return current.imagePlacements.flatMap(placement => {
    const resource = resourceMap.value.get(placement.resourceId); if (!resource) return [];
    const { r, c, rows, cols } = placement.rect, size = dimensions.value;
    const x = size.cols.slice(0, c).reduce((sum, value) => sum + value, 0);
    const y = size.rows.slice(0, r).reduce((sum, value) => sum + value, 0);
    const width = size.cols.slice(c, c + cols).reduce((sum, value) => sum + value, 0);
    const height = size.rows.slice(r, r + rows).reduce((sum, value) => sum + value, 0);
    return [{ id: placement.imageId, src: `data:${resource.mediaType};base64,${resource.base64}`, x, y, width, height }];
  });
});
const gridTransform = computed(() => `translate(${-layout.value.x * layout.value.fit * zoom.value}px, ${-layout.value.y * layout.value.fit * zoom.value}px) scale(${layout.value.fit * zoom.value})`);
</script>

<template>
  <div class="paged-preview">
    <div class="preview-controls">
      <button :disabled="loading || pageNumber <= 1" @click="emit('navigate', 1)">首页</button>
      <button :disabled="loading || pageNumber <= 1" @click="emit('navigate', pageNumber - 1)">上一页</button>
      <strong>{{ pageNumber }} / {{ totalPages }}</strong>
      <button :disabled="loading || pageNumber >= totalPages" @click="emit('navigate', pageNumber + 1)">下一页</button>
      <button :disabled="loading || pageNumber >= totalPages" @click="emit('navigate', totalPages)">末页</button>
      <select v-if="sheets.length > 1" v-model.number="activeSheet" aria-label="同页工作表"><option v-for="(item, index) in sheets" :key="item.worksheetId" :value="index">{{ item.document.sheetName }}</option></select>
      <label>缩放 <select v-model.number="zoom"><option :value="0.5">50%</option><option :value="0.75">75%</option><option :value="1">100%</option><option :value="1.25">125%</option></select></label>
      <span v-if="sheet" class="page-kind">{{ sheet.pageType }} · {{ sheet.recordCount }} 条记录 · {{ sheet.groupCount }} 组</span>
    </div>
    <div v-if="diagnostics?.length" class="preview-diagnostics"><strong>{{ diagnostics.length }} 项页面诊断</strong>
      <button v-for="(issue, index) in diagnostics" :key="index" @click="emit('locate', issue)">{{ issue.message }}<small v-if="issue.context">{{ issue.context.worksheetId ?? '' }} {{ issue.context.cell ?? issue.context.regionId ?? issue.context.fieldId ?? '' }}</small></button>
    </div>
    <div v-if="loading" class="preview-loading">正在读取该页投影…</div>
    <div v-else-if="sheet" class="paper-viewport">
      <div class="paper" :style="{ width: `${layout.paperWidth * zoom}px`, height: `${layout.paperHeight * zoom}px` }">
        <div class="print-viewport" :style="{ left: `${layout.left * zoom}px`, top: `${layout.top * zoom}px`, width: `${layout.paperWidth * zoom - layout.left * zoom - (sheet.pageSetup.marginsMm.right * 96 / 25.4) * zoom}px`, height: `${layout.paperHeight * zoom - layout.top * zoom - (sheet.pageSetup.marginsMm.bottom * 96 / 25.4) * zoom}px` }">
          <div class="grid" :style="{ width: `${dimensions.width}px`, height: `${dimensions.height}px`, gridTemplateColumns: dimensions.cols.map(value => `${value}px`).join(' '), gridTemplateRows: dimensions.rows.map(value => `${value}px`).join(' '), transform: gridTransform }">
            <div v-for="cell in cells" :key="cell.key" class="grid-cell" :style="{ gridColumn: `${cell.col + 1} / span ${cell.cols}`, gridRow: `${cell.row + 1} / span ${cell.rows}`, ...cell.style }">{{ cell.text }}</div>
            <img v-for="image in images" :key="image.id" class="page-image" :src="image.src" :alt="image.id" :style="{ left: `${image.x}px`, top: `${image.y}px`, width: `${image.width}px`, height: `${image.height}px` }" />
          </div>
        </div>
        <span class="paper-caption">{{ sheet.pageSetup.paperSize }} {{ sheet.pageSetup.orientation }} · {{ sheet.document.sheetName }}</span>
      </div>
    </div>
    <div v-else class="preview-loading">当前页暂无工作表内容</div>
  </div>
</template>

<style scoped>
.paged-preview{display:flex;flex-direction:column;gap:12px;min-height:65vh}.preview-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.preview-controls button,.preview-controls select,.preview-diagnostics button{border:1px solid #cbd5e1;background:#fff;border-radius:5px;padding:6px 10px}.preview-controls button:disabled{opacity:.45}.preview-controls label{display:flex;align-items:center;gap:5px}.page-kind{margin-left:auto;color:#64748b;font-size:12px}.paper-viewport{overflow:auto;max-height:68vh;background:#e8edf3;padding:20px}.paper{position:relative;margin:0 auto;background:#fff;box-shadow:0 2px 12px #26364a33;overflow:hidden}.print-viewport{position:absolute;overflow:hidden;border:1px dashed #b8c5d5;box-sizing:border-box}.grid{position:absolute;left:0;top:0;display:grid;transform-origin:top left}.grid-cell{box-sizing:border-box;overflow:hidden;padding:1px 3px;line-height:1.1;display:flex;align-items:center}.page-image{position:absolute;object-fit:fill;pointer-events:none}.paper-caption{position:absolute;right:8px;bottom:5px;color:#94a3b8;font-size:10px}.preview-diagnostics{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.preview-diagnostics button{display:flex;flex-direction:column;text-align:left;color:#9f3a24}.preview-diagnostics small{font-size:10px;color:#64748b}.preview-loading{display:grid;place-items:center;min-height:300px;color:#64748b}
</style>
