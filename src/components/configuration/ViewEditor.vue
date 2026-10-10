<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { copy } from '../../domain/model.ts';
import type { DataViewDefinition, DataViewStep, Scalar } from '../../core/contracts/types.ts';
import { validateContract } from '../../core/contracts/validate.ts';
import { parseScalar, stepScope, type DesignerMetadata } from '../../core/designer/configuration.ts';
import FieldPicker from './FieldPicker.vue';

const props = defineProps<{ metadata?: DesignerMetadata; drafts: DataViewDefinition[]; initial?: DataViewDefinition; issue?: { viewId?: string; stepIndex?: number } }>();
const emit = defineEmits<{ save: [view: DataViewDefinition]; change: [view: DataViewDefinition | undefined, error: string]; trial: [] }>();
const definition = ref<DataViewDefinition>({ contractVersion: 2, viewId: 'view.new', label: '新数据视图', version: '0.1.0', sourceDatasetId: '', outputFields: [], steps: [] });
const error = ref(''), json = ref(''), editing = ref(-1), kind = ref<DataViewStep['op']>('filter');
const fieldId = ref(''), operator = ref('eq'), value = ref(''), by = ref<string[]>([]);
const sortRows = ref<Array<{ fieldId: string; direction: 'asc' | 'desc' }>>([]);
const mappings = ref<Array<{ sourceFieldId: string; outputFieldId: string }>>([]);
const aggregates = ref<Array<{ operation: 'count' | 'sum' | 'average' | 'min' | 'max'; fieldId: string; outputFieldId: string }>>([]);
const columnFieldId = ref(''), valueFieldId = ref(''), duplicatePolicy = ref<'reject' | 'sum' | 'average' | 'min' | 'max'>('reject');
const pivotRows = ref<Array<{ key: string; value: string; outputFieldId: string }>>([]);
const relationshipId = ref(''), functionKey = ref(''), parameters = ref<Record<string, string>>({});
const childRelation = ref(''), childView = ref(''), childAlias = ref('');
const scope = computed(() => props.metadata ? stepScope(props.metadata, definition.value.sourceDatasetId, definition.value.steps.slice(0, editing.value < 0 ? undefined : editing.value)) : { datasetId: '', fields: [] });
const outputScope = computed(() => props.metadata ? stepScope(props.metadata, definition.value.sourceDatasetId, definition.value.steps) : { datasetId: '', fields: [] });
const filterType = computed(() => scope.value.fields.find(field => field.fieldId === fieldId.value)?.type ?? 'text');
const outputOptions = computed(() => props.metadata?.catalog.fields ?? []);
const fn = computed(() => props.metadata?.functions.find(item => `${item.functionId}@${item.version}` === functionKey.value));
const functions = computed(() => props.metadata?.functions.filter(item => item.inputDatasetIds.includes(scope.value.datasetId)) ?? []);
const relations = computed(() => props.metadata?.project.relationships.filter(item => item.parentDatasetId === scope.value.datasetId && item.cardinality === 'one-to-one' && item.parentKey.every(id => scope.value.fields.some(field => field.fieldId === id))) ?? []);
const relation = computed(() => props.metadata?.project.relationships.find(item => item.relationshipId === relationshipId.value));
const lookupFields = computed(() => props.metadata?.project.datasets.find(item => item.datasetId === relation.value?.childDatasetId)?.fields ?? []);
const childRelations = computed(() => props.metadata?.project.relationships.filter(item => item.parentDatasetId === outputScope.value.datasetId && item.cardinality === 'one-to-many' && item.parentKey.every(id => definition.value.outputFields.includes(id))) ?? []);
const views = computed(() => [...new Map([...(props.metadata?.views ?? []), ...props.drafts].map(item => [item.viewId, item])).values()]);
const childViews = computed(() => views.value.filter(view => {
  const relation = props.metadata?.project.relationships.find(item => item.relationshipId === childRelation.value);
  return view.viewId !== definition.value.viewId && props.metadata && relation && stepScope(props.metadata, view.sourceDatasetId, view.steps).datasetId === relation.childDatasetId && relation.childForeignKey.every(id => view.outputFields.includes(id));
}));
const labels: Record<DataViewStep['op'], string> = { filter: '筛选条件', sort: '排序', project: '字段映射', group: '分组汇总', pivot: '行列转换', lookup: '关联查询', applyFunction: '公共函数' };
function stepSummary(step: DataViewStep) {
  const describe = (id: string) => props.metadata?.catalog.fields.find(field => field.fieldId === id)?.label ?? id;
  if (step.op === 'filter') return `${describe(step.fieldId)} · ${Array.isArray(step.value) ? step.value.join('、') : step.value ?? '为空'}`;
  if (step.op === 'sort') return step.by.map(item => `${describe(item.fieldId)} ${item.direction === 'asc' ? '升序' : '降序'}`).join('、');
  if (step.op === 'applyFunction') return `${props.metadata?.functions.find(item => item.functionId === step.functionId)?.label ?? step.functionId} · ${step.version}`;
  if (step.op === 'lookup') return `${step.relationshipId} · ${step.fields.length} 个字段`;
  if (step.op === 'project') return `${step.fields.length} 个字段映射`;
  return `${step.by.map(describe).join('、') || '整体汇总'} · ${step.op === 'group' ? step.aggregations.length + ' 项汇总' : Object.keys(step.columns).length + ' 个展开列'}`;
}
function act(run: () => void) { try { run(); error.value = ''; } catch (e) { error.value = e instanceof Error ? e.message : String(e); } }
function load(view?: DataViewDefinition) {
  definition.value = copy(view ?? { contractVersion: 2, viewId: 'view.new', label: '新数据视图', version: '0.1.0', sourceDatasetId: '', outputFields: [], steps: [] });
  editing.value = -1; error.value = '';
  kind.value = 'filter'; fieldId.value = ''; operator.value = 'eq'; value.value = ''; by.value = [];
  sortRows.value = []; mappings.value = []; aggregates.value = []; pivotRows.value = [];
  columnFieldId.value = ''; valueFieldId.value = ''; relationshipId.value = ''; functionKey.value = ''; parameters.value = {};
  childRelation.value = ''; childView.value = ''; childAlias.value = ''; duplicatePolicy.value = 'reject';
}
watch(() => props.metadata?.project.projectId, () => { load(props.initial ?? props.drafts[0] ?? props.metadata?.views[0]); }, { immediate: true });
watch(() => props.issue, issue => { if (issue?.viewId && issue.viewId === definition.value.viewId && issue.stepIndex !== undefined && definition.value.steps[issue.stepIndex]) edit(issue.stepIndex); });
watch(definition, () => {
  json.value = JSON.stringify(definition.value, null, 2);
  try { validateContract<DataViewDefinition>('dataView', definition.value); emit('change', copy(definition.value), ''); }
  catch (e) { emit('change', undefined, e instanceof Error ? e.message : String(e)); }
}, { deep: true, immediate: true });
watch(functionKey, () => { parameters.value = Object.fromEntries(Object.keys(fn.value?.parameterSchema ?? {}).map(key => [key, ''])); }, { flush: 'sync' });
function edit(index: number) {
  editing.value = index; const step = definition.value.steps[index]; kind.value = step.op;
  if (step.op === 'filter') { fieldId.value = step.fieldId; operator.value = step.operator; value.value = Array.isArray(step.value) ? step.value.join(',') : String(step.value ?? ''); }
  if (step.op === 'sort') sortRows.value = copy(step.by);
  if (step.op === 'project') mappings.value = copy(step.fields);
  if (step.op === 'group') { by.value = [...step.by]; aggregates.value = step.aggregations.map(item => ({ ...item, fieldId: item.fieldId ?? '' })); }
  if (step.op === 'pivot') { by.value = [...step.by]; columnFieldId.value = step.columnFieldId; valueFieldId.value = step.valueFieldId; duplicatePolicy.value = step.duplicatePolicy; pivotRows.value = Object.entries(step.columns).map(([key, item]) => ({ key, value: String(item.value), outputFieldId: item.outputFieldId })); }
  if (step.op === 'lookup') { relationshipId.value = step.relationshipId; mappings.value = step.fields.map(item => ({ sourceFieldId: item.childFieldId, outputFieldId: item.outputFieldId })); }
  if (step.op === 'applyFunction') { functionKey.value = `${step.functionId}@${step.version}`; parameters.value = Object.fromEntries(Object.entries(step.parameters).map(([key, item]) => [key, String(item)])); }
}
function move(index: number, delta: number) { const target = index + delta; if (target < 0 || target >= definition.value.steps.length) return; const steps = definition.value.steps; [steps[index], steps[target]] = [steps[target], steps[index]]; editing.value = -1; }
function applyStep() { act(() => {
  const selected = scope.value.fields.find(field => field.fieldId === fieldId.value);
  let step: DataViewStep;
  if (kind.value === 'filter') step = { op: 'filter', fieldId: fieldId.value, operator: operator.value as 'eq', ...(operator.value === 'isNull' ? {} : { value: operator.value === 'in' ? value.value.split(',').map(item => parseScalar(item.trim(), selected?.type ?? 'text')) : parseScalar(value.value, selected?.type ?? 'text') }) };
  else if (kind.value === 'sort') step = { op: 'sort', by: copy(sortRows.value) };
  else if (kind.value === 'project') step = { op: 'project', fields: copy(mappings.value) };
  else if (kind.value === 'group') step = { op: 'group', by: [...by.value], aggregations: aggregates.value.map(item => ({ operation: item.operation, outputFieldId: item.outputFieldId, ...(item.operation === 'count' ? {} : { fieldId: item.fieldId }) })) };
  else if (kind.value === 'pivot') {
    if (new Set(pivotRows.value.map(item => item.key)).size !== pivotRows.value.length) throw new Error('展开列名称不能重复');
    step = { op: 'pivot', by: [...by.value], columnFieldId: columnFieldId.value, valueFieldId: valueFieldId.value, duplicatePolicy: duplicatePolicy.value,
      columns: Object.fromEntries(pivotRows.value.map(item => [item.key, { value: parseScalar(item.value, scope.value.fields.find(field => field.fieldId === columnFieldId.value)?.type ?? 'text'), outputFieldId: item.outputFieldId }])) };
  } else if (kind.value === 'lookup') step = { op: 'lookup', relationshipId: relationshipId.value, fields: mappings.value.map(item => ({ childFieldId: item.sourceFieldId, outputFieldId: item.outputFieldId })) };
  else {
    if (!fn.value || !functions.value.includes(fn.value)) throw new Error('请选择接受当前数据集的已注册函数及版本');
    step = { op: 'applyFunction', functionId: fn.value.functionId, version: fn.value.version, parameters: Object.fromEntries(Object.entries(fn.value.parameterSchema).map(([key, type]) => [key, parseScalar(parameters.value[key] ?? '', type)])) as Record<string, Scalar> };
  }
  const candidate = copy(definition.value);
  if (editing.value < 0) candidate.steps.push(step); else candidate.steps[editing.value] = step;
  const validFields = stepScope(props.metadata!, candidate.sourceDatasetId, candidate.steps).fields.map(field => field.fieldId);
  if (!candidate.outputFields.length || candidate.outputFields.some(id => !validFields.includes(id))) candidate.outputFields = validFields;
  validateContract<DataViewDefinition>('dataView', candidate); definition.value = candidate; editing.value = -1;
}); }
function addChild() { act(() => {
  const relation = childRelations.value.find(item => item.relationshipId === childRelation.value);
  if (!relation || !childViews.value.some(view => view.viewId === childView.value) || !childAlias.value.trim()) throw new Error('请选择关系、子视图并填写集合名称');
  definition.value.children ??= [];
  definition.value.children.push({ relationshipId: relation.relationshipId, viewId: childView.value, as: childAlias.value.trim(), parentFieldIds: [...relation.parentKey], childFieldIds: [...relation.childForeignKey] });
}); }
function save() { act(() => { validateContract<DataViewDefinition>('dataView', definition.value); emit('save', copy(definition.value)); }); }
function applyJson() { act(() => { const parsed: unknown = JSON.parse(json.value); validateContract<DataViewDefinition>('dataView', parsed); load(parsed); }); }
defineExpose({ locate(view: DataViewDefinition, index?: number) { load(view); if (index !== undefined && view.steps[index]) edit(index); } });
</script>
<template>
  <section class="view-editor">
    <p v-if="!metadata" class="muted">请先打开项目服务，载入当前项目的字段和函数目录。</p>
    <div v-for="view in drafts" :key="`${view.viewId}:${view.version}`" class="region-card"><strong>{{ view.label }}</strong><small>{{ view.viewId }} · {{ view.version }}</small><button @click="load(view)">载入编辑</button></div>
    <details><summary>已登记及发布的视图</summary><div v-for="view in metadata?.views" :key="view.viewId" class="region-card"><strong>{{ view.label }}</strong><small>{{ view.viewId }} · {{ view.version }}</small><button @click="load(view)">基于此视图编辑</button></div></details>
    <button @click="load()">新建视图</button>
    <div class="two-cols"><label>视图 ID<input v-model="definition.viewId" /></label><label>视图名称<input v-model="definition.label" /></label></div>
    <label>视图版本<input v-model="definition.version" /></label>
    <label>来源数据集<select v-model="definition.sourceDatasetId" @change="definition.steps.length || (definition.outputFields = outputScope.fields.map(field => field.fieldId))"><option value="">请选择</option><option v-for="dataset in metadata?.project.datasets" :key="dataset.datasetId" :value="dataset.datasetId">{{ dataset.label }} · {{ dataset.datasetId }}</option></select></label>
    <FieldPicker v-model="definition.outputFields" :fields="outputScope.fields" multiple label="输出字段" />
    <div v-for="(step, index) in definition.steps" :key="index" class="region-card"><strong>步骤 {{ index + 1 }} · {{ labels[step.op] }}</strong><small>{{ stepSummary(step) }}</small><div class="button-row"><button @click="edit(index)">编辑步骤 {{ index + 1 }}</button><button :disabled="index === 0" @click="move(index, -1)">上移</button><button :disabled="index === definition.steps.length - 1" @click="move(index, 1)">下移</button><button @click="definition.steps.splice(index, 1); editing = -1">删除步骤</button></div></div>
    <h4>{{ editing < 0 ? '添加步骤' : `编辑步骤 ${editing + 1}` }}</h4>
    <label>步骤类型<select v-model="kind"><option v-for="(name, op) in labels" :key="op" :value="op">{{ name }}</option></select></label>
    <template v-if="kind === 'filter'"><FieldPicker v-model="fieldId" :fields="scope.fields" label="筛选字段" /><label>筛选条件<select v-model="operator" aria-label="筛选条件"><option v-for="op in ['eq','neq','gt','gte','lt','lte','in','contains','isNull']" :key="op" :value="op">{{ ({eq:'等于',neq:'不等于',gt:'大于',gte:'大于等于',lt:'小于',lte:'小于等于',in:'属于',contains:'包含',isNull:'为空'} as Record<string,string>)[op] }}</option></select></label><label v-if="operator !== 'isNull'">比较值（属于条件用逗号分隔）<select v-if="filterType === 'boolean' && operator !== 'in'" v-model="value"><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select><input v-else v-model="value" :type="operator === 'in' ? 'text' : filterType === 'number' ? 'number' : filterType === 'date' ? 'date' : 'text'" /></label></template>
    <template v-if="kind === 'sort'"><div v-for="(row, i) in sortRows" :key="i"><FieldPicker v-model="row.fieldId" :fields="scope.fields" :label="`排序字段 ${i+1}`" /><select v-model="row.direction" aria-label="排序方向"><option value="asc">升序</option><option value="desc">降序</option></select><button @click="sortRows.splice(i,1)">删除排序</button></div><button @click="sortRows.push({fieldId:'',direction:'asc'})">添加排序</button></template>
    <template v-if="kind === 'project' || kind === 'lookup'">
      <label v-if="kind === 'lookup'">关联关系<select v-model="relationshipId"><option value="">请选择</option><option v-for="item in relations" :key="item.relationshipId" :value="item.relationshipId">{{ item.relationshipId }} · {{ item.childDatasetId }}</option></select></label>
      <div v-for="(row, i) in mappings" :key="i"><FieldPicker v-model="row.sourceFieldId" :fields="kind === 'lookup' ? lookupFields : scope.fields" :label="`来源字段 ${i+1}`" /><FieldPicker v-model="row.outputFieldId" :fields="outputOptions" allow-create :label="`目标字段 ${i+1}`" /><button @click="mappings.splice(i,1)">删除映射</button></div><button @click="mappings.push({sourceFieldId:'',outputFieldId:''})">添加字段映射</button>
    </template>
    <template v-if="kind === 'group' || kind === 'pivot'"><FieldPicker v-model="by" :fields="scope.fields" multiple label="分组字段" /></template>
    <template v-if="kind === 'group'"><div v-for="(row, i) in aggregates" :key="i"><label>汇总方式<select v-model="row.operation"><option value="count">计数</option><option value="sum">合计</option><option value="average">平均值</option><option value="min">最小值</option><option value="max">最大值</option></select></label><FieldPicker v-if="row.operation !== 'count'" v-model="row.fieldId" :fields="scope.fields.filter(field => field.type === 'number')" :label="`汇总字段 ${i+1}`" /><FieldPicker v-model="row.outputFieldId" :fields="outputOptions" allow-create :label="`汇总输出 ${i+1}`" /><button @click="aggregates.splice(i,1)">删除汇总</button></div><button @click="aggregates.push({operation:'average',fieldId:'',outputFieldId:''})">添加汇总</button></template>
    <template v-if="kind === 'pivot'"><FieldPicker v-model="columnFieldId" :fields="scope.fields" label="展开依据字段" /><FieldPicker v-model="valueFieldId" :fields="scope.fields" label="展开数值字段" /><label>重复值处理<select v-model="duplicatePolicy"><option v-for="op in ['reject','sum','average','min','max']" :key="op" :value="op">{{ ({reject:'报错',sum:'合计',average:'平均值',min:'最小值',max:'最大值'} as Record<string,string>)[op] }}</option></select></label><div v-for="(row, i) in pivotRows" :key="i"><label>展开列名称<input v-model="row.key" /></label><label>匹配值<input v-model="row.value" /></label><FieldPicker v-model="row.outputFieldId" :fields="outputOptions" allow-create :label="`展开输出 ${i+1}`" /><button @click="pivotRows.splice(i,1)">删除展开列</button></div><button @click="pivotRows.push({key:'',value:'',outputFieldId:''})">添加展开列</button></template>
    <template v-if="kind === 'applyFunction'"><label>公共函数及版本<select v-model="functionKey"><option value="">请选择</option><option v-for="item in functions" :key="`${item.functionId}@${item.version}`" :value="`${item.functionId}@${item.version}`">{{ item.label }} · {{ item.version }}</option></select></label><label v-for="(type, key) in fn?.parameterSchema" :key="key">{{ key }} · {{ type }}<select v-if="type === 'boolean'" v-model="parameters[key]"><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select><input v-else v-model="parameters[key]" :type="type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'" /></label></template>
    <div class="button-row"><button :disabled="!metadata" @click="applyStep">{{ editing < 0 ? '追加步骤' : '更新步骤' }}</button><button v-if="editing >= 0" @click="editing = -1">结束步骤编辑</button></div>
    <details><summary>父子视图集合</summary><label>子集合关系<select v-model="childRelation"><option value="">请选择</option><option v-for="item in childRelations" :key="item.relationshipId" :value="item.relationshipId">{{ item.relationshipId }}</option></select></label><label>子视图<select v-model="childView" aria-label="子视图"><option value="">请选择</option><option v-for="item in childViews" :key="item.viewId" :value="item.viewId">{{ item.label }}</option></select></label><label>集合名称<input v-model="childAlias" /></label><button @click="addChild">添加子集合</button><div v-for="(child, i) in definition.children" :key="i">{{ child.as }} · {{ child.viewId }}<button @click="definition.children?.splice(i,1)">删除子集合</button></div></details>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="button-row"><button class="primary" @click="save">校验并保存视图草稿</button><button @click="emit('trial')">试算当前草稿</button></div>
    <details><summary>高级视图 JSON</summary><textarea v-model="json" rows="12" class="json-editor" /><button @click="applyJson">应用 JSON 到表单</button></details>
  </section>
</template>
