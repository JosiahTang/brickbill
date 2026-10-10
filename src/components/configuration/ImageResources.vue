<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TemplateImagePlacement, TemplatePackage } from '../../core/contracts/types.ts';
import type { Rect } from '../../domain/model.ts';
const props = defineProps<{ modelValue: string; template: TemplatePackage | null; selection: Rect; worksheetId: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; resources: [value: NonNullable<TemplatePackage['resources']>] }>();
const resourceId = ref(''), repeatOn = ref<'all' | 'first' | 'last'>('all'), error = ref('');
const placements = computed<TemplateImagePlacement[]>(() => { try { const value = JSON.parse(props.modelValue); return Array.isArray(value) ? value : []; } catch { return []; } });
const resources = computed(() => props.template?.resources ?? []);
function act(run: () => void) { try { run(); error.value = ''; } catch (e) { error.value = e instanceof Error ? e.message : String(e); } }
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''; if (!file) return;
  try {
    if (!['image/png','image/jpeg'].includes(file.type) || file.size < 1 || file.size > 5 * 1024 * 1024) throw new Error('请选择 5 MiB 以内的 PNG 或 JPEG 图片');
    const bitmap = await createImageBitmap(file); bitmap.close();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    const base64 = btoa(binary), existing = resources.value.find(item => item.mediaType === file.type && item.base64 === base64);
    if (existing) resourceId.value = existing.resourceId;
    else {
      const next = { resourceId: `image.${crypto.randomUUID().replaceAll('-','')}`, mediaType: file.type, base64 };
      emit('resources', [...resources.value, next]); resourceId.value = next.resourceId;
    }
    error.value = '';
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
function place() { act(() => {
  if (!resources.value.some(item => item.resourceId === resourceId.value)) throw new Error('请上传或选择图片资源');
  const saved = JSON.parse(props.modelValue || '[]') as TemplateImagePlacement[];
  saved.push({ imageId: `placement.${crypto.randomUUID().replaceAll('-','')}`, resourceId: resourceId.value, worksheetId: props.worksheetId, rect: { ...props.selection }, repeatOn: repeatOn.value });
  emit('update:modelValue', JSON.stringify(saved, null, 2));
}); }
function removePlacement(index: number) { act(() => { const saved = JSON.parse(props.modelValue) as TemplateImagePlacement[]; saved.splice(index, 1); emit('update:modelValue', JSON.stringify(saved, null, 2)); }); }
function removeResource(id: string) { act(() => {
  const referenced = [...(props.template?.pageDefinitions ?? [])].filter(page => page.imagePlacements?.some(item => item.resourceId === id));
  if (placements.value.some(item => item.resourceId === id) || referenced.length) throw new Error(`图片仍被引用，请先删除定位并保存页面。引用页面：${referenced.map(page => page.label).join('、') || '当前编辑页面'}`);
  emit('resources', resources.value.filter(item => item.resourceId !== id));
  if (resourceId.value === id) resourceId.value = '';
}); }
</script>
<template>
  <section class="image-resources">
    <h4>模板图片资源</h4><label>上传图片<input type="file" accept="image/png,image/jpeg" @change="upload" /></label>
    <div v-for="resource in resources" :key="resource.resourceId" class="region-card"><img :src="`data:${resource.mediaType};base64,${resource.base64}`" alt="模板图片缩略图" style="max-width:100px;max-height:70px" /><small>{{ resource.resourceId }}</small><div class="button-row"><button @click="resourceId = resource.resourceId">选用此图片</button><button @click="removeResource(resource.resourceId)">删除资源</button></div></div>
    <label>定位图片<select v-model="resourceId"><option value="">请选择</option><option v-for="resource in resources" :key="resource.resourceId" :value="resource.resourceId">{{ resource.resourceId }}</option></select></label>
    <label>图片显示页<select v-model="repeatOn"><option value="all">每页</option><option value="first">首页</option><option value="last">末页</option></select></label>
    <small>选区：第 {{ selection.r + 1 }} 行、第 {{ selection.c + 1 }} 列，{{ selection.rows }} 行 × {{ selection.cols }} 列。定位后保存页面区域。</small>
    <button @click="place">将图片定位到当前选区</button>
    <div v-for="(image, index) in placements" :key="image.imageId" class="region-card"><small>{{ image.resourceId }} · {{ image.repeatOn ?? 'all' }} · 行 {{ image.rect.r+1 }} 列 {{ image.rect.c+1 }}</small><button @click="removePlacement(index)">删除定位</button><button @click="act(() => { const saved = JSON.parse(modelValue) as TemplateImagePlacement[]; saved[index].rect = {...selection}; saved[index].worksheetId = worksheetId; saved[index].repeatOn = repeatOn; emit('update:modelValue', JSON.stringify(saved,null,2)); })">更新为当前选区及显示页</button></div>
    <p v-if="error" role="alert">{{ error }}</p>
    <details><summary>高级图片定位 JSON</summary><textarea :value="modelValue" rows="5" class="json-editor" @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" /></details>
  </section>
</template>
