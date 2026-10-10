<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DataFieldDefinition } from '../../core/contracts/types.ts';
import FieldPicker from './FieldPicker.vue';
const props = defineProps<{ modelValue: string; fields: DataFieldDefinition[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const error = ref('');
const rows = computed<Array<{ fieldId: string; direction: 'asc' | 'desc' }>>(() => { try { const value = JSON.parse(props.modelValue); return Array.isArray(value) ? value : []; } catch { return []; } });
function update(index: number, patch?: Partial<{ fieldId: string; direction: 'asc' | 'desc' }>) {
  try { const next = JSON.parse(props.modelValue); if (index < 0) next.push({ fieldId: '', direction: 'asc' }); else if (patch) Object.assign(next[index], patch); else next.splice(index, 1); emit('update:modelValue', JSON.stringify(next)); error.value = ''; }
  catch { error.value = '高级排序 JSON 无效，请修正后继续'; }
}
</script>
<template><div><h4>区域排序</h4><div v-for="(row, index) in rows" :key="index"><FieldPicker :model-value="row.fieldId" :fields="fields" :label="`区域排序字段 ${index+1}`" @update:model-value="update(index,{fieldId: $event as string})" /><label>区域排序方向<select :value="row.direction" @change="update(index,{direction:($event.target as HTMLSelectElement).value as 'asc' | 'desc'})"><option value="asc">升序</option><option value="desc">降序</option></select></label><button @click="update(index)">删除区域排序</button></div><button @click="update(-1)">添加区域排序</button><p v-if="error" role="alert">{{ error }}</p><details><summary>高级排序 JSON</summary><textarea :value="modelValue" rows="3" @input="emit('update:modelValue',($event.target as HTMLTextAreaElement).value)" /></details></div></template>
