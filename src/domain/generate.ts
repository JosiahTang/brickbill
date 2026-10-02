import { copy, documentFields, keyOf, type Cell, type Rect, type RepeatRegion, type TemplateDocument } from './model.ts';
import { a1, assert, contains, inside, validateDocument } from './operations.ts';
import { readPath } from './fields.ts';

interface Context { source: string; value: unknown; index: number; id: string; region: RepeatRegion }
export interface GeneratedResult { document: TemplateDocument; rowMap: number[]; warnings: string[]; recordCount: number }
/** Plan all rows first, then project values and merges. No writes ever target the source template. */
export function generateDocument(template: TemplateDocument, data: unknown): GeneratedResult {
  validateDocument(template);
  assert(data && typeof data === 'object' && !Array.isArray(data), '业务数据必须为 JSON 对象');
  const regions = [...(template.repeatRegions ?? []), ...template.blocks.filter(b => b.repeat).map(b => ({
    id: b.id, name: b.definitionId, source: b.repeat!.source, empty: b.repeat!.empty,
    rect: { r: b.rect.r + b.repeat!.rowOffset, c: b.rect.c, rows: b.repeat!.rowCount, cols: b.rect.cols },
  }))] as RepeatRegion[];
  const planned: { sourceRow: number; contexts: Context[] }[] = [];
  const warnings = new Set<string>();
  let serial = 0, recordCount = 0;
  function expand(start: number, end: number, parentId: string | undefined, contexts: Context[]) {
    const children = regions.filter(r => r.parentId === parentId).sort((a, b) => a.rect.r - b.rect.r);
    for (let r = start; r < end;) {
      const region = children.find(x => x.rect.r === r);
      if (!region) {
        planned.push({ sourceRow: r++, contexts });
        assert(planned.length <= 10000 && planned.length * template.cols <= 500000, '生成结果超过 10000 行或 500000 个单元格，请减少数据量');
        continue;
      }
      const parent = contexts.at(-1);
      const path = parent ? region.source.slice(parent.source.length + 1) : region.source;
      let records = readPath(parent ? parent.value : data, path);
      if (records == null) { warnings.add(`集合 ${region.source} 未提供，按空数组处理`); records = []; }
      assert(Array.isArray(records), `数据源 ${region.source} 必须是数组`);
      assert(records.length <= 10000, `集合 ${region.source} 超过 10000 条`);
      for (const record of records) assert(record && typeof record === 'object' && !Array.isArray(record), `${region.source} 中每条数据必须为对象`);
      recordCount += records.length;
      const instances = records.length ? records : region.empty === 'keep' ? [null] : [];
      for (let index = 0; index < instances.length; index++) expand(r, r + region.rect.rows, region.id,
        [...contexts, { region, source: region.source, value: instances[index], index, id: String(++serial) }]);
      r += region.rect.rows;
    }
  }
  expand(0, template.rows, undefined, []);
  const out = copy(template); out.cells = {}; out.merges = []; out.blocks = []; out.repeatRegions = [];
  out.rows = Math.max(1, planned.length); out.rowHeightPx = planned.length ? planned.map(p => template.rowHeightPx[p.sourceRow]) : [32];
  const rowMap = Array.from({ length: template.rows }, (_, r) => planned.findIndex(p => p.sourceRow === r));
  const rowsChanged = planned.length !== template.rows || planned.some((p, r) => p.sourceRow !== r);
  const rowCells = new Map<number, [number, Cell][]>();
  for (const [key, cell] of Object.entries(template.cells)) {
    const [r, c] = key.split(':').map(Number); const list = rowCells.get(r) ?? []; list.push([c, cell]); rowCells.set(r, list);
    if (rowsChanged && cell.excelValue && typeof cell.excelValue === 'object' &&
      ('formula' in cell.excelValue || 'sharedFormula' in cell.excelValue))
      throw new Error('模板含 Excel 公式，扩行会改变引用。请将计算结果作为业务字段传入后生成；保存模板仍会保留原公式。');
  }
  planned.forEach((row, r) => {
    for (const [c, original] of rowCells.get(row.sourceRow) ?? []) {
      const cell = copy(original); delete cell.owner;
      const duplicateOutside = row.contexts.some(ctx => ctx.index > 0 && !inside(ctx.region.rect, row.sourceRow, c));
      if (duplicateOutside) { delete cell.text; delete cell.binding; delete cell.excelValue; }
      if (cell.binding) {
        const field = documentFields(template).find(f => f.path === cell.binding!.path)!;
        const context = field.collection ? [...row.contexts].reverse().find(ctx => ctx.source === field.collection) : undefined;
        const value = readPath(context ? context.value : data, context ? field.path.slice(context.source.length + 1) : field.path);
        const address = a1(row.sourceRow, c);
        const format = cell.binding.format;
        delete cell.binding;
        if (value == null || value === '') {
          assert(!field.required || context?.value === null, `必填字段 ${field.label}（${field.path}，${address}）缺少数据`);
          if (context?.value !== null) warnings.add(`字段 ${field.path} 存在空值`);
          cell.text = ''; delete cell.excelValue;
        } else if (format === 'number') {
          assert(typeof value === 'number' && Number.isFinite(value), `字段 ${field.path} 必须是有效数字（${address}）`);
          cell.text = String(value); cell.excelValue = value;
        } else if (format === 'date') {
          assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) && !Number.isNaN(Date.parse(value)), `字段 ${field.path} 必须为 ISO 日期（${address}）`);
          assert(new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === value.slice(0, 10), `字段 ${field.path} 日期不存在（${address}）`);
          cell.text = value.slice(0, 10); cell.excelValue = { date: new Date(value).toISOString() };
        } else if (format === 'boolean') {
          assert(typeof value === 'boolean', `字段 ${field.path} 必须为布尔值（${address}）`);
          cell.text = value ? 'TRUE' : 'FALSE'; cell.excelValue = value;
        } else {
          assert(['string', 'number', 'boolean'].includes(typeof value), `字段 ${field.path} 应为单值，不能直接填入对象或数组`);
          cell.text = String(value); cell.excelValue = String(value);
        }
        cell.numFmt ??= field.numberFormat ?? (format === 'number' ? '#,##0.00' : format === 'date' ? 'yyyy-mm-dd' : '@');
      }
      out.cells[keyOf(r, c)] = cell;
    }
  });
  for (const merge of template.merges) {
    // A merged parent cell may span a nested collection; stretch it across all child rows.
    const owners = regions.filter(region => contains(region.rect, merge));
    const owner = owners.find(region => !owners.some(other => other.parentId === region.id));
    const groups = new Map<string, number[]>();
    planned.forEach((p, r) => {
      if (p.sourceRow < merge.r || p.sourceRow >= merge.r + merge.rows) return;
      const context = owner ? p.contexts.find(ctx => ctx.region.id === owner.id) : undefined;
      if (owner && !context) return;
      const id = context?.id ?? 'static'; const rows = groups.get(id) ?? []; rows.push(r); groups.set(id, rows);
    });
    for (const rows of groups.values()) {
      const rect: Rect = { ...merge, r: rows[0], rows: rows.at(-1)! - rows[0] + 1 };
      if (rect.rows * rect.cols <= 1) continue;
      out.merges.push(rect);
      for (const r of rows) for (let c = rect.c; c < rect.c + rect.cols; c++) if (r !== rect.r || c !== rect.c) {
        const cell = out.cells[keyOf(r, c)]; if (cell) { delete cell.text; delete cell.binding; delete cell.excelValue; }
      }
    }
  }
  validateDocument(out);
  return { document: out, rowMap, warnings: [...warnings], recordCount };
}
