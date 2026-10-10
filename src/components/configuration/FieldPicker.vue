<script setup lang="ts">
import type { DataFieldDefinition } from '../../core/contracts/types.ts';
defineProps<{ modelValue: string | string[]; fields: DataFieldDefinition[]; multiple?: boolean; label: string; allowCreate?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string | string[]] }>();
</script>
<template>
  <label>{{ label }}
    <el-select :model-value="modelValue" :multiple="multiple" filterable :allow-create="allowCreate" default-first-option
      :aria-label="label" style="width:100%" @update:model-value="emit('update:modelValue', $event)">
      <el-option v-for="field in fields" :key="field.fieldId" :value="field.fieldId" :label="`${field.label} · ${field.type} · ${field.fieldId}`" />
      <el-option v-for="id in (Array.isArray(modelValue) ? modelValue : [modelValue]).filter(id => id && !fields.some(field => field.fieldId === id))"
        :key="id" :value="id" :label="`${id}（待核对）`" />
    </el-select>
  </label>
</template>
