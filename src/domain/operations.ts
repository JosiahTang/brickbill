import {
  copy, displayText, fieldByPath, documentFields, keyOf,
  type Binding, type BlockDefinition, type Cell, type CellStyle,
  type Rect, type TemplateDocument, type Field,
} from './model.ts';
import { validateFields, validPath } from './fields.ts';

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function inside(a: Rect, r: number, c: number): boolean {
  return r >= a.r && r < a.r + a.rows && c >= a.c && c < a.c + a.cols;
}
export function intersects(a: Rect, b: Rect): boolean {
  return a.r < b.r + b.rows && b.r < a.r + a.rows &&
    a.c < b.c + b.cols && b.c < a.c + a.cols;
}
export function contains(a: Rect, b: Rect): boolean {
  return inside(a, b.r, b.c) && inside(a, b.r + b.rows - 1, b.c + b.cols - 1);
}
export function eachCell(rect: Rect, fn: (r: number, c: number) => void): void {
  for (let r = rect.r; r < rect.r + rect.rows; r++)
    for (let c = rect.c; c < rect.c + rect.cols; c++) fn(r, c);
}
export function checkBounds(rect: Rect, rows: number, cols: number): void {
  assert(Object.values(rect).every(Number.isInteger), '坐标与尺寸必须为整数');
  assert(rect.r >= 0 && rect.c >= 0 && rect.rows > 0 && rect.cols > 0, '非法矩形');
  assert(rect.r + rect.rows <= rows && rect.c + rect.cols <= cols, '放置区域超出画布');
}
export function anchor(doc: TemplateDocument, r: number, c: number): [number, number] {
  const m = doc.merges.find(x => inside(x, r, c));
  return m ? [m.r, m.c] : [r, c];
}
export function hasValue(cell?: Cell): boolean {
  return !!cell && (cell.binding !== undefined || (cell.text !== undefined && cell.text !== ''));
}
function checkStyle(style?: CellStyle): void {
  if (!style) return;
  const color = /^#[0-9a-f]{6}$/i;
  for (const v of [style.color, style.background])
    assert(v === undefined || color.test(v), '颜色必须为 #RRGGBB');
  assert(style.fontSizePt === undefined || (Number.isFinite(style.fontSizePt) &&
    style.fontSizePt >= 6 && style.fontSizePt <= 72), '字号应为 6–72 pt');
  assert(style.horizontal === undefined || ['left', 'center', 'right'].includes(style.horizontal), '非法水平对齐');
  assert(style.vertical === undefined || ['top', 'middle', 'bottom'].includes(style.vertical), '非法垂直对齐');
  for (const edge of Object.values(style.borders ?? {})) {
    assert(color.test(edge.color), '非法边框颜色');
    assert(['thin', 'medium', 'dashed'].includes(edge.style), '非法边框样式');
  }
}
function checkCell(cell: Cell, fields?: Field[]): void {
  assert(!(cell.text !== undefined && cell.binding !== undefined), '文本和绑定不能同时存在');
  assert(cell.text === undefined || (typeof cell.text === 'string' && cell.text.length <= 32767), '单元格文本过长');
  assert(cell.excelValue !== undefined || cell.text === undefined || (!cell.text.includes('{{') && !cell.text.includes('${')),
    '占位符须通过字段绑定生成；示例不支持在静态文本中手写表达式');
  if (cell.binding) {
    const field = fieldByPath(cell.binding.path, fields);
    assert(!cell.binding.fieldId || !field.fieldId || cell.binding.fieldId === field.fieldId, `绑定字段标识与字典不一致：${cell.binding.path}`);
    assert(['text', 'number', 'date', 'boolean'].includes(cell.binding.format), '未知数据格式');
  }
  checkStyle(cell.style);
}
function repeatRect(block: TemplateDocument['blocks'][number]): Rect | undefined {
  if (!block.repeat) return;
  return { r: block.rect.r + block.repeat.rowOffset, c: block.rect.c,
    rows: block.repeat.rowCount, cols: block.rect.cols };
}
function checkFieldScope(doc: TemplateDocument, r: number, c: number, binding: Binding): void {
  const field = fieldByPath(binding.path, documentFields(doc));
  if (!field.collection) return;
  assert(doc.blocks.some(block => {
    const band = repeatRect(block);
    return band && block.repeat?.source === field.collection && inside(band, r, c);
  }) || (doc.repeatRegions ?? []).some(region => region.source === field.collection && inside(region.rect, r, c)),
  `明细字段 ${binding.path} 必须放在 ${field.collection} 的重复区域内，请先设置明细区域`);
}
export function validateBlock(block: BlockDefinition): void {
  assert(block.schemaVersion === 1, '不支持的积木版本');
  // Product limit, not an Excel/Univer limit.
  checkBounds({ r: 0, c: 0, rows: block.rows, cols: block.cols }, 200, 50);
  assert(block.id.length > 0 && block.name.length > 0, '积木必须有 id 和名称');
  checkStyle(block.defaultStyle);
  const seen = new Set<string>();
  for (const cell of block.cells) {
    checkBounds({ r: cell.r, c: cell.c, rows: 1, cols: 1 }, block.rows, block.cols);
    const key = keyOf(cell.r, cell.c);
    assert(!seen.has(key), '积木内存在重复单元格坐标');
    seen.add(key); checkCell(cell);
    assert(cell.owner === undefined, '预制积木不得携带实例 owner');
  }
  for (let i = 0; i < block.merges.length; i++) {
    const m = block.merges[i]; checkBounds(m, block.rows, block.cols);
    assert(m.rows * m.cols > 1, '不能合并单个单元格');
    assert(!block.merges.slice(i + 1).some(n => intersects(m, n)), '积木合并区域重叠');
    for (const cell of block.cells)
      if (inside(m, cell.r, cell.c) && (cell.r !== m.r || cell.c !== m.c))
        assert(!hasValue(cell), '合并从属格不能存放内容');
  }
  if (block.repeat) {
    const p = block.repeat;
    checkBounds({ r: p.rowOffset, c: 0, rows: p.rowCount, cols: block.cols }, block.rows, block.cols);
    assert(p.mode === 'insert' && ['remove', 'keep'].includes(p.empty), '不支持的重复策略');
    assert(['items'].includes(p.source), '未知明细数据源');
  }
}
export function validateDocument(doc: TemplateDocument): void {
  assert(doc && typeof doc === 'object' && doc.cells && Array.isArray(doc.merges) && Array.isArray(doc.blocks), '模板文档结构不完整');
  validateFields(documentFields(doc));
  assert(doc.schemaVersion === 1, '不支持的模板版本');
  assert(Number.isInteger(doc.revision) && doc.revision >= 0, '非法模板修订号');
  assert(doc.syntax === 'mustache' || doc.syntax === 'dollar', '不支持的占位符语法');
  assert(doc.sheetName.length > 0 && doc.sheetName.length <= 31 &&
    !/[\\/*?:\[\]]/.test(doc.sheetName), '非法工作表名称');
  checkBounds({ r: 0, c: 0, rows: doc.rows, cols: doc.cols }, 10000, 200);
  assert(doc.rows * doc.cols <= 500000, '模板超过 500000 个单元格');
  assert(doc.rowHeightPx.length === doc.rows && doc.colWidthPx.length === doc.cols, '行列尺寸数量不匹配');
  assert(doc.rowHeightPx.every(v => Number.isFinite(v) && v > 0 && v <= 1000), '行高应大于 0 且不超过 1000 px');
  assert(doc.colWidthPx.every(v => Number.isFinite(v) && v > 0 && v <= 2000), '列宽应大于 0 且不超过 2000 px');
  const regions = doc.repeatRegions ?? [];
  assert(Array.isArray(regions) && regions.length <= 100, '明细区域最多支持 100 个');
  const regionIds = new Set<string>();
  const ancestorIds = (id?: string): string[] => {
    const seen: string[] = [];
    while (id) {
      assert(!seen.includes(id), '明细区域父子关系存在循环'); seen.push(id);
      const region = regions.find(x => x.id === id); assert(region, '父明细区域不存在'); id = region.parentId;
    }
    assert(seen.length <= 8, '明细区域嵌套最多 8 层'); return seen;
  };
  for (const region of regions) {
    assert(region.id && !regionIds.has(region.id), '明细区域 id 重复或为空'); regionIds.add(region.id);
    assert(region.name?.trim() && validPath(region.source), '请填写明细名称和合法数据源');
    assert(['keep', 'remove'].includes(region.empty), '非法空数据策略');
    checkBounds(region.rect, doc.rows, doc.cols); ancestorIds(region.id);
    if (region.parentId) {
      const parent = regions.find(x => x.id === region.parentId)!;
      assert(contains(parent.rect, region.rect), '子明细区域必须位于父区域内');
      assert(region.source.startsWith(parent.source + '.'), '子明细数据源必须属于父集合');
    }
    for (const m of doc.merges) {
      const band = { ...region.rect, c: 0, cols: doc.cols };
      if (intersects(m, band)) assert(contains(band, m) || (region.parentId &&
        m.r <= band.r && m.r + m.rows >= band.r + band.rows && !intersects(m, region.rect)),
      '合并不能跨越明细样板行边界，请将整组合并行纳入样板');
    }
  }
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const a = regions[i], b = regions[j];
    if (a.rect.r < b.rect.r + b.rect.rows && b.rect.r < a.rect.r + a.rect.rows)
      assert(ancestorIds(a.parentId).includes(b.id) || ancestorIds(b.parentId).includes(a.id), '同行的明细请放在同一区域；独立明细区域不能纵向重叠');
  }
  const ids = new Set<string>();
  for (let i = 0; i < doc.blocks.length; i++) {
    const b = doc.blocks[i];
    assert(!ids.has(b.id), '重复积木实例 id'); ids.add(b.id);
    checkBounds(b.rect, doc.rows, doc.cols);
    assert(!doc.blocks.slice(i + 1).some(n => intersects(b.rect, n.rect)), '积木实例区域重叠');
    const band = repeatRect(b);
    if (band) {
      checkBounds(band, doc.rows, doc.cols);
      assert(contains(b.rect, band), '明细重复区域必须位于积木内');
      assert(b.repeat?.mode === 'insert' && ['remove', 'keep'].includes(b.repeat.empty), '不支持的重复策略');
      assert(b.repeat?.source === 'items', '未知明细数据源');
    }
    eachCell(b.rect, (r, c) => assert(doc.cells[keyOf(r, c)]?.owner === b.id, '积木占位信息不完整'));
  }
  for (const [key, cell] of Object.entries(doc.cells)) {
    assert(/^\d+:\d+$/.test(key), '非法单元格键');
    const [r, c] = key.split(':').map(Number);
    assert(key === keyOf(r, c), '单元格键必须使用规范坐标');
    checkBounds({ r, c, rows: 1, cols: 1 }, doc.rows, doc.cols); checkCell(cell, documentFields(doc));
    if (cell.owner) assert(doc.blocks.some(b => b.id === cell.owner && inside(b.rect, r, c)), '悬空积木引用');
    if (cell.binding) checkFieldScope(doc, r, c, cell.binding);
  }
  for (let i = 0; i < doc.merges.length; i++) {
    const m = doc.merges[i]; checkBounds(m, doc.rows, doc.cols);
    assert(m.rows * m.cols > 1, '不能合并单个单元格');
    assert(!doc.merges.slice(i + 1).some(n => intersects(m, n)), '合并区域重叠');
    const owners = new Set<string>();
    eachCell(m, (r, c) => {
      const cell = doc.cells[keyOf(r, c)]; owners.add(cell?.owner ?? '');
      if (r !== m.r || c !== m.c) assert(!hasValue(cell), '合并从属格不能存放内容');
    });
    assert(owners.size <= 1, '禁止跨积木边界合并');
    for (const b of doc.blocks) {
      const band = repeatRect(b);
      if (band && intersects(m, band)) assert(contains(band, m), '合并不能跨越明细重复单元边界');
    }
  }
  // This MVP uses full-row expansion. Parallel repeat regions on the same rows
  // would shift each other, so reject them rather than export ambiguous metadata.
  const bands = doc.blocks.map(repeatRect).filter((x): x is Rect => !!x);
  for (let i = 0; i < bands.length; i++) for (let j = i + 1; j < bands.length; j++)
    assert(bands[i].r + bands[i].rows <= bands[j].r || bands[j].r + bands[j].rows <= bands[i].r,
      '整行扩展模式不支持纵向重叠的两个明细区域');
}
export function placementError(doc: TemplateDocument, block: BlockDefinition, r: number, c: number): string | null {
  try {
    validateBlock(block);
    const rect = { r, c, rows: block.rows, cols: block.cols };
    checkBounds(rect, doc.rows, doc.cols);
    assert(!doc.merges.some(m => intersects(m, rect)), '目标区域与合并单元格相交');
    assert(!doc.blocks.some(b => intersects(b.rect, rect)), '目标区域已有积木');
    eachCell(rect, (rr, cc) => assert(doc.cells[keyOf(rr, cc)] === undefined, '目标区域存在内容、样式或保留占位'));
    return null;
  } catch (e) { return e instanceof Error ? e.message : String(e); }
}
export function placeBlock(doc: TemplateDocument, block: BlockDefinition, r: number, c: number, instanceId: string): void {
  const error = placementError(doc, block, r, c); assert(error === null, error ?? '无法放置');
  assert(instanceId.length > 0 && !doc.blocks.some(b => b.id === instanceId), '非法或重复实例 id');
  const rect = { r, c, rows: block.rows, cols: block.cols };
  // Reserve the WHOLE bounding box, including blank cells.
  eachCell(rect, (rr, cc) => { doc.cells[keyOf(rr, cc)] = { owner: instanceId, style: copy(block.defaultStyle ?? {}) }; });
  for (const cell of block.cells) {
    const { r: dr, c: dc, ...data } = copy(cell);
    doc.cells[keyOf(r + dr, c + dc)] = {
      ...data, owner: instanceId, style: { ...copy(block.defaultStyle ?? {}), ...data.style },
    };
  }
  doc.merges.push(...block.merges.map(m => ({ ...m, r: r + m.r, c: c + m.c })));
  doc.blocks.push({ id: instanceId, definitionId: block.id, rect, ...(block.repeat ? { repeat: copy(block.repeat) } : {}) });
}
export function bindField(doc: TemplateDocument, r: number, c: number, path: string, replace = false): void {
  checkBounds({ r, c, rows: 1, cols: 1 }, doc.rows, doc.cols);
  [r, c] = anchor(doc, r, c);
  const previous = doc.cells[keyOf(r, c)] ?? {};
  assert(replace || !hasValue(previous), '单元格已有内容；请从右侧属性面板明确替换');
  const field = fieldByPath(path, documentFields(doc)); const binding = { path, format: field.format, fieldId: field.fieldId ?? `legacy.${field.path}` };
  checkFieldScope(doc, r, c, binding);
  const next = { ...previous, binding }; delete next.text; delete next.excelValue;
  next.numFmt = field.numberFormat ?? (previous.numFmt === 'General' ? undefined : previous.numFmt);
  doc.cells[keyOf(r, c)] = next;
}
export function setText(doc: TemplateDocument, r: number, c: number, text: string): void {
  checkBounds({ r, c, rows: 1, cols: 1 }, doc.rows, doc.cols);
  [r, c] = anchor(doc, r, c);
  const next: Cell = { ...doc.cells[keyOf(r, c)], text }; delete next.binding; delete next.excelValue;
  doc.cells[keyOf(r, c)] = next;
}
export function styleRange(doc: TemplateDocument, rect: Rect, patch: CellStyle): void {
  checkBounds(rect, doc.rows, doc.cols); checkStyle(patch);
  const anchors = new Set<string>();
  eachCell(rect, (r, c) => { const [rr, cc] = anchor(doc, r, c); anchors.add(keyOf(rr, cc)); });
  for (const key of anchors) {
    const cell = doc.cells[key] ?? {};
    doc.cells[key] = { ...cell, style: { ...cell.style, ...copy(patch) }, ...(cell.excelStyle ? { styleEdits: { ...cell.styleEdits, ...copy(patch) } } : {}) };
  }
}
export function mergeRange(doc: TemplateDocument, rect: Rect): void {
  checkBounds(rect, doc.rows, doc.cols);
  assert(rect.rows * rect.cols > 1, '请先选择多个单元格');
  assert(!doc.merges.some(m => intersects(m, rect)), '请先取消相交区域的合并');
  eachCell(rect, (r, c) => {
    if (r !== rect.r || c !== rect.c) assert(!hasValue(doc.cells[keyOf(r, c)]), '合并会丢失其他单元格内容，已拒绝');
  });
  doc.merges.push(copy(rect));
  // Whole-document semantic checks run before the transaction commits.
}
export function unmergeRange(doc: TemplateDocument, rect: Rect): void {
  doc.merges = doc.merges.filter(m => !intersects(m, rect));
}
export function clearRange(doc: TemplateDocument, rect: Rect): void {
  checkBounds(rect, doc.rows, doc.cols);
  assert(!doc.blocks.some(b => intersects(b.rect, rect)), '积木内单元格不能单独清除占位，请删除整个积木');
  for (const merge of doc.merges)
    if (intersects(merge, rect)) assert(contains(rect, merge), '请完整选中合并区域后清除');
  doc.merges = doc.merges.filter(m => !intersects(m, rect));
  eachCell(rect, (r, c) => { delete doc.cells[keyOf(r, c)]; });
}
export function removeBlock(doc: TemplateDocument, id: string): void {
  const block = doc.blocks.find(b => b.id === id); assert(block, '找不到积木');
  for (const [key, cell] of Object.entries(doc.cells)) if (cell.owner === id) delete doc.cells[key];
  doc.merges = doc.merges.filter(m => !intersects(m, block.rect));
  doc.blocks = doc.blocks.filter(b => b.id !== id);
}
export function moveBlock(doc: TemplateDocument, id: string, r: number, c: number): void {
  const found = doc.blocks.find(b => b.id === id); assert(found, '找不到积木');
  const block = copy(found);
  const cells = Object.entries(doc.cells).filter(([, cell]) => cell.owner === id).map(([key, cell]) => {
    const [rr, cc] = key.split(':').map(Number); const data = copy(cell); delete data.owner;
    return { ...data, r: rr - block.rect.r, c: cc - block.rect.c };
  });
  const definition: BlockDefinition = {
    schemaVersion: 1, id: block.definitionId, name: '移动积木',
    rows: block.rect.rows, cols: block.rect.cols, cells,
    merges: doc.merges.filter(m => contains(block.rect, m)).map(m => ({ ...m, r: m.r - block.rect.r, c: m.c - block.rect.c })),
    ...(block.repeat ? { repeat: block.repeat } : {}),
  };
  // Call only within transaction(): failed placement leaves original document intact.
  removeBlock(doc, id); placeBlock(doc, definition, r, c, id);
}
export function transaction(doc: TemplateDocument, change: (draft: TemplateDocument) => void): TemplateDocument {
  const draft = copy(doc); change(draft); draft.revision = doc.revision + 1;
  validateDocument(draft); return draft;
}
// Normalizes merged cells for BOTH Univer and ExcelJS. Only the anchor has content;
// font/fill/alignment are uniform, and borders only appear on the merged perimeter.
export function renderCells(doc: TemplateDocument): Record<string, Cell> {
  const result = copy(doc.cells);
  for (const m of doc.merges) {
    const master = result[keyOf(m.r, m.c)] ?? {};
    const base = copy(master.style ?? {}); const edges = base.borders ?? {};
    eachCell(m, (r, c) => {
      const borders: CellStyle['borders'] = {};
      if (r === m.r && edges.top) borders.top = edges.top;
      if (r === m.r + m.rows - 1 && edges.bottom) borders.bottom = edges.bottom;
      if (c === m.c && edges.left) borders.left = edges.left;
      if (c === m.c + m.cols - 1 && edges.right) borders.right = edges.right;
      const cell = result[keyOf(r, c)] ?? {};
      result[keyOf(r, c)] = { ...cell, style: { ...copy(base), borders: copy(borders) },
        ...(master.styleEdits ? { styleEdits: { ...copy(master.styleEdits),
          ...(master.styleEdits.borders ? { borders: copy(borders) } : {}) } } : {}) };
    });
  }
  return result;
}
export function a1(r: number, c: number): string {
  let letters = ''; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
  return `${letters}${r + 1}`;
}
export function metadata(doc: TemplateDocument) {
  return {
    schemaVersion: doc.schemaVersion, templateId: doc.id, revision: doc.revision,
    syntax: doc.syntax, sheetName: doc.sheetName, fields: copy(documentFields(doc)),
    bindings: Object.entries(doc.cells).filter(([, cell]) => cell.binding).map(([key, cell]) => {
      const [r, c] = key.split(':').map(Number);
      return { address: a1(r, c), ...cell.binding!, placeholder: displayText(cell, doc.syntax) };
    }),
    repeats: [...doc.blocks.filter(b => b.repeat).map(b => ({
      blockId: b.id, source: b.repeat!.source, ...repeatRect(b)!,
      coordinateBase: 0, axis: 'row', mode: 'insert', empty: b.repeat!.empty,
    })), ...(doc.repeatRegions ?? []).map(region => ({
      regionId: region.id, name: region.name, source: region.source, parentId: region.parentId,
      ...region.rect, coordinateBase: 0, axis: 'row', mode: 'insert', empty: region.empty,
    }))],
  };
}
