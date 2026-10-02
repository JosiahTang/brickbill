import { copy, documentFields, type Field, type Format, type TemplateDocument } from './model.ts';

export function validPath(path: string): boolean {
  return typeof path === 'string' && path.length <= 180 && /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(path)
    && !path.split('.').some(p => ['__proto__', 'prototype', 'constructor'].includes(p));
}
export function validateFields(fields: Field[]): void {
  if (!Array.isArray(fields) || fields.length > 1000) throw new Error('字段字典最多支持 1000 个字段');
  const paths = new Set<string>(), ids = new Set<string>();
  for (const field of fields) {
    if (!field || !validPath(field.path)) throw new Error('字段路径须为英文属性路径，如 certificate.number；不允许特殊表达式');
    if (paths.has(field.path)) throw new Error(`字段路径重复：${field.path}`);
    paths.add(field.path);
    if (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 100) throw new Error('字段名称不能为空且不能超过 100 字');
    if (!['text', 'number', 'date', 'boolean'].includes(field.format)) throw new Error('不支持的字段类型');
    if (field.collection && (!validPath(field.collection) || !field.path.startsWith(field.collection + '.')))
      throw new Error(`字段 ${field.path} 必须位于所属集合 ${field.collection} 下`);
    if (field.numberFormat && (typeof field.numberFormat !== 'string' || field.numberFormat.length > 100)) throw new Error('数字格式过长');
    if (field.fieldId) {
      if (typeof field.fieldId !== 'string' || field.fieldId.length > 180 || ids.has(field.fieldId)) throw new Error(`稳定字段标识无效或重复：${field.fieldId}`);
      ids.add(field.fieldId);
    }
    if (field.unit && field.unit.length > 40) throw new Error(`字段 ${field.path} 的单位过长`);
    if (field.grain && field.grain.length > 120) throw new Error(`字段 ${field.path} 的数据粒度过长`);
    if (field.sourceKind && !['legacy', 'dataset', 'view', 'constant', 'parameter', 'page', 'derived'].includes(field.sourceKind)) throw new Error(`字段 ${field.path} 的来源类型不支持`);
    if (field.sourceKind === 'dataset' && (!field.datasetId || !field.sourceFieldId)) throw new Error(`数据集字段 ${field.path} 必须指定数据集和源字段`);
    if (field.sourceKind === 'view' && (!field.viewId || !field.sourceFieldId)) throw new Error(`视图字段 ${field.path} 必须指定视图和输出字段`);
    if (field.sourceKind === 'constant' && (!Object.hasOwn(field, 'constantValue') ||
      (field.format === 'number' && (typeof field.constantValue !== 'number' || !Number.isFinite(field.constantValue)))
      || (field.format === 'boolean' && typeof field.constantValue !== 'boolean'))) throw new Error(`常量字段 ${field.path} 必须明确配置与类型匹配的值`);
    if (field.sourceKind === 'parameter' && !field.parameterId) throw new Error(`参数字段 ${field.path} 必须指定参数标识`);
    if (field.sourceKind === 'page' && !field.pageField) throw new Error(`页面字段 ${field.path} 必须指定页面属性`);
    if (field.sourceKind === 'derived' && (!field.functionId || !field.functionVersion)) throw new Error(`派生字段 ${field.path} 必须引用已注册的版本化函数`);
  }
}
export function upsertField(doc: TemplateDocument, field: Field, oldPath?: string): void {
  const fields = copy(documentFields(doc));
  if (oldPath && oldPath !== field.path && fields.some(f => f.path === field.path)) throw new Error('字段路径重复');
  const index = oldPath ? fields.findIndex(f => f.path === oldPath) : -1;
  if (!oldPath && fields.some(f => f.path === field.path)) throw new Error('字段路径重复');
  if (oldPath && index < 0) throw new Error('字段不存在');
  if (index >= 0) fields[index] = { ...copy(field), fieldId: field.fieldId ?? fields[index].fieldId }; else fields.push(copy(field));
  validateFields(fields); doc.fields = fields;
  for (const cell of Object.values(doc.cells)) if (oldPath && cell.binding?.path === oldPath) {
    cell.binding = { path: field.path, format: field.format, ...(field.fieldId ? { fieldId: field.fieldId } : {}) };
    cell.numFmt = field.numberFormat;
  }
}
export function removeField(doc: TemplateDocument, path: string): void {
  if (Object.values(doc.cells).some(c => c.binding?.path === path)) throw new Error('该字段已绑定，请先解除相关单元格的绑定');
  doc.fields = copy(documentFields(doc).filter(f => f.path !== path));
}
/** Infer the union of all records, including nested collections and heterogeneous rows. */
export function inferFields(data: unknown): Field[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('示例数据必须是 JSON 对象');
  const found = new Map<string, Field>();
  let visited = 0;
  function walk(value: unknown, path: string, collection?: string, depth = 0) {
    if (++visited > 50000 || depth > 12) throw new Error('示例数据层级或数量过大');
    if (Array.isArray(value)) {
      if (!value.length) return;
      for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${path} 必须是对象数组；数值数组请改为 [{ "value": 1 }]`);
        walk(item, path, path, depth + 1);
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key, collection, depth + 1);
    } else if (path) {
      const format: Format = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean'
        : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) ? 'date' : 'text';
      const existing = found.get(path);
      if (!existing || (existing.example === '' && value != null)) found.set(path, {
        path, label: path.split('.').at(-1)!, format, collection, group: collection ?? '单值字段', example: value == null ? '' : String(value),
      });
      else if (value != null && existing.format !== format) existing.format = 'text';
    }
  }
  walk(data, '');
  const result = [...found.values()]; validateFields(result); return result;
}
export function addInferredFields(doc: TemplateDocument, data: unknown): number {
  const fields = copy(documentFields(doc)); let count = 0;
  for (const field of inferFields(data)) if (!fields.some(f => f.path === field.path)) { fields.push(field); count++; }
  validateFields(fields); doc.fields = fields; return count;
}
export function readPath(data: unknown, path: string): unknown {
  if (!path) return data;
  if (!validPath(path)) throw new Error(`非法数据路径：${path}`);
  let current = data;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
